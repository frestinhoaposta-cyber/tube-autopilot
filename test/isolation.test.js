const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const projectRoot = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-isolation-'));
const accountsPath = path.join(tempRoot, 'oauth-accounts.json');
const inventoryPath = path.join(tempRoot, 'inventory.json');

fs.writeFileSync(accountsPath, '[]');
fs.writeFileSync(inventoryPath, '[]');

process.env.OAUTH_ACCOUNTS_PATH = accountsPath;
process.env.INVENTORY_PATH = inventoryPath;
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.YOUTUBE_CLIENT_ID = 'iso-client';
process.env.YOUTUBE_CLIENT_SECRET = 'iso-secret';
process.env.YOUTUBE_REDIRECT_URI = 'http://127.0.0.1/iso/callback';
process.env.SESSION_SECRET = 'iso-session-secret';
process.env.PORT = String(39100 + Math.floor(Math.random() * 600));

const users = require('../server/users');
users.isSupabaseConfigured = () => true;
const fetchUser = email => ({ id: 'user-' + email.replace(/[^a-z0-9]/gi, '').slice(0, 24), email });
users.signUp = async ({ email, password }) => {
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || !password || password.length < 6) {
    const e = new Error('Dados inválidos.'); e.status = 400; throw e;
  }
  return fetchUser(email);
};
users.signIn = async ({ email, password }) => {
  if (password !== 'senha-segura-123') {
    const e = new Error('E-mail ou senha inválidos.'); e.status = 401; throw e;
  }
  return fetchUser(email);
};

const store = require('../server/oauth-store');
const serverApp = require('../server/server.js');
const createInventoryRouter = require('../server/inventory');
const invRouter = createInventoryRouter({ oauthClient: () => null, hasGoogleConfig: () => true });

after(() => new Promise(resolve => serverApp.server.close(resolve)));

function base() { return `http://127.0.0.1:${process.env.PORT}`; }
function grabCookie(resp) {
  const raw = resp.headers.getSetCookie ? resp.headers.getSetCookie() : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
  const sid = raw.map(h => h.split(';')[0]).find(h => h.startsWith('connect.sid='));
  return sid || null;
}
function withCookie(jar) { return jar ? { Cookie: jar } : {}; }
function assertNoTokens(text) {
  assert.doesNotMatch(text, /"refreshToken"|"accessToken"|refresh-a|refresh-b|enc:gcm:/);
}
async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(`${base()}/api/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste não iniciou.');
}

let cookieA = null;
let cookieB = null;
let cookieC = null;
let idA = null;
let idB = null;
let accA = null;
let accB = null;
let itemA = null;
let itemB = null;
let itemOrphan = null;

before(async () => { await waitForServer(); });

test('10.1 — registro de usuários e sessões', async () => {
  const regA = await fetch(`${base()}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@exemplo.com', password: 'senha-segura-123' })
  });
  assert.equal(regA.status, 201);
  const userA = await regA.json();
  assert.ok(userA.user.id);
  assert.equal(userA.user.email, 'a@exemplo.com');
  [['refreshToken'], ['accessToken'], ['password']].forEach(([key]) => assert.ok(!(key in userA.user)));
  idA = userA.user.id;
  cookieA = grabCookie(regA);
  assert.ok(cookieA);

  const regB = await fetch(`${base()}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'b@exemplo.com', password: 'senha-segura-123' })
  });
  assert.equal(regB.status, 201);
  idB = (await regB.json()).user.id;
  cookieB = grabCookie(regB);
  assert.ok(cookieB);

  const regBad = await fetch(`${base()}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x', password: 'senha-segura-123' })
  });
  assert.equal(regBad.status, 400);
  const badCookie = grabCookie(regBad);
  const sessionBad = await fetch(`${base()}/api/auth/session`, { headers: withCookie(badCookie) });
  assert.equal(sessionBad.status, 401);

  const sessionNoCookie = await fetch(`${base()}/api/auth/session`);
  assert.equal(sessionNoCookie.status, 401);

  const sessionA = await fetch(`${base()}/api/auth/session`, { headers: withCookie(cookieA) });
  assert.equal(sessionA.status, 200);
  assert.equal((await sessionA.json()).user.email, 'a@exemplo.com');

  const loginWrong = await fetch(`${base()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@exemplo.com', password: 'senha-errada-999' })
  });
  assert.equal(loginWrong.status, 401);
  assert.equal((await loginWrong.json()).error, 'E-mail ou senha inválidos.');

  const loginRight = await fetch(`${base()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@exemplo.com', password: 'senha-segura-123' })
  });
  assert.equal(loginRight.status, 200);
  assert.equal((await loginRight.json()).user.email, 'a@exemplo.com');
});

test('10.1/10.2 — seeding e escopo das contas', async () => {
  accA = store.saveAccount({ userId: idA, channelId: 'CH_A_A', channelTitle: 'Canal A', refreshToken: 'refresh-a', accessToken: null, tokenExpiry: null, status: 'CONNECTED' });
  accB = store.saveAccount({ userId: idB, channelId: 'CH_B_B', channelTitle: 'Canal B', refreshToken: 'refresh-b', accessToken: null, tokenExpiry: null, status: 'CONNECTED' });
  assert.notEqual(accA.accountId, accB.accountId);

  const anonAccounts = await fetch(`${base()}/api/auth/accounts`);
  assert.equal(anonAccounts.status, 401);

  const accountsA = await fetch(`${base()}/api/auth/accounts`, { headers: withCookie(cookieA) });
  assert.equal(accountsA.status, 200);
  const accountsAText = await accountsA.text();
  const accountsAJson = JSON.parse(accountsAText);
  assert.equal(accountsAJson.length, 1);
  assert.equal(accountsAJson[0].channelId, 'CH_A_A');
  assert.equal(accountsAJson[0].accountId, accA.accountId);
  assert.doesNotMatch(accountsAText, /CH_B_B/);
  assertNoTokens(accountsAText);

  const accountsB = await fetch(`${base()}/api/auth/accounts`, { headers: withCookie(cookieB) });
  assert.equal(accountsB.status, 200);
  const accountsBText = await accountsB.text();
  const accountsBJson = JSON.parse(accountsBText);
  assert.equal(accountsBJson.length, 1);
  assert.equal(accountsBJson[0].channelId, 'CH_B_B');
  assertNoTokens(accountsBText);

  const anonStatus = await fetch(`${base()}/api/auth/status`);
  assert.equal(anonStatus.status, 401);

  const statusA = await fetch(`${base()}/api/auth/status`, { headers: withCookie(cookieA) });
  assert.equal(statusA.status, 200);
  const statusAText = await statusA.text();
  const statusAJson = JSON.parse(statusAText);
  assert.equal(statusAJson.connected, true);
  assert.equal(statusAJson.accounts.length, 1);
  assert.equal(statusAJson.defaultAccountId, accA.accountId);
  assertNoTokens(statusAText);

  const setDefaultB = await fetch(`${base()}/api/auth/accounts/${accB.accountId}/default`, {
    method: 'POST', headers: withCookie(cookieA)
  });
  assert.equal(setDefaultB.status, 403);
  assert.equal(store.getDefaultAccountForUser(idA).accountId, accA.accountId);

  const delB = await fetch(`${base()}/api/auth/accounts/${accB.accountId}`, {
    method: 'DELETE', headers: withCookie(cookieA)
  });
  assert.equal(delB.status, 403);
  assert.ok(store.getAccount(accB.accountId));

  const setDefaultMissing = await fetch(`${base()}/api/auth/accounts/nao-existe/default`, {
    method: 'POST', headers: withCookie(cookieA)
  });
  assert.equal(setDefaultMissing.status, 404);

  const setDefaultA = await fetch(`${base()}/api/auth/accounts/${accA.accountId}/default`, {
    method: 'POST', headers: withCookie(cookieA)
  });
  assert.equal(setDefaultA.status, 200);
  assert.equal((await setDefaultA.json()).isDefault, true);

  const statusA2 = await (await fetch(`${base()}/api/auth/status`, { headers: withCookie(cookieA) })).json();
  assert.equal(statusA2.defaultAccountId, accA.accountId);

  const diskAccounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  const diskA = diskAccounts.find(a => a.accountId === accA.accountId);
  assert.match(diskA.refreshToken, /^enc:gcm:/);
  assert.doesNotMatch(diskA.refreshToken, /refresh-a/);
  assert.doesNotMatch(fs.readFileSync(accountsPath, 'utf8'), /refresh-a|refresh-b/);
});

test('10.3 — inventário isolado e upload por usuário', async () => {
  const now = new Date().toISOString();
  itemA = { id: crypto.randomUUID(), userId: idA, accountId: accA.accountId, channelId: 'CH_A_A', contentType: 'LONG', status: 'AVAILABLE', title: 'Vídeo do A', filePath: 'arquivo-a.mp4', createdAt: now };
  itemB = { id: crypto.randomUUID(), userId: idB, accountId: accB.accountId, channelId: 'CH_B_B', contentType: 'LONG', status: 'AVAILABLE', title: 'Vídeo do B', filePath: 'arquivo-b.mp4', createdAt: now };
  itemOrphan = { id: crypto.randomUUID(), userId: null, accountId: null, channelId: null, contentType: 'LONG', status: 'AVAILABLE', title: 'Sem canal', filePath: 'arquivo-orphan.mp4', createdAt: now };
  fs.writeFileSync(inventoryPath, JSON.stringify([itemA, itemB, itemOrphan]));

  const anonInv = await fetch(`${base()}/api/inventory`);
  assert.equal(anonInv.status, 401);

  const invA = await fetch(`${base()}/api/inventory`, { headers: withCookie(cookieA) });
  assert.equal(invA.status, 200);
  const invAJson = await invA.json();
  const invATitles = invAJson.map(i => i.title);
  assert.ok(invATitles.includes('Vídeo do A'));
  assert.ok(invATitles.includes('Sem canal'));
  assert.ok(!invATitles.includes('Vídeo do B'));

  const invB = await fetch(`${base()}/api/inventory`, { headers: withCookie(cookieB) });
  const invBTitles = (await invB.json()).map(i => i.title);
  assert.ok(invBTitles.includes('Vídeo do B'));
  assert.ok(invBTitles.includes('Sem canal'));
  assert.ok(!invBTitles.includes('Vídeo do A'));

  const patchA = await fetch(`${base()}/api/inventory/${itemA.id}`, {
    method: 'PATCH',
    headers: { ...withCookie(cookieB), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'hack' })
  });
  assert.equal(patchA.status, 404);

  const delA = await fetch(`${base()}/api/inventory/${itemA.id}`, { method: 'DELETE', headers: withCookie(cookieB) });
  assert.equal(delA.status, 404);

  const uploadA = await fetch(`${base()}/api/inventory/${itemA.id}/upload`, { method: 'POST', headers: withCookie(cookieB) });
  assert.equal(uploadA.status, 404);

  const assignForeign = await fetch(`${base()}/api/inventory/actions/assign-account`, {
    method: 'POST',
    headers: { ...withCookie(cookieA), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [itemA.id], accountId: accB.accountId })
  });
  assert.equal(assignForeign.status, 403);

  const claim = await fetch(`${base()}/api/inventory/actions/assign-account`, {
    method: 'POST',
    headers: { ...withCookie(cookieA), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [itemOrphan.id], accountId: accA.accountId })
  });
  assert.equal(claim.status, 200);
  const claimJson = await claim.json();
  assert.equal(claimJson.updated, 1);
  const diskClaim = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')).find(i => i.id === itemOrphan.id);
  assert.equal(diskClaim.userId, idA);
  assert.equal(diskClaim.accountId, accA.accountId);

  const fdForeign = new FormData();
  fdForeign.append('accountId', accB.accountId);
  fdForeign.append('video', new Blob([Buffer.from([0, 0, 0])], { type: 'video/mp4' }), 'fake.mp4');
  const upForeign = await fetch(`${base()}/api/youtube/upload`, { method: 'POST', headers: withCookie(cookieA), body: fdForeign });
  assert.equal(upForeign.status, 403);

  const regC = await fetch(`${base()}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'c@exemplo.com', password: 'senha-segura-123' })
  });
  assert.equal(regC.status, 201);
  cookieC = grabCookie(regC);

  const fdNoAcc = new FormData();
  fdNoAcc.append('video', new Blob([Buffer.from([1, 1, 1])], { type: 'video/mp4' }), 'fake.mp4');
  const upNoAcc = await fetch(`${base()}/api/youtube/upload`, { method: 'POST', headers: withCookie(cookieC), body: fdNoAcc });
  assert.equal(upNoAcc.status, 400);
  assert.equal((await upNoAcc.json()).error, 'Selecione um canal conectado para o envio.');
});

test('10.4 — worker isola sem dono e usa userId+accountId; logout', async () => {
  const due = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const schedOwned = { id: crypto.randomUUID(), userId: idA, accountId: accA.accountId, channelId: 'CH_A_A', contentType: 'LONG', status: 'SCHEDULED', scheduledAt: due, filePath: 'missing-own.mp4', createdAt: due };
  const schedOrphan = { id: crypto.randomUUID(), userId: null, accountId: null, channelId: null, contentType: 'LONG', status: 'SCHEDULED', scheduledAt: due, filePath: null, createdAt: due };
  fs.writeFileSync(inventoryPath, JSON.stringify([schedOwned, schedOrphan]));

  await invRouter.processPendingSchedules();

  let disk = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const orphan = disk.find(i => i.id === schedOrphan.id);
  assert.equal(orphan.status, 'ERROR');
  assert.equal(orphan.error, 'OWNER_MIGRATION_REQUIRED');
  const owned = disk.find(i => i.id === schedOwned.id);
  assert.equal(owned.status, 'MISSING');
  assert.equal(owned.error, 'VIDEO_FILE_MISSING');

  const logout = await fetch(`${base()}/api/auth/logout`, { method: 'POST', headers: withCookie(cookieA) });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${base()}/api/auth/session`, { headers: withCookie(cookieA) })).status, 401);
  assert.equal((await fetch(`${base()}/api/auth/accounts`, { headers: withCookie(cookieA) })).status, 401);

  const relogin = await fetch(`${base()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@exemplo.com', password: 'senha-segura-123' })
  });
  assert.equal(relogin.status, 200);
  cookieA = grabCookie(relogin);
  const accountsA = await (await fetch(`${base()}/api/auth/accounts`, { headers: withCookie(cookieA) })).json();
  assert.equal(accountsA.length, 1);
  assert.equal(accountsA[0].channelId, 'CH_A_A');
  assert.ok(store.getAccount(accA.accountId));
});
