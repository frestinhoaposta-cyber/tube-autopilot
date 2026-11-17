// Documentos compartilhados; o modo local mantém os contratos de desenvolvimento.
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { encryptToken, decryptToken, isEncrypted } = require('./token-crypto');

const contexts = new AsyncLocalStorage();
const SCHEMA = 'tube_autopilot';
const DOCUMENTS_TABLE = `${SCHEMA}.autopilot_documents`;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const shared = () => process.env.PERSISTENCE_DRIVER === 'postgres';
let pool;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 10000 });
    pool.on('error', () => console.error('[persistência] conexão indisponível.'));
  }
  return pool;
}
function validateEnvironment() {
  if (process.env.NODE_ENV === 'production' && !shared()) throw new Error('Produção exige PERSISTENCE_DRIVER=postgres.');
  if (!shared()) return;
  for (const key of ['DATABASE_URL', 'TOKEN_ENCRYPTION_KEY', 'SESSION_SECRET', 'S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    if (!process.env[key]) throw new Error(`Configuração obrigatória ausente: ${key}.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY)) throw new Error('TOKEN_ENCRYPTION_KEY deve conter 64 caracteres hexadecimais.');
  if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET deve conter ao menos 32 caracteres.');
}
function documentName(file) {
  const aliases = { INVENTORY_PATH: 'inventory.json', OAUTH_ACCOUNTS_PATH: 'oauth-accounts.json', COMMENT_SETTINGS_PATH: 'comment-settings.json', METADATA_PATH: 'metadata-overrides.json', EDITOR_SETTINGS_PATH: 'editor-settings.json', EDITOR_JOBS_PATH: 'editor-jobs.json' };
  for (const [key, name] of Object.entries(aliases)) if (process.env[key] && path.resolve(process.env[key]) === path.resolve(file)) return name;
  return path.basename(file);
}
function context() {
  const value = contexts.getStore();
  if (!value || value.closed) throw new Error('Operação fora do contexto de persistência.');
  if (value.failed) throw value.failed;
  return value;
}
function encode(value) { return encryptToken(JSON.stringify(value)); }
function decode(payload) {
  if (!isEncrypted(payload)) throw new Error('Documento compartilhado não está criptografado.');
  const value = decryptToken(payload);
  if (value === null) throw new Error('Não foi possível descriptografar os dados. Verifique a chave original.');
  return JSON.parse(value);
}
function readDocument(file, fallback) {
  if (shared()) {
    const value = context().documents.get(documentName(file));
    if (value === undefined) throw new Error(`Documento não migrado: ${documentName(file)}.`);
    return structuredClone(value);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}
function writeDocument(file, value) {
  if (shared()) {
    const state = context();
    const name = documentName(file);
    state.documents.set(name, structuredClone(value));
    state.dirty.add(name);
    return value;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  return value;
}
async function loadState(database = getPool()) {
  const result = await database.query(`SELECT name, payload, revision FROM ${DOCUMENTS_TABLE}`);
  const documents = new Map();
  const revisions = new Map();
  for (const row of result.rows) { documents.set(row.name, decode(row.payload)); revisions.set(row.name, Number(row.revision)); }
  if (!documents.has('_migration.json')) throw new Error('Execute a migração explícita antes de iniciar os serviços.');
  return { documents, revisions, dirty: new Set(), closed: false, failed: null, queue: Promise.resolve(), database };
}
async function flush(state, database = getPool()) {
  if (!state.dirty.size) return;
  // Objetos são duráveis antes das referências; uploads órfãos são preservados para recuperação.
  await require('./media-store').persistMedia(state);
  const names = [...state.dirty].sort();
  const values = new Map(names.map(name => [name, state.documents.get(name)]));
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    for (const name of names) {
      const result = await client.query(`UPDATE ${DOCUMENTS_TABLE} SET payload=$1, revision=revision+1, updated_at=now() WHERE name=$2 AND revision=$3 RETURNING revision`, [encode(values.get(name)), name, state.revisions.get(name)]);
      if (result.rowCount !== 1) throw Object.assign(new Error('Os dados foram alterados por outro processo. Atualize a página e tente novamente.'), { status: 409, code: 'PERSISTENCE_CONFLICT' });
    }
    await client.query('COMMIT');
    for (const name of names) {
      state.revisions.set(name, state.revisions.get(name) + 1);
      if (state.documents.get(name) === values.get(name)) state.dirty.delete(name);
    }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); state.failed = error; throw error; }
  finally { client.release(); }
}
function checkpoint() {
  if (!shared()) return Promise.resolve();
  const state = context();
  state.queue = state.queue.then(async () => { while (state.dirty.size) await flush(state, state.database); }).catch(error => { state.failed = error; throw error; });
  return state.queue;
}
async function runInContext(callback, { media = true, database } = {}) {
  if (!shared()) { require('./metadata').refresh(); return callback(); }
  const state = await loadState(database);
  return contexts.run(state, async () => {
    try {
      if (media) await require('./media-store').hydrateMedia(state);
      require('./metadata').refresh();
      const result = await callback();
      await checkpoint();
      return result;
    } finally { state.closed = true; }
  });
}
// A resposta só termina depois da confirmação. Streaming de vídeo é somente leitura.
function createMiddleware(options = {}) { return function middleware(req, res, next) {
  if (!shared()) return next();
  runInContext(() => new Promise((resolve, reject) => {
    const originalEnd = res.end;
    let ended = false;
    res.end = function (...args) {
      if (ended) return res;
      ended = true;
      checkpoint().then(() => { originalEnd.apply(res, args); }, error => {
        if (!res.headersSent) {
          res.removeHeader('Content-Length');
          res.removeHeader('Location');
          res.statusCode = error.status || 503;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          originalEnd.call(res, JSON.stringify({ error: error.message }));
        } else res.destroy(error);
        reject(error);
      });
      return res;
    };
    res.once('finish', resolve);
    res.once('close', () => { if (!res.writableFinished) reject(new Error('Requisição encerrada antes da confirmação.')); });
    next();
  }), options).catch(error => {
    if (!res.headersSent && !res.writableEnded) res.status(error.status || 503).json({ error: 'Persistência indisponível. Tente novamente mais tarde.' });
    console.error('[persistência]', error.code || 'Falha na operação.');
  });
}; }
const middleware = createMiddleware();
async function close() { if (pool) { await pool.end(); pool = null; } }
async function readLatestDocument(file, fallback) {
  if (!shared()) return readDocument(file, fallback);
  const result = await getPool().query(`SELECT payload FROM ${DOCUMENTS_TABLE} WHERE name=$1`, [documentName(file)]);
  if (!result.rows.length) throw new Error('Documento compartilhado ausente.');
  return decode(result.rows[0].payload);
}
function categoryView(defaults) {
  if (!shared()) return defaults;
  const state = context();
  if (!state.categories) {
    state.categories = structuredClone(defaults);
    for (const [id, override] of Object.entries(state.documents.get('metadata-overrides.json') || {})) if (state.categories[id]) Object.assign(state.categories[id], override);
  }
  return state.categories;
}
module.exports = { shared, dataDir, schema: SCHEMA, documentsTable: DOCUMENTS_TABLE, getPool, validateEnvironment, readDocument, readLatestDocument, writeDocument, checkpoint, runInContext, middleware, createMiddleware, encode, decode, loadState, flush, close, categoryView };
