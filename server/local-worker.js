require('dotenv').config();
const persistence = require('./persistence');
const createInventoryRouter = require('./inventory');
const createTikTokRouter = require('./tiktok');
const { createEditorService } = require('./editor');
const { clientCredentials, hasGoogleConfig } = require('./oauth-store');
const { google } = require('googleapis');

if (persistence.shared()) throw new Error('O worker local exige PERSISTENCE_DRIVER=local; use npm run worker para PostgreSQL.');
persistence.validateEnvironment();

async function startLocalWorker({ intervalMs = 30000 } = {}) {
  const inventory = createInventoryRouter({
    hasGoogleConfig,
    oauthClient: index => {
      const cfg = clientCredentials(index);
      return new google.auth.OAuth2(cfg.id, cfg.secret, cfg.redirectUri);
    }
  });
  const editor = createEditorService({ inventory: inventory.store, executeJobs: false });
  inventory.setEditor(editor);
  const tiktok = createTikTokRouter();
  let stopped = false;
  let timer;
  let active = Promise.resolve();
  let wake;

  async function tick() {
    if (stopped) return;
    try {
      await inventory.recoverComments();
      for (const task of [() => inventory.processPendingSchedules(), () => tiktok.processPendingSchedules(), () => editor.processNext()]) {
        if (stopped) break;
        await task();
      }
      console.log('[worker local] ciclo concluído.');
    } catch (error) {
      console.error('[worker local]', error.message || error);
    }
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
    editor.stop();
  }
  return { stop, running, editor };
}

if (require.main === module) {
  let worker;
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 115000);
    try { await worker?.stop(); }
    finally { clearTimeout(deadline); }
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  startLocalWorker().then(value => {
    worker = value;
    if (shuttingDown) return worker.stop();
  }).catch(error => {
    console.error(`[worker local] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { startLocalWorker };
