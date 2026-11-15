require('dotenv').config();
const persistence = require('./persistence');
const createInventoryRouter = require('./inventory');
const createTikTokRouter = require('./tiktok');
const { createEditorService } = require('./editor');
const { clientCredentials, hasGoogleConfig } = require('./oauth-store');
const { google } = require('googleapis');

// Lock de sessão: protege também contra sobreposição de versões durante deploy.
async function acquireLeadership(pool) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(74682020) AS acquired');
    if (!result.rows[0].acquired) { client.release(); return null; }
    return client;
  } catch (error) { client.release(error); throw error; }
}
async function startWorker({ pool = persistence.shared() ? persistence.getPool() : null, intervalMs = 30000 } = {}) {
  persistence.validateEnvironment();
  if (!persistence.shared()) throw new Error('O worker independente exige PERSISTENCE_DRIVER=postgres para evitar concorrência entre arquivos JSON locais.');
  const inventory = createInventoryRouter({ hasGoogleConfig, oauthClient: index => {
    const cfg = clientCredentials(index);
    return new google.auth.OAuth2(cfg.id, cfg.secret, cfg.redirectUri);
  } });
  const editor = createEditorService({ inventory: inventory.store, executeJobs: false });
  inventory.setEditor(editor);
  const tiktok = createTikTokRouter();
  let stopped = false;
  let leader = null;
  let initialized = false;
  let timer;
  let active = Promise.resolve();
  let wake;
  function leadershipLost() {
    // Sem conexão que sustenta o lock não é seguro continuar chamadas externas.
    console.error('[worker] liderança perdida; encerrando para preservar as tarefas.');
    editor.stop();
    if (require.main === module) process.exit(1);
    stopped = true;
  }
  async function tick() {
    if (stopped) return;
    try {
      if (pool && !leader) {
        leader = await acquireLeadership(pool);
        if (!leader) return;
        leader.on('error', leadershipLost);
        leader.on('end', leadershipLost);
      }
      if (!initialized) {
        await persistence.runInContext(async () => { await editor.start(); await inventory.recoverComments(); }, { database: pool || undefined });
        initialized = true;
      }
      for (const task of [() => inventory.processPendingSchedules(), () => tiktok.processPendingSchedules(), () => editor.processNext()]) {
        if (stopped) break;
        await persistence.runInContext(task, { database: pool || undefined });
      }
    } catch (error) { console.error('[worker]', error.code || 'Tarefa interrompida; será reavaliada no próximo ciclo.'); }
  }
  async function loop() {
    while (!stopped) {
      active = tick();
      await active;
      if (!stopped) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, intervalMs); });
    }
  }
  const running = loop();
  async function stop() {
    stopped = true;
    clearTimeout(timer);
    if (wake) wake();
    await active;
    await running;
    if (leader) {
      leader.removeListener('error', leadershipLost); leader.removeListener('end', leadershipLost);
      await leader.query('SELECT pg_advisory_unlock(74682020)').catch(() => {});
      leader.release(); leader = null;
    }
  }
  return { stop, running, editor };
}
if (require.main === module) {
  let worker;
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => { worker?.editor.stop(); process.exit(1); }, 115000);
    try { await worker?.stop(); await persistence.close(); }
    finally { clearTimeout(deadline); }
  }
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  startWorker().then(value => { worker = value; if (shuttingDown) return worker.stop(); }).catch(() => { console.error('[worker] configuração ou persistência inválida.'); process.exitCode = 1; });
}
module.exports = { startWorker, acquireLeadership };
