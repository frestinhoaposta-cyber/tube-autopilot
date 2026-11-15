// Executar explicitamente com o aplicativo antigo parado. Nunca modificar as origens.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const persistence = require('./persistence');
const { decryptToken, isEncrypted } = require('./token-crypto');
const { portableName, uploadFile, hashFile } = require('./media-store');
const defaults = {
  'inventory.json': [], 'oauth-accounts.json': [], 'metadata-overrides.json': {},
  'comment-settings.json': { enabled: false, text: '', categories: {}, channels: {} },
  'tiktok-inventory.json': [], 'tiktok-auth.json': null,
  'editor-settings.json': { enabled: false }, 'editor-jobs.json': []
};
const overrides = { 'inventory.json': 'INVENTORY_PATH', 'oauth-accounts.json': 'OAUTH_ACCOUNTS_PATH', 'metadata-overrides.json': 'METADATA_PATH', 'comment-settings.json': 'COMMENT_SETTINGS_PATH', 'editor-settings.json': 'EDITOR_SETTINGS_PATH', 'editor-jobs.json': 'EDITOR_JOBS_PATH' };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function readSource(source) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('Diretório de origem inválido.');
  const documents = new Map();
  const originals = {};
  const files = new Map();
  for (const [name, fallback] of Object.entries(defaults)) {
    const file = process.env[overrides[name]] ? path.resolve(process.env[overrides[name]]) : path.join(source, name);
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const value = bytes ? JSON.parse(bytes.toString('utf8')) : structuredClone(fallback);
    const valid = Array.isArray(fallback) ? Array.isArray(value) : (value === null ? fallback === null : typeof value === 'object' && !Array.isArray(value));
    if (!valid) throw new Error(`Formato inválido: ${name}.`);
    documents.set(name, value);
    originals[name] = { path: file, present: Boolean(bytes), sha256: bytes ? digest(bytes) : null, base64: bytes?.toString('base64') || null };
  }
  if (!Object.values(originals).some(value => value.present)) throw new Error('Nenhum documento foi encontrado na origem. Verifique LEGACY_DATA_DIR.');
  for (const name of ['inventory.json', 'oauth-accounts.json', 'tiktok-inventory.json', 'editor-jobs.json']) {
    const seen = new Set();
    for (const item of documents.get(name)) {
      if (!item || typeof item !== 'object') throw new Error(`Registro inválido: ${name}.`);
      const id = name === 'oauth-accounts.json' ? item.channelId : item.id;
      if (!id || seen.has(id)) throw new Error(`Identificador ausente ou duplicado: ${name}.`);
      seen.add(id);
    }
  }
  // Validar a chave original antes de copiar qualquer token cifrado.
  for (const account of documents.get('oauth-accounts.json')) for (const field of ['refreshToken', 'accessToken']) {
    if (isEncrypted(account[field]) && decryptToken(account[field]) === null) throw new Error('A chave original dos tokens é necessária para migrar as contas.');
  }
  const accountIds = new Map();
  for (const account of documents.get('oauth-accounts.json')) {
    const oldId = account.accountId || account.channelId;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(account.accountId || ''))) account.accountId = crypto.randomUUID();
    accountIds.set(String(oldId), account); accountIds.set(String(account.channelId), account);
  }
  const accountUuids = new Set();
  for (const account of documents.get('oauth-accounts.json')) {
    if (accountUuids.has(account.accountId)) throw new Error('accountId duplicado na origem.');
    accountUuids.add(account.accountId);
  }
  const addFile = (group, value) => {
    if (!value) return value;
    const name = portableName(value);
    const absolute = path.isAbsolute(value) ? value : path.join(group === 'edited' && process.env.EDITED_VIDEOS_DIR ? path.resolve(process.env.EDITED_VIDEOS_DIR) : path.join(source, group), value);
    if (!fs.existsSync(absolute)) throw new Error(`Arquivo referenciado não encontrado: ${group}/${name}. Restaure-o antes de migrar.`);
    const logical = `${group}/${name}`;
    if (files.has(logical) && files.get(logical) !== absolute) throw new Error(`Colisão de nomes: ${logical}.`);
    files.set(logical, absolute);
    return name;
  };
  for (const item of documents.get('inventory.json')) {
    const account = accountIds.get(String(item.accountId || item.channelId || ''));
    if (account?.userId && item.userId && String(account.userId) !== String(item.userId)) throw new Error('O dono do vídeo diverge do dono do canal. Corrija a origem antes de migrar.');
    if (account) { item.accountId = account.accountId; item.channelId = account.channelId; }
    item.filePath = addFile('videos', item.filePath);
    item.editedFilePath = addFile('edited', item.editedFilePath);
  }
  for (const item of documents.get('tiktok-inventory.json')) item.storedName = addFile('tiktok-videos', item.storedName);
  for (const job of documents.get('editor-jobs.json')) {
    job.sourceFile = addFile('videos', job.sourceFile);
    if (job.status === 'DONE') job.outputFile = addFile('edited', job.outputFile);
  }
  // Preservar também vídeos sem referência no inventário, sem apagar ou reorganizar a origem.
  const referenced = new Set(snapshotPaths(files));
  function archiveDirectory(directory, prefix) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) archiveDirectory(file, `${prefix}/${entry.name}`);
      else if (entry.isFile() && !referenced.has(path.resolve(file))) files.set(`archive/${prefix}/${entry.name}`, file);
      else if (entry.isSymbolicLink()) throw new Error('Links simbólicos na origem exigem cópia para arquivos regulares antes da migração.');
    }
  }
  for (const group of ['videos', 'edited', 'tiktok-videos']) archiveDirectory(group === 'edited' && process.env.EDITED_VIDEOS_DIR ? path.resolve(process.env.EDITED_VIDEOS_DIR) : path.join(source, group), group);
  return { documents, originals, files };
}
function snapshotPaths(files) { return [...files.values()].map(value => path.resolve(value)); }
async function backupAndImport({ source, backupDir, database = persistence.getPool(), upload = uploadFile }) {
  const snapshot = readSource(source);
  const manifest = {};
  for (const [logical, file] of snapshot.files) manifest[logical] = { sha256: await hashFile(file), size: fs.statSync(file).size };
  const backup = { version: 1, createdAt: new Date().toISOString(), originals: snapshot.originals, documents: [...snapshot.documents], media: manifest };
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupFile = path.join(backupDir, `migracao-${crypto.randomUUID()}.enc`);
  const encrypted = persistence.encode(backup);
  fs.writeFileSync(backupFile, encrypted, { mode: 0o600, flag: 'wx' });
  // Conferir o backup antes de qualquer escrita remota.
  if (JSON.stringify(persistence.decode(fs.readFileSync(backupFile, 'utf8'))) !== JSON.stringify(backup)) throw new Error('Verificação do backup falhou.');
  fs.writeFileSync(`${backupFile}.sha256`, `${digest(encrypted)}\n`, { mode: 0o600, flag: 'wx' });
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(74682019)');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const existing = await client.query('SELECT name FROM autopilot_documents LIMIT 1');
    if (existing.rows.length) throw new Error('Destino já contém dados. A importação não sobrescreve dados existentes.');
    for (const [logical, file] of snapshot.files) {
      const entry = manifest[logical];
      entry.key = await upload(file, entry.sha256);
      if (await hashFile(file) !== entry.sha256) throw new Error('A origem mudou durante a migração. Mantenha o aplicativo antigo parado.');
    }
    snapshot.documents.set('_media.json', manifest);
    snapshot.documents.set('_migration.json', { version: 1, createdAt: backup.createdAt, backupSha256: digest(encrypted) });
    for (const entry of Object.values(snapshot.originals)) {
      const currentHash = fs.existsSync(entry.path) ? digest(fs.readFileSync(entry.path)) : null;
      if (currentHash !== entry.sha256) throw new Error('Um documento de origem mudou durante a migração. Mantenha os processos antigos parados.');
    }
    for (const [name, value] of snapshot.documents) await client.query('INSERT INTO autopilot_documents(name,payload) VALUES ($1,$2)', [name, persistence.encode(value)]);
    await client.query('COMMIT');
    return { backupFile, documents: snapshot.documents.size, videos: snapshot.files.size };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function main() {
  persistence.validateEnvironment();
  if (!persistence.shared()) throw new Error('A migração exige PERSISTENCE_DRIVER=postgres.');
  if (!process.argv.includes('--offline-confirmed')) throw new Error('Pare o aplicativo antigo e informe --offline-confirmed.');
  const source = path.resolve(process.env.LEGACY_DATA_DIR || path.join(__dirname, '..', 'data'));
  const backupDir = path.resolve(process.env.MIGRATION_BACKUP_DIR || path.join(source, 'backups', 'render'));
  const result = await backupAndImport({ source, backupDir });
  console.log(`Migração concluída: ${result.documents} documentos e ${result.videos} vídeos. Backup: ${result.backupFile}`);
}
if (require.main === module) main().catch(() => { console.error('Migração interrompida. Originais preservados; confira configuração, integridade e destino vazio.'); process.exitCode = 1; }).finally(() => persistence.close());
module.exports = { readSource, backupAndImport };
