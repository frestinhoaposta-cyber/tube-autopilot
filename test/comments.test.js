const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-comments-'));
const accountsPath = path.join(tempRoot, 'oauth-accounts.json');
const inventoryPath = path.join(tempRoot, 'inventory.json');
const settingsPath = path.join(tempRoot, 'comment-settings.json');

fs.writeFileSync(accountsPath, '[]');
fs.writeFileSync(inventoryPath, '[]');

process.env.OAUTH_ACCOUNTS_PATH = accountsPath;
process.env.INVENTORY_PATH = inventoryPath;
process.env.COMMENT_SETTINGS_PATH = settingsPath;
process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.YOUTUBE_CLIENT_ID = 'test-client';
process.env.YOUTUBE_CLIENT_SECRET = 'test-secret';
process.env.YOUTUBE_REDIRECT_URI = 'http://127.0.0.1/test/callback';
process.env.SESSION_SECRET = 'test-session';
process.env.PORT = String(39200 + Math.floor(Math.random() * 100));

const store = require('../server/oauth-store');
const { apiError, markPending, reevaluateComments, readSettings, saveSettings } = require('../server/comments');
const createInventoryRouter = require('../server/inventory');
const invRouter = createInventoryRouter({ oauthClient: () => null, hasGoogleConfig: () => true });

const accountUserId = 'user-comments-test';
const account = store.saveAccount({
  userId: accountUserId,
  channelId: 'CH_COMMENTS_TEST',
  channelTitle: 'Canal Teste Comentários',
  refreshToken: 'refresh-comments-test',
  accessToken: null,
  tokenExpiry: null,
  status: 'CONNECTED'
});

after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

// ── apiError ─────────────────────────────────────────────────────────────────

test('apiError mapeia commentsDisabled para COMMENTS_DISABLED permanente', () => {
  const err = new Error('forbidden');
  err.response = { data: { error: { errors: [{ reason: 'commentsDisabled' }] } } };
  const result = apiError(err);
  assert.equal(result.code, 'COMMENTS_DISABLED');
  assert.equal(result.permanent, true);
  assert.match(result.message, /comentários/i);
});

test('apiError mapeia videoNotFound para VIDEO_NOT_FOUND', () => {
  const err = new Error('not found');
  err.response = { data: { error: { errors: [{ reason: 'videoNotFound' }] } } };
  const result = apiError(err);
  assert.equal(result.code, 'VIDEO_NOT_FOUND');
  assert.equal(result.permanent, true);
});

test('apiError mapeia forbidden para OAUTH_PERMISSION', () => {
  const err = new Error('forbidden');
  err.response = { data: { error: { errors: [{ reason: 'forbidden' }] } } };
  const result = apiError(err);
  assert.equal(result.code, 'OAUTH_PERMISSION');
  assert.equal(result.permanent, true);
});

test('apiError mapeia insufficientPermissions para OAUTH_PERMISSION', () => {
  const err = new Error('insufficient');
  err.response = { data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } };
  const result = apiError(err);
  assert.equal(result.code, 'OAUTH_PERMISSION');
  assert.equal(result.permanent, true);
});

test('apiError retorna erro genérico sem modificar', () => {
  const err = new Error('erro de rede');
  err.code = 'ECONNRESET';
  const result = apiError(err);
  assert.equal(result, err);
  assert.equal(result.code, 'ECONNRESET');
  assert.equal(result.permanent, undefined);
});

// ── markPending ──────────────────────────────────────────────────────────────

test('markPending desabilita item sem conta (NO_ACCOUNT)', () => {
  const item = { id: 'no-account', status: 'PUBLISHED', youtubeVideoId: 'vid1', autoCommentEnabled: true };
  markPending(item);
  assert.equal(item.commentStatus, 'DISABLED');
  assert.equal(item.commentError, 'NO_ACCOUNT');
  assert.equal(item.autoCommentEnabled, false);
});

test('markPending desabilita item sem texto configurado', () => {
  saveSettings({ enabled: false, text: '', categories: {}, channels: {} });
  const item = {
    id: 'no-text', status: 'PUBLISHED', youtubeVideoId: 'vid2',
    userId: accountUserId, accountId: account.accountId
  };
  markPending(item);
  assert.equal(item.commentStatus, 'DISABLED');
  assert.equal(item.autoCommentEnabled, false);
});

test('markPending marca PENDING quando configuração global tem texto', () => {
  saveSettings({ enabled: true, text: 'Comente!', categories: {}, channels: {} });
  const item = {
    id: 'global-text', status: 'PUBLISHED', youtubeVideoId: 'vid3',
    userId: accountUserId, accountId: account.accountId
  };
  markPending(item);
  assert.equal(item.commentStatus, 'PENDING');
  assert.equal(item.autoCommentEnabled, true);
  assert.equal(item.commentText, 'Comente!');
  assert.equal(item.commentAttemptCount, 0);
  assert.equal(item.commentError, null);
});

test('markPending usa texto do item quando disponível (autoCommentEnabled default)', () => {
  saveSettings({ enabled: false, text: '', categories: {}, channels: {} });
  const item = {
    id: 'item-text', status: 'PUBLISHED', youtubeVideoId: 'vid4',
    userId: accountUserId, accountId: account.accountId,
    commentText: 'Comente aqui!'
  };
  markPending(item);
  assert.equal(item.commentStatus, 'PENDING');
  assert.equal(item.commentText, 'Comente aqui!');
  assert.equal(item.autoCommentEnabled, true);
});

test('markPending respeita autoCommentEnabled false quando item tem texto', () => {
  saveSettings({ enabled: true, text: 'Comente!', categories: {}, channels: {} });
  const item = {
    id: 'disabled-flag', status: 'PUBLISHED', youtubeVideoId: 'vid5',
    userId: accountUserId, accountId: account.accountId,
    commentText: 'Texto manual',
    autoCommentEnabled: false
  };
  markPending(item);
  assert.equal(item.commentStatus, 'DISABLED');
  assert.equal(item.autoCommentEnabled, false);
});

// ── resolveComment precedência (via markPending) ─────────────────────────────

test('configuração de canal prevalece sobre configuração global', () => {
  saveSettings({
    enabled: true, text: 'Global',
    categories: {},
    channels: { 'Canal Teste Comentários': { enabled: true, text: 'Canal específico' } }
  });
  const item = {
    id: 'channel-config', status: 'PUBLISHED', youtubeVideoId: 'vid6',
    userId: accountUserId, accountId: account.accountId
  };
  markPending(item);
  assert.equal(item.commentText, 'Canal específico');
  assert.equal(item.autoCommentEnabled, true);
});

test('categoria prevalece sobre configuração global quando não há canal', () => {
  saveSettings({
    enabled: true, text: 'Global',
    categories: { brainrot: { enabled: true, text: 'Comente brainrot!' } },
    channels: {}
  });
  const item = {
    id: 'cat-config', status: 'PUBLISHED', youtubeVideoId: 'vid7',
    userId: accountUserId, accountId: account.accountId,
    category: 'brainrot'
  };
  markPending(item);
  assert.equal(item.commentText, 'Comente brainrot!');
});

// ── reevaluateComments ───────────────────────────────────────────────────────

test('reevaluateComments reavalia DISABLED para PENDING quando configuração habilita', () => {
  saveSettings({ enabled: true, text: 'Reavaliado!', categories: {}, channels: {} });
  const items = [
    { id: 're1', status: 'PUBLISHED', youtubeVideoId: 'v1', commentStatus: 'DISABLED', commentError: 'NO_ACCOUNT',
      userId: accountUserId, accountId: account.accountId }
  ];
  const changed = reevaluateComments(items);
  assert.equal(changed, true);
  assert.equal(items[0].commentStatus, 'PENDING');
  assert.equal(items[0].commentError, null);
  assert.equal(items[0].commentText, 'Reavaliado!');
});

test('reevaluateComments mantém DISABLED quando continua sem texto', () => {
  saveSettings({ enabled: false, text: '', categories: {}, channels: {} });
  const items = [
    { id: 're2', status: 'PUBLISHED', youtubeVideoId: 'v2', commentStatus: 'DISABLED', commentError: 'NO_ACCOUNT',
      userId: accountUserId, accountId: account.accountId }
  ];
  const changed = reevaluateComments(items);
  assert.equal(changed, true);
  assert.equal(items[0].commentStatus, 'DISABLED');
  assert.equal(items[0].autoCommentEnabled, false);
});

test('reevaluateComments ignora itens sem youtubeVideoId', () => {
  saveSettings({ enabled: true, text: 'X', categories: {}, channels: {} });
  const items = [
    { id: 're3', status: 'PUBLISHED', commentStatus: 'DISABLED', userId: accountUserId, accountId: account.accountId }
  ];
  const changed = reevaluateComments(items);
  assert.equal(changed, false);
  assert.equal(items[0].commentStatus, 'DISABLED');
});

test('reevaluateComments ignora itens não PUBLISHED/SCHEDULED', () => {
  saveSettings({ enabled: true, text: 'X', categories: {}, channels: {} });
  const items = [
    { id: 're4', status: 'AVAILABLE', youtubeVideoId: 'v4', commentStatus: 'DISABLED',
      userId: accountUserId, accountId: account.accountId }
  ];
  const changed = reevaluateComments(items);
  assert.equal(changed, false);
  assert.equal(items[0].commentStatus, 'DISABLED');
});

test('reeevaluateComments reavalia AUTH_REQUIRED PENDING', () => {
  saveSettings({ enabled: true, text: 'Reauth!', categories: {}, channels: {} });
  const items = [
    { id: 're5', status: 'PUBLISHED', youtubeVideoId: 'v5', commentStatus: 'PENDING', commentError: 'AUTH_REQUIRED',
      userId: accountUserId, accountId: account.accountId }
  ];
  const changed = reevaluateComments(items);
  assert.equal(changed, true);
  assert.equal(items[0].commentStatus, 'PENDING');
  assert.equal(items[0].commentError, null);
});

// ── boot re-evaluation via startScheduler ────────────────────────────────────
// Usa um router próprio com hasGoogleConfig=false para que processComments
// retorne cedo e nenhuma chamada de rede seja feita durante o teste.

test('boot re-evaluation reavalia DISABLED em itens PUBLISHED no inventário', async () => {
  saveSettings({ enabled: true, text: 'Boot reavaliado!', categories: {}, channels: {} });
  const bootInventoryPath = path.join(tempRoot, 'inventory-boot.json');
  fs.writeFileSync(bootInventoryPath, '[]');
  const oldInventoryPath = process.env.INVENTORY_PATH;
  process.env.INVENTORY_PATH = bootInventoryPath;
  const bootRouter = createInventoryRouter({ oauthClient: () => null, hasGoogleConfig: () => false });

  const itemId = crypto.randomUUID();
  const now = new Date().toISOString();
  const item = {
    id: itemId, userId: accountUserId, accountId: account.accountId, channelId: 'CH_COMMENTS_TEST',
    contentType: 'LONG', status: 'PUBLISHED', youtubeVideoId: 'boot-vid',
    commentStatus: 'DISABLED', commentError: 'COMMENTS_DISABLED',
    autoCommentEnabled: false, commentAttemptCount: 0,
    filePath: 'boot-test.mp4', createdAt: now
  };
  fs.writeFileSync(bootInventoryPath, JSON.stringify([item]));

  bootRouter.startScheduler();

  // A escrita do inventário é serializada via writeQueue (assíncrona); aguarda
  // o boot reavaliar e persistir antes de ler o disco.
  let updated = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const disk = JSON.parse(fs.readFileSync(bootInventoryPath, 'utf8'));
    const found = disk.find(i => i.id === itemId);
    if (found && found.commentStatus === 'PENDING') { updated = found; break; }
  }
  assert.ok(updated, 'item não foi reavaliado para PENDING no boot');
  assert.equal(updated.commentText, 'Boot reavaliado!');
  assert.equal(updated.autoCommentEnabled, true);
  assert.notEqual(updated.commentError, 'COMMENTS_DISABLED');

  process.env.INVENTORY_PATH = oldInventoryPath;
});

// ── saveSettings/readSettings ────────────────────────────────────────────────

test('saveSettings e readSettings preservam configurações', () => {
  const config = {
    enabled: true, text: 'Meu comentário',
    categories: { brainrot: { enabled: true, text: 'Brainrot!' } },
    channels: { 'Canal X': { enabled: false, text: '' } }
  };
  saveSettings(config);
  const loaded = readSettings();
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.text, 'Meu comentário');
  assert.deepEqual(loaded.categories.brainrot, { enabled: true, text: 'Brainrot!' });
  assert.deepEqual(loaded.channels['Canal X'], { enabled: false, text: '' });
});
