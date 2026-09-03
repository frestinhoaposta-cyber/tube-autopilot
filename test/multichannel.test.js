const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-autopilot-test-'));
const accountsPath = path.join(tempRoot, 'oauth-accounts.json');
const inventoryPath = path.join(tempRoot, 'inventory.json');
const legacyAccounts = [
  { accountId: 'CHANNEL_A', userId: 'uid-alice', channelId: 'CHANNEL_A', googleAccountId: 'Conta A', refreshToken: 'refresh-a', status: 'CONNECTED', updatedAt: '2026-01-01T00:00:00.000Z' },
  { accountId: 'CHANNEL_B', userId: 'uid-bob', channelId: 'CHANNEL_B', googleAccountId: 'Conta B', refreshToken: 'refresh-b', status: 'CONNECTED', updatedAt: '2026-01-02T00:00:00.000Z' }
];
fs.writeFileSync(accountsPath, JSON.stringify(legacyAccounts));
fs.writeFileSync(inventoryPath, JSON.stringify([
  { id: 'item-a', userId: 'uid-alice', accountId: 'CHANNEL_A', channelId: 'CHANNEL_A', status: 'AVAILABLE' },
  { id: 'item-b', userId: 'uid-bob', accountId: 'CHANNEL_B', channelId: 'CHANNEL_B', status: 'AVAILABLE' }
]));
process.env.OAUTH_ACCOUNTS_PATH = accountsPath;
process.env.INVENTORY_PATH = inventoryPath;
process.env.YOUTUBE_CLIENT_ID = 'test-client';
process.env.YOUTUBE_CLIENT_SECRET = 'test-secret';
process.env.YOUTUBE_REDIRECT_URI = 'http://127.0.0.1/callback';
process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
const store = require('../server/oauth-store');

test('migra IDs legados para UUID, preserva o vínculo dos itens e o userId', () => {
  const accounts = store.listAccounts();
  assert.equal(accounts.length, 2);
  assert.match(accounts[0].accountId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(accounts[0].accountId, accounts[1].accountId);
  const items = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  assert.equal(items[0].accountId, accounts.find(a => a.channelId === 'CHANNEL_A').accountId);
  assert.equal(items[1].accountId, accounts.find(a => a.channelId === 'CHANNEL_B').accountId);
  assert.equal(items[0].channelId, 'CHANNEL_A');
  assert.equal(items[0].userId, 'uid-alice');
  assert.equal(items[1].userId, 'uid-bob');
});

test('não duplica channelId, preserva refresh token criptografado e nunca o serializa na API', () => {
  const before = store.readAccounts().find(a => a.channelId === 'CHANNEL_A');
  const saved = store.saveAccount({ userId: 'uid-alice', channelId: 'CHANNEL_A', channelTitle: 'Canal A atualizado', refreshToken: undefined, status: 'CONNECTED' });
  const after = store.readAccounts().find(a => a.channelId === 'CHANNEL_A');
  assert.equal(store.readAccounts().filter(a => a.channelId === 'CHANNEL_A').length, 1);
  assert.equal(after.accountId, before.accountId);
  assert.match(after.refreshToken, /^enc:gcm:/);
  assert.doesNotMatch(after.refreshToken, /refresh-a/);
  assert.equal(saved.refreshToken, undefined);
  assert.equal(saved.accessToken, undefined);
  assert.doesNotMatch(JSON.stringify(store.listAccounts()), /refresh-a|refresh-b|enc:gcm:/);
});

test('canal de outro dono é rejeitado com 409 e não altera a conta original', () => {
  const accountA = store.listAccounts().find(a => a.channelId === 'CHANNEL_A');
  assert.throws(
    () => store.saveAccount({ userId: 'uid-bob', channelId: 'CHANNEL_A', channelTitle: 'Tentativa de roubo', refreshToken: 'refresh-hack', status: 'CONNECTED' }),
    err => err.status === 409 && /outra conta/.test(err.message)
  );
  const disk = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  assert.equal(disk.filter(a => a.channelId === 'CHANNEL_A').length, 1);
  assert.equal(disk.find(a => a.channelId === 'CHANNEL_A').userId, 'uid-alice');
  assert.doesNotMatch(disk.find(a => a.channelId === 'CHANNEL_A').refreshToken, /refresh-hack/);
  assert.equal(store.listAccounts().filter(a => a.userId === 'uid-bob' && a.channelId === 'CHANNEL_A').length, 0);
});

test('credentialSet (2º cliente OAuth) é persistido e preservado na conta', () => {
  const created = store.saveAccount({ userId: 'uid-bob', channelId: 'CHANNEL_D', channelTitle: 'Canal D', credentialSet: 2, refreshToken: 'refresh-d', status: 'CONNECTED' });
  assert.equal(created.credentialSet, 2);
  assert.equal(store.listAccounts().find(a => a.channelId === 'CHANNEL_D').credentialSet, 2);
  const disk = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  assert.equal(disk.find(a => a.channelId === 'CHANNEL_D').credentialSet, 2);
  const updated = store.saveAccount({ userId: 'uid-bob', channelId: 'CHANNEL_D', channelTitle: 'Canal D atualizado', refreshToken: undefined, status: 'CONNECTED' });
  assert.equal(updated.credentialSet, 2);
  const legacyDefault = store.listAccounts().find(a => a.channelId === 'CHANNEL_A');
  assert.equal(legacyDefault.credentialSet, 1);
});

test('conta com credentialSet 2 exige o 2º cliente OAuth configurado', async () => {
  const accountD = store.getAccountByUserAndId('uid-bob', store.listAccounts().find(a => a.channelId === 'CHANNEL_D').accountId);
  await assert.rejects(
    () => store.getAuthenticatedYouTubeClient(accountD),
    err => err.code === 'NOT_CONFIGURED' && err.status === 503
  );
  process.env.YOUTUBE_CLIENT_ID_2 = 'client-2';
  process.env.YOUTUBE_CLIENT_SECRET_2 = 'secret-2';
  process.env.YOUTUBE_REDIRECT_URI_2 = 'http://127.0.0.1/callback-2';
  const noToken2 = store.saveAccount({ userId: 'uid-bob', channelId: 'CHANNEL_E', channelTitle: 'Sem token 2', credentialSet: 2, status: 'RECONNECT_REQUIRED' });
  await assert.rejects(
    () => store.getAuthenticatedYouTubeClient(noToken2),
    err => err.code === 'AUTH_REQUIRED' && err.status === 401
  );
});

test('canal padrão persiste por usuário, conta sem refresh token exige reconexão e posse é validada', () => {
  const accountA = store.listAccounts().find(a => a.channelId === 'CHANNEL_A');
  const accountB = store.listAccounts().find(a => a.channelId === 'CHANNEL_B');
  store.setDefaultAccount('uid-bob', accountB.accountId);
  assert.equal(store.getDefaultAccountForUser('uid-bob').accountId, accountB.accountId);
  const missing = store.saveAccount({ userId: 'uid-bob', channelId: 'CHANNEL_C', channelTitle: 'Sem token', status: 'RECONNECT_REQUIRED' });
  assert.equal(store.getAccountAuthStatus(missing.accountId), 'RECONNECT_REQUIRED');
  const disk = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  assert.equal(disk.find(a => a.channelId === 'CHANNEL_B').isDefault, true);

  assert.throws(() => store.assertAccountOwnership('uid-alice', accountB.accountId), err => err.status === 403);
  assert.doesNotThrow(() => store.assertAccountOwnership('uid-bob', accountB.accountId));
  assert.throws(() => store.assertAccountOwnership('uid-alice', 'nao-existe'), err => err.status === 404);
  assert.equal(store.getAccountByUserAndId('uid-alice', accountA.accountId).refreshToken, 'refresh-a');

  const accBytes = store.saveAccount({ userId: 'uid-bob', channelId: 'CHANNEL_B', channelTitle: 'Canal B atualizado', refreshToken: 'refresh-b2', status: 'CONNECTED' });
  assert.equal(accBytes.accountId, accountB.accountId);
});

async function waitForServer(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste não iniciou.');
}

test('rotas de conta exigem sessão (401) e /api/health responde', { timeout: 15000 }, async () => {
  const apiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-autopilot-api-'));
  const apiAccounts = path.join(apiRoot, 'accounts.json');
  const apiInventory = path.join(apiRoot, 'inventory.json');
  fs.writeFileSync(apiAccounts, JSON.stringify([
    { accountId: '11111111-1111-4111-8111-111111111111', userId: 'uid-x', channelId: 'CHANNEL_OK', channelTitle: 'Canal OK', refreshToken: 'secret-refresh', accessToken: 'secret-access', status: 'CONNECTED', isDefault: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  ]));
  fs.writeFileSync(apiInventory, JSON.stringify([]));
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), OAUTH_ACCOUNTS_PATH: apiAccounts, INVENTORY_PATH: apiInventory, YOUTUBE_CLIENT_ID: 'client-id', YOUTUBE_CLIENT_SECRET: 'client-secret', YOUTUBE_REDIRECT_URI: `http://127.0.0.1:${port}/api/auth/google/callback`, SESSION_SECRET: 'test-session-secret', TOKEN_ENCRYPTION_KEY: 'b'.repeat(64) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForServer(port);
    const accountsResponse = await fetch(`http://127.0.0.1:${port}/api/auth/accounts`);
    assert.equal(accountsResponse.status, 401);
    assert.doesNotMatch(await accountsResponse.text(), /secret-refresh|secret-access|refreshToken|accessToken/);
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
    assert.equal(statusResponse.status, 401);
    assert.doesNotMatch(await statusResponse.text(), /secret-refresh|secret-access|refreshToken|accessToken/);
    const inventoryResponse = await fetch(`http://127.0.0.1:${port}/api/inventory`);
    assert.equal(inventoryResponse.status, 401);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok, true);
  } finally {
    child.kill();
  }
});

test('migração remove contas órfãs, zera accountId dos itens e faz backup com tokens originais', { concurrency: false }, () => {
  const migRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-autopilot-mig-'));
  const migAccounts = path.join(migRoot, 'oauth-accounts.json');
  const migInventory = path.join(migRoot, 'inventory.json');
  fs.writeFileSync(migAccounts, JSON.stringify([
    { accountId: 'OLD_1', channelId: 'OLD_1', googleAccountId: 'Orfã 1', refreshToken: 'legacy-token', status: 'CONNECTED' }
  ]));
  fs.writeFileSync(migInventory, JSON.stringify([
    { id: 'it1', accountId: 'OLD_1', channelId: 'OLD_1', title: 'Vídeo do canal órfão', status: 'AVAILABLE' }
  ]));

  const originalOauth = process.env.OAUTH_ACCOUNTS_PATH;
  const originalInventory = process.env.INVENTORY_PATH;
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  delete require.cache[require.resolve('../server/oauth-store')];
  delete require.cache[require.resolve('../server/token-crypto')];
  process.env.OAUTH_ACCOUNTS_PATH = migAccounts;
  process.env.INVENTORY_PATH = migInventory;
  process.env.TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);

  const migStore = require('../server/oauth-store');

  assert.equal(migStore.listAccounts().length, 0);
  const items = JSON.parse(fs.readFileSync(migInventory, 'utf8'));
  assert.equal(items[0].accountId, null);
  assert.equal(items[0].channelId, null);

  const backupsRoot = path.join(migRoot, 'backups');
  const backups = fs.readdirSync(backupsRoot).filter(name => fs.existsSync(path.join(backupsRoot, name, 'oauth-accounts.json')));
  assert.ok(backups.length >= 1, 'deve existir backup');
  const backupAccounts = JSON.parse(fs.readFileSync(path.join(backupsRoot, backups[0], 'oauth-accounts.json'), 'utf8'));
  assert.equal(backupAccounts[0].refreshToken, 'legacy-token');

  process.env.OAUTH_ACCOUNTS_PATH = originalOauth;
  process.env.INVENTORY_PATH = originalInventory;
  process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  delete require.cache[require.resolve('../server/oauth-store')];
  delete require.cache[require.resolve('../server/token-crypto')];
});
