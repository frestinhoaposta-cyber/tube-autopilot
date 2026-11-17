const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-render-'));
process.env.PERSISTENCE_DRIVER = 'postgres';
process.env.DATA_DIR = path.join(root, 'cache');
process.env.TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
for (const key of ['INVENTORY_PATH', 'OAUTH_ACCOUNTS_PATH', 'COMMENT_SETTINGS_PATH', 'METADATA_PATH', 'EDITOR_SETTINGS_PATH', 'EDITOR_JOBS_PATH', 'EDITED_VIDEOS_DIR', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_CLIENT_ID_2', 'YOUTUBE_CLIENT_SECRET_2']) process.env[key] = '';
const persistence = require('../server/persistence');
const media = require('../server/media-store');
const { backupAndImport, readSource } = require('../server/migrate-shared');
const { exportBackup } = require('../server/backup-shared');
const { restoreBackup } = require('../server/restore-shared');
const { markPending, reconcileComment } = require('../server/comments');
const createInventoryRouter = require('../server/inventory');
const { acquireLeadership, startWorker } = require('../server/worker');
const { categoriesConfig } = require('../server/categories');
let sql;
const query = (...args) => args.length === 1 && /^CREATE (?:SCHEMA|TABLE)\b/.test(args[0]) ? sql.exec(args[0]).then(results => results.at(-1)) : sql.query(...args);
const database = { query, connect: async () => ({ query, release() {} }) };
const initial = {
  'inventory.json': [], 'oauth-accounts.json': [], 'metadata-overrides.json': {}, 'comment-settings.json': {},
  'tiktok-inventory.json': [], 'tiktok-auth.json': null, 'editor-settings.json': {}, 'editor-jobs.json': [],
  '_media.json': {}, '_migration.json': { version: 1 }
};
before(async () => { sql = new PGlite(); await sql.exec(fs.readFileSync(path.join(__dirname, '../server/schema.sql'), 'utf8')); });
beforeEach(async () => {
  await sql.query('TRUNCATE tube_autopilot.autopilot_documents');
  for (const [name, value] of Object.entries(initial)) await sql.query('INSERT INTO tube_autopilot.autopilot_documents(name,payload) VALUES($1,$2)', [name, persistence.encode(value)]);
});
after(async () => { await sql.close(); fs.rmSync(root, { recursive: true, force: true }); });
const scope = fn => persistence.runInContext(fn, { database, media: false });

test('schema.sql cria as tabelas apenas em tube_autopilot', async () => {
  const result = await sql.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_name IN ('autopilot_documents', 'autopilot_sessions') ORDER BY table_schema, table_name");
  assert.deepEqual(result.rows, [
    { table_schema: 'tube_autopilot', table_name: 'autopilot_documents' },
    { table_schema: 'tube_autopilot', table_name: 'autopilot_sessions' }
  ]);
  assert.equal(persistence.schema, 'tube_autopilot');
});

test('consultas compartilhadas não usam tabela sem schema', () => {
  for (const file of ['persistence.js', 'backup-shared.js', 'restore-shared.js', 'migrate-shared.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../server', file), 'utf8');
    assert.doesNotMatch(source, /\b(?:FROM|INTO|UPDATE)\s+autopilot_documents\b/i, file);
  }
});

test('PostgreSQL confirma documentos criptografados e outro contexto lê a alteração', async () => {
  await scope(async () => {
    persistence.writeDocument('oauth-accounts.json', [{ accountId: 'conta', refreshToken: 'segredo-de-teste' }]);
    await persistence.checkpoint();
  });
  const raw = (await sql.query('SELECT payload FROM tube_autopilot.autopilot_documents WHERE name=$1', ['oauth-accounts.json'])).rows[0].payload;
  assert.ok(!raw.includes('segredo-de-teste'));
  assert.match(raw, /^enc:gcm:/);
  await scope(() => assert.equal(persistence.readDocument('oauth-accounts.json', [])[0].accountId, 'conta'));
  assert.throws(() => persistence.readDocument('oauth-accounts.json', []), /fora do contexto/);
});

test('revisão obsoleta retorna conflito e a transação não perde nenhuma gravação vencedora', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const stale = scope(async () => {
    const old = persistence.readDocument('inventory.json', []);
    entered(); await gate;
    persistence.writeDocument('metadata-overrides.json', { brainrot: { description: 'não confirmar' } });
    persistence.writeDocument('comment-settings.json', { text: 'não confirmar' });
    old.push({ id: 'perdedor' });
    persistence.writeDocument('inventory.json', old);
  });
  await ready;
  await scope(() => persistence.writeDocument('inventory.json', [{ id: 'vencedor' }]));
  resume();
  await assert.rejects(stale, error => error.code === 'PERSISTENCE_CONFLICT');
  await scope(() => {
    assert.deepEqual(persistence.readDocument('inventory.json', []), [{ id: 'vencedor' }]);
    assert.deepEqual(persistence.readDocument('metadata-overrides.json', {}), {});
    assert.deepEqual(persistence.readDocument('comment-settings.json', {}), {});
  });
});

test('configurações de categorias não vazam entre contextos concorrentes', async () => {
  await scope(() => persistence.writeDocument('metadata-overrides.json', { brainrot: { description: 'primeira' } }));
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const first = scope(async () => { assert.equal(categoriesConfig.brainrot.description, 'primeira'); entered(); await gate; assert.equal(categoriesConfig.brainrot.description, 'primeira'); });
  await ready;
  await scope(() => persistence.writeDocument('metadata-overrides.json', { brainrot: { description: 'segunda' } }));
  await scope(() => assert.equal(categoriesConfig.brainrot.description, 'segunda'));
  release(); await first;
});

test('HTTP não responde sucesso quando o checkpoint falha', async () => {
  const failedDatabase = { query: database.query, connect: async () => ({ release() {}, query: async text => { if (text.startsWith('UPDATE')) throw new Error('Banco indisponível.'); return sql.query(text); } }) };
  const app = express();
  app.use(require('express-session')({ secret: 'segredo-somente-para-o-teste', resave: false, saveUninitialized: false }));
  app.use(persistence.createMiddleware({ database: failedDatabase, media: false }));
  app.post('/teste', (req, res) => { req.session.userId = 'teste'; persistence.writeDocument('metadata-overrides.json', { valor: true }); res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/teste`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('"ok":true'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

function sourceFixture(name) {
  const source = path.join(root, name);
  fs.mkdirSync(path.join(source, 'videos'), { recursive: true });
  fs.writeFileSync(path.join(source, 'videos', 'original.mp4'), 'conteúdo original');
  fs.writeFileSync(path.join(source, 'oauth-accounts.json'), JSON.stringify([{ accountId: 'legado', channelId: 'canal', userId: 'dono', refreshToken: 'token-original' }, { accountId: 'orfao', channelId: 'sem-dono', refreshToken: 'token-preservado' }]));
  fs.writeFileSync(path.join(source, 'inventory.json'), JSON.stringify([{ id: 'video', accountId: 'legado', userId: 'dono', filePath: 'original.mp4' }]));
  return source;
}

test('migração preserva originais, contas órfãs, vínculo por canal e backup verificável', async () => {
  await sql.query('TRUNCATE tube_autopilot.autopilot_documents');
  const source = sourceFixture('migracao');
  const original = fs.readFileSync(path.join(source, 'oauth-accounts.json'));
  const objects = new Map();
  const result = await backupAndImport({ source, backupDir: path.join(root, 'backups'), database, upload: async (file, hash) => { objects.set(hash, fs.readFileSync(file)); return `videos/sha256/${hash}`; } });
  assert.equal(result.videos, 1);
  assert.deepEqual(fs.readFileSync(path.join(source, 'oauth-accounts.json')), original);
  const backupBytes = fs.readFileSync(result.backupFile, 'utf8');
  assert.ok(!backupBytes.includes('token-original'));
  assert.equal(crypto.createHash('sha256').update(backupBytes).digest('hex'), fs.readFileSync(`${result.backupFile}.sha256`, 'utf8').trim());
  const backup = persistence.decode(backupBytes);
  assert.deepEqual(Buffer.from(backup.originals['oauth-accounts.json'].base64, 'base64'), original);
  await scope(() => {
    const accounts = persistence.readDocument('oauth-accounts.json', []);
    const item = persistence.readDocument('inventory.json', [])[0];
    assert.equal(accounts.length, 2);
    assert.equal(item.accountId, accounts[0].accountId);
    assert.equal(accounts[1].refreshToken, 'token-preservado');
    const publicAccounts = require('../server/oauth-store').getAccountsByUserId('dono');
    assert.doesNotMatch(JSON.stringify(publicAccounts), /refreshToken|accessToken|token-original|enc:gcm:/);
  });
  await assert.rejects(backupAndImport({ source, backupDir: path.join(root, 'backups'), database, upload: async () => { throw new Error('Não deveria enviar.'); } }), /já contém dados/);
  assert.equal(objects.size, 1);
});

test('sessão e estado OAuth sobrevivem à substituição do processo web', async () => {
  const session = require('express-session');
  const Store = require('connect-pg-simple')(session);
  const first = new Store({ pool: database, schemaName: persistence.schema, tableName: 'autopilot_sessions', pruneSessionInterval: false });
  const saved = { userId: 'usuario-persistido', cookie: { maxAge: 60000 }, googleOauth: { state: 'estado-da-tentativa', credentialSet: 2 } };
  await new Promise((resolve, reject) => first.set('sessao-teste', saved, error => error ? reject(error) : resolve()));
  first.close();
  const next = new Store({ pool: database, schemaName: persistence.schema, tableName: 'autopilot_sessions', pruneSessionInterval: false });
  try {
    const restored = await new Promise((resolve, reject) => next.get('sessao-teste', (error, value) => error ? reject(error) : resolve(value)));
    assert.equal(restored.userId, 'usuario-persistido');
    assert.equal(restored.googleOauth.state, 'estado-da-tentativa');
    assert.equal(restored.googleOauth.credentialSet, 2);
  } finally { next.close(); }
});

test('migração rejeita JSON inválido e chave incorreta sem substituir dados por listas vazias', () => {
  const source = sourceFixture('corrompido');
  fs.writeFileSync(path.join(source, 'inventory.json'), '{ inválido');
  assert.throws(() => readSource(source), SyntaxError);
  fs.writeFileSync(path.join(source, 'inventory.json'), '[]');
  fs.writeFileSync(path.join(source, 'oauth-accounts.json'), JSON.stringify([{ channelId: 'canal', refreshToken: 'enc:gcm:invalido' }]));
  assert.throws(() => readSource(source), /chave original/);
});

test('falha de upload reverte a migração e preserva backup e originais', async () => {
  await sql.query('TRUNCATE tube_autopilot.autopilot_documents');
  const source = sourceFixture('upload-interrompido');
  const original = fs.readFileSync(path.join(source, 'inventory.json'));
  const backupDir = path.join(root, 'backup-interrompido');
  await assert.rejects(backupAndImport({ source, backupDir, database, upload: async () => { throw new Error('Upload interrompido.'); } }), /Upload interrompido/);
  assert.equal((await query('SELECT name FROM tube_autopilot.autopilot_documents')).rows.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(source, 'inventory.json')), original);
  assert.equal(fs.readdirSync(backupDir).filter(name => name.endsWith('.enc')).length, 1);
});

test('backup de produção restaura em banco vazio e rejeita checksum adulterado', async () => {
  const file = path.join(root, 'export.enc');
  await scope(() => persistence.writeDocument('oauth-accounts.json', [{ channelId: 'canal', refreshToken: 'token-restaurado' }]));
  await exportBackup({ destination: file, database });
  await sql.query('TRUNCATE tube_autopilot.autopilot_documents');
  assert.equal(await restoreBackup({ file, database }), 10);
  await scope(() => assert.equal(persistence.readDocument('oauth-accounts.json', [])[0].refreshToken, 'token-restaurado'));
  fs.appendFileSync(file, 'adulterado');
  await assert.rejects(restoreBackup({ file, database }), /Checksum/);
});

test('vídeo é enviado antes da referência e recuperado após perda do cache', async () => {
  const file = media.localPath('videos', 'compartilhado.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'vídeo compartilhado');
  const objects = new Map();
  const state = { documents: new Map([['inventory.json', [{ id: 'v', filePath: 'compartilhado.mp4' }]], ['_media.json', {}]]), dirty: new Set() };
  await media.persistMedia(state, { upload: async (file, hash) => { objects.set(hash, fs.readFileSync(file)); return hash; } });
  assert.ok(state.dirty.has('_media.json'));
  fs.unlinkSync(file);
  await media.hydrateMedia(state, { download: async (entry, target) => { fs.writeFileSync(target, objects.get(entry.sha256)); } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'vídeo compartilhado');
  await assert.rejects(media.persistMedia({ documents: new Map([['inventory.json', [{ filePath: 'ausente.mp4' }]]]), dirty: new Set() }, { upload: async () => assert.fail('Não enviar arquivo ausente.') }), /ENOENT/);
});

test('reconciliação pagina e só aceita comentário do canal e texto da tentativa', async () => {
  const calls = [];
  const youtube = { commentThreads: { list: async request => {
    calls.push(request);
    if (!request.pageToken) return { data: { items: [{ id: 'alheio', snippet: { topLevelComment: { snippet: { authorChannelId: { value: 'outro' }, textOriginal: 'texto' } } } }], nextPageToken: 'pagina-2' } };
    return { data: { items: [{ id: 'thread', snippet: { topLevelComment: { id: 'comentario', snippet: { authorChannelId: { value: 'canal' }, textOriginal: 'texto' } } } }] } };
  } } };
  const item = { youtubeVideoId: 'video', channelId: 'canal', commentText: 'editado', commentAttemptText: 'texto', commentAttemptChannelId: 'canal', commentStatus: 'POSTING' };
  assert.equal(await reconcileComment({ item, youtube }), 'comentario');
  assert.equal(calls.length, 2);
  markPending(item);
  assert.equal(item.commentStatus, 'POSTING');
  item.commentStatus = 'REVIEW_REQUIRED'; markPending(item); assert.equal(item.commentStatus, 'REVIEW_REQUIRED');
});

test('download corrompido não substitui o vídeo e remove arquivo temporário', async () => {
  const { Readable } = require('node:stream');
  const file = path.join(root, 'download', 'seguro.mp4');
  const valid = Buffer.from('original');
  const entry = { key: 'teste', size: valid.length, sha256: crypto.createHash('sha256').update(valid).digest('hex') };
  const s3 = { send: async () => ({ Body: Readable.from([Buffer.from('alterado')]) }) };
  await assert.rejects(media.downloadFile(entry, file, s3), /Integridade/);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});

test('segundo worker não adquire liderança nem executa trabalho', async () => {
  let released = 0;
  const first = new EventEmitter(); first.query = async () => ({ rows: [{ acquired: true }] }); first.release = () => {};
  const second = { query: async () => ({ rows: [{ acquired: false }] }), release: () => { released++; } };
  const clients = [first, second];
  const pool = { connect: async () => clients.shift() };
  assert.equal(await acquireLeadership(pool), first);
  assert.equal(await acquireLeadership(pool), null);
  assert.equal(released, 1);
});

test('worker recusa JSON local para não executar gravações concorrentes inseguras', async () => {
  process.env.PERSISTENCE_DRIVER = 'local';
  try { await assert.rejects(startWorker(), /exige PERSISTENCE_DRIVER=postgres/); }
  finally { process.env.PERSISTENCE_DRIVER = 'postgres'; }
});

test('produção recusa fallback JSON em disco temporário', () => {
  const environment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.PERSISTENCE_DRIVER = 'local';
  try { assert.throws(() => persistence.validateEnvironment(), /Produção exige PERSISTENCE_DRIVER=postgres/); }
  finally {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
  }
});

test('worker independente publica estado agendado e encerra liberando liderança', async () => {
  for (const [key, value] of Object.entries({ DATABASE_URL: 'postgres://teste-local', SESSION_SECRET: 's'.repeat(32), S3_BUCKET: 'bucket-teste', S3_REGION: 'teste', AWS_ACCESS_KEY_ID: 'chave-teste', AWS_SECRET_ACCESS_KEY: 'segredo-teste' })) process.env[key] = value;
  await scope(() => persistence.writeDocument('inventory.json', [{ id: 'agendado', youtubeVideoId: 'ja-enviado', status: 'SCHEDULED', scheduledAt: '2020-01-01T00:00:00Z' }]));
  let unlocked = false;
  const pool = { query, connect: async () => {
    const client = new EventEmitter();
    client.release = () => {};
    client.query = async (...args) => { if (args[0].includes('pg_advisory_unlock')) unlocked = true; return query(...args); };
    return client;
  } };
  const worker = await startWorker({ pool, intervalMs: 10000 });
  try {
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await query('SELECT payload FROM tube_autopilot.autopilot_documents WHERE name=$1', ['inventory.json']);
      status = persistence.decode(result.rows[0].payload)[0].status;
      if (status === 'PUBLISHED') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status, 'PUBLISHED');
  } finally { await worker.stop(); }
  assert.equal(unlocked, true);
});

test('worker sem liderança permanece em espera sem ler filas nem executar comentários', async () => {
  let notify;
  const attempted = new Promise(resolve => { notify = resolve; });
  let released = 0;
  const pool = {
    query: async () => assert.fail('Worker em espera não pode carregar dados ou filas.'),
    connect: async () => ({
      query: async text => { assert.match(text, /pg_try_advisory_lock/); notify(); return { rows: [{ acquired: false }] }; },
      release: () => { released++; }
    })
  };
  const worker = await startWorker({ pool, intervalMs: 10000 });
  try { await attempted; }
  finally { await worker.stop(); }
  assert.equal(released, 1);
});

test('reinício depois de inserção aceita recupera POSTING e falha de transporte sem duplicar', async () => {
  const store = require('../server/oauth-store');
  const router = createInventoryRouter({ hasGoogleConfig: () => true, oauthClient: () => null });
  let account;
  await scope(() => { account = store.saveAccount({ userId: 'dono', channelId: 'canal', refreshToken: 'token', status: 'CONNECTED' }); });
  const item = { id: 'comentario-pendente', userId: 'dono', accountId: account.accountId, channelId: 'canal', youtubeVideoId: 'video', status: 'PUBLISHED', commentStatus: 'PENDING', commentText: 'texto congelado', autoCommentEnabled: true };
  await scope(() => persistence.writeDocument('inventory.json', [item]));
  let inserts = 0;
  const authenticate = async () => ({});
  await scope(() => router.processComments({ authenticate, reconcile: async () => null, post: async () => { inserts++; throw Object.assign(new Error('Conexão caiu depois de aceitar.'), { code: 'ECONNRESET' }); } }));
  await scope(() => assert.equal(persistence.readDocument('inventory.json', [])[0].commentStatus, 'RECONCILING'));
  // Novo contexto equivale ao worker depois de um reinício.
  await scope(() => router.processComments({ authenticate, reconcile: async () => 'comment-remoto', post: async () => assert.fail('Não pode reenviar.') }));
  await scope(() => {
    const saved = persistence.readDocument('inventory.json', [])[0];
    assert.equal(saved.commentStatus, 'POSTED'); assert.equal(saved.youtubeCommentId, 'comment-remoto');
  });
  assert.equal(inserts, 1);
  await scope(() => persistence.writeDocument('inventory.json', [{ ...item, commentStatus: 'POSTING', commentAttemptText: 'texto congelado' }]));
  await scope(() => router.processComments({ authenticate, reconcile: async () => 'comment-antes-do-reinicio', post: async () => assert.fail('Não pode reenviar POSTING.') }));
  await scope(() => assert.equal(persistence.readDocument('inventory.json', [])[0].commentStatus, 'POSTED'));
});

test('resultado não localizado fica em revisão; falha na listagem permanece em reconciliação', async () => {
  const store = require('../server/oauth-store');
  const router = createInventoryRouter({ hasGoogleConfig: () => true, oauthClient: () => null });
  let account;
  await scope(() => { account = store.saveAccount({ userId: 'dono', channelId: 'canal', refreshToken: 'token', status: 'CONNECTED' }); });
  await scope(() => persistence.writeDocument('inventory.json', [{ id: 'incerto', userId: 'dono', accountId: account.accountId, channelId: 'canal', youtubeVideoId: 'video', status: 'PUBLISHED', commentStatus: 'POSTING', commentText: 'texto' }]));
  const authenticate = async () => ({});
  await scope(() => router.processComments({ authenticate, reconcile: async () => null, post: async () => assert.fail('Não reenviar resultado incerto.') }));
  await scope(() => assert.equal(persistence.readDocument('inventory.json', [])[0].commentStatus, 'REVIEW_REQUIRED'));
  await scope(() => router.processComments({ authenticate, reconcile: async () => { throw new Error('Listagem indisponível.'); }, post: async () => assert.fail('Não reenviar na falha de listagem.') }));
  await scope(() => assert.equal(persistence.readDocument('inventory.json', [])[0].commentStatus, 'RECONCILING'));
});

test('comentário automático novo é persistido como POSTED e não é repetido no ciclo seguinte', async () => {
  const store = require('../server/oauth-store');
  const router = createInventoryRouter({ hasGoogleConfig: () => true, oauthClient: () => null });
  let account;
  await scope(() => { account = store.saveAccount({ userId: 'dono', channelId: 'canal', refreshToken: 'token', status: 'CONNECTED' }); });
  await scope(() => persistence.writeDocument('inventory.json', [{ id: 'automatico', userId: 'dono', accountId: account.accountId, channelId: 'canal', youtubeVideoId: 'video', status: 'PUBLISHED', commentStatus: 'PENDING', commentText: 'Texto automático', autoCommentEnabled: true }]));
  let posts = 0;
  const transport = { authenticate: async () => ({}), reconcile: async () => null, post: async ({ item }) => { assert.equal(item.commentText, 'Texto automático'); posts++; return 'comentario-confirmado'; } };
  await scope(() => router.processComments(transport));
  await scope(() => {
    const saved = persistence.readDocument('inventory.json', [])[0];
    assert.equal(saved.commentStatus, 'POSTED'); assert.equal(saved.youtubeCommentId, 'comentario-confirmado');
    assert.equal(saved.commentAttemptCount, 1); assert.ok(saved.commentPostedAt);
  });
  await scope(() => router.processComments(transport));
  assert.equal(posts, 1);
});

test('web aceita comentário na fila e impede reenfileirar tentativa incerta', async () => {
  const id = crypto.randomUUID();
  await scope(() => persistence.writeDocument('inventory.json', [{ id, userId: 'dono', youtubeVideoId: 'youtube', status: 'PUBLISHED', commentStatus: 'REVIEW_REQUIRED' }]));
  const app = express(); app.use(express.json());
  app.use(persistence.createMiddleware({ database, media: false }));
  app.use((req, res, next) => { req.session = { userId: 'dono' }; next(); });
  app.use(createInventoryRouter({ hasGoogleConfig: () => false, oauthClient: () => null }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/${id}/comment`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Não reenviar' }) });
    assert.equal(response.status, 409);
    await scope(() => persistence.writeDocument('inventory.json', [{ id, userId: 'dono', youtubeVideoId: 'youtube', status: 'PUBLISHED', commentStatus: 'DISABLED' }]));
    const queued = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Na fila' }) });
    assert.equal(queued.status, 202);
    assert.equal((await queued.json()).commentStatus, 'PENDING');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('exclusão em lote preserva o arquivo físico referenciado por outro canal', async () => {
  const first = crypto.randomUUID(); const second = crypto.randomUUID();
  const file = media.localPath('videos', 'arquivo-migrado.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'original compartilhado');
  const hash = await media.hashFile(file);
  await scope(() => {
    persistence.writeDocument('_media.json', { 'videos/arquivo-migrado.mp4': { key: `videos/sha256/${hash}`, sha256: hash, size: fs.statSync(file).size } });
    persistence.writeDocument('inventory.json', [
      { id: first, userId: 'dono', accountId: 'canal-1', filePath: 'arquivo-migrado.mp4', status: 'AVAILABLE' },
      { id: second, userId: 'dono', accountId: 'canal-2', filePath: 'arquivo-migrado.mp4', status: 'AVAILABLE' }
    ]);
  });
  const app = express(); app.use(express.json());
  app.use(persistence.createMiddleware({ database, media: false }));
  app.use((req, res, next) => { req.session = { userId: 'dono' }; next(); });
  app.use(createInventoryRouter({ hasGoogleConfig: () => false, oauthClient: () => null }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/actions/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [first] }) });
    assert.equal(response.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original compartilhado');
    await scope(() => assert.equal(persistence.readDocument('inventory.json', [])[0].id, second));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
