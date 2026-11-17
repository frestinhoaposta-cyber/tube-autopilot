require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const persistence = require('./persistence');

async function restoreBackup({ file, database = persistence.getPool() }) {
  const bytes = fs.readFileSync(file, 'utf8');
  const checksum = fs.readFileSync(`${file}.sha256`, 'utf8').trim();
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Checksum do backup inválido.');
  const backup = persistence.decode(bytes);
  if (backup.version !== 1 || !Array.isArray(backup.documents)) throw new Error('Formato do backup inválido.');
  const documents = new Map(backup.documents.map(value => Array.isArray(value) ? value : [value.name, value.value]));
  if (backup.media) {
    documents.set('_media.json', Object.fromEntries(Object.entries(backup.media).map(([name, entry]) => [name, { ...entry, key: `videos/sha256/${entry.sha256}` }])));
    documents.set('_migration.json', { version: 1, createdAt: backup.createdAt, restoredAt: new Date().toISOString() });
  }
  if (!documents.has('_migration.json') || !documents.has('oauth-accounts.json') || !documents.has('_media.json')) throw new Error('Backup incompleto.');
  // Confirmar os objetos antes de liberar o banco restaurado.
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  for (const entry of Object.values(documents.get('_media.json'))) {
    const head = await require('./media-store').getClient().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: entry.key }));
    if (Number(head.ContentLength) !== entry.size || head.Metadata?.sha256 !== entry.sha256) throw new Error('Um vídeo do backup está ausente ou divergente.');
  }
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(74682019)');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const existing = await client.query(`SELECT name FROM ${persistence.documentsTable} LIMIT 1`);
    if (existing.rows.length) throw new Error('Restauração exige banco vazio; use um banco separado para validar.');
    for (const [name, value] of documents) await client.query(`INSERT INTO ${persistence.documentsTable}(name,payload) VALUES ($1,$2)`, [name, persistence.encode(value)]);
    await client.query('COMMIT');
    return documents.size;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function main() {
  persistence.validateEnvironment();
  if (!persistence.shared() || !process.env.BACKUP_PATH || !process.argv.includes('--offline-confirmed')) throw new Error('Informe banco vazio, BACKUP_PATH e --offline-confirmed com os processos parados.');
  const count = await restoreBackup({ file: path.resolve(process.env.BACKUP_PATH) });
  console.log(`Restauração concluída: ${count} documentos.`);
}
if (require.main === module) main().catch(() => { console.error('Restauração interrompida. Verifique checksum, chave original, vídeos e banco vazio.'); process.exitCode = 1; }).finally(() => persistence.close());
module.exports = { restoreBackup };
