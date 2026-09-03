const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const { hasKey, isEncrypted, encryptToken, decryptToken, encryptAccountTokens, decryptAccountTokens } = require('./token-crypto');

const dataDir = path.join(__dirname, '..', 'data');
const storePath = process.env.OAUTH_ACCOUNTS_PATH ? path.resolve(process.env.OAUTH_ACCOUNTS_PATH) : path.join(dataDir, 'oauth-accounts.json');
const inventoryPath = process.env.INVENTORY_PATH ? path.resolve(process.env.INVENTORY_PATH) : path.join(dataDir, 'inventory.json');
const verifiedChannels = new Map();
const CHANNEL_VERIFICATION_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(storePath)) fs.writeFileSync(storePath, '[]', { encoding: 'utf8', mode: 0o600 });

function secureFile(filePath) { try { fs.chmodSync(filePath, 0o600); } catch { /* Windows may not implement POSIX modes. */ } }
function parseJson(filePath, fallback) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  secureFile(tmp); fs.renameSync(tmp, filePath); secureFile(filePath);
}

function readAccounts() { const value = parseJson(storePath, []); return Array.isArray(value) ? value : []; }
function writeAccounts(accounts) {
  writeJsonAtomic(storePath, accounts.map(encryptAccountTokens));
}

// Credenciais OAuth por cliente (client 1 = padrão; client 2 = projeto separado).
function clientCredentials(index) {
  if (Number(index) > 1) {
    return { id: process.env.YOUTUBE_CLIENT_ID_2, secret: process.env.YOUTUBE_CLIENT_SECRET_2, redirectUri: process.env.YOUTUBE_REDIRECT_URI_2 };
  }
  return { id: process.env.YOUTUBE_CLIENT_ID, secret: process.env.YOUTUBE_CLIENT_SECRET, redirectUri: process.env.YOUTUBE_REDIRECT_URI };
}
function hasGoogleConfig(index) {
  if (index) { const cfg = clientCredentials(index); return Boolean(cfg.id && cfg.secret && cfg.redirectUri); }
  return [1, 2].some(idx => hasGoogleConfig(idx));
}
function publicAccount(account) {
  if (!account) return null;
  const { refreshToken, accessToken, ...safe } = account;
  return { ...safe, connected: Boolean(refreshToken) && account.status === 'CONNECTED' };
}
function listAccounts() { return readAccounts().map(publicAccount); }

function getAccount(accountId) {
  if (!accountId) return null;
  const id = String(accountId);
  return readAccounts().find(account => account.accountId === id || account.channelId === id) || null;
}
// Funções escopadas por usuário -------------------------------------------------
function getAccountsByUserId(userId) {
  const id = String(userId);
  return readAccounts().filter(account => String(account.userId) === id).map(publicAccount);
}
function getAccountByUserAndId(userId, accountId) {
  if (!accountId || !userId) return null;
  const account = getAccount(accountId);
  if (!account || String(account.userId) !== String(userId)) return null;
  return decryptAccountTokens(account);
}
function getDefaultAccountForUser(userId) {
  const id = String(userId);
  const account = readAccounts().find(value => String(value.userId) === id && value.isDefault)
    || readAccounts().find(value => String(value.userId) === id);
  return account ? decryptAccountTokens(account) : null;
}
function assertAccountOwnership(userId, accountId) {
  const account = getAccount(accountId);
  if (!account) throw Object.assign(new Error('Conta não encontrada.'), { status: 404, code: 'ACCOUNT_NOT_FOUND' });
  if (String(account.userId) !== String(userId)) throw Object.assign(new Error('Esta conta não pertence a este usuário.'), { status: 403, code: 'ACCOUNT_NOT_OWNED' });
  return account;
}
// --------------------------------------------------------------------------------

function saveAccount(input) {
  if (!input?.channelId) throw new Error('channelId é obrigatório para salvar uma conta do YouTube.');
  if (!input.userId) throw new Error('userId é obrigatório para salvar uma conta do YouTube.');
  const accounts = readAccounts();
  const index = accounts.findIndex(account => account.channelId === String(input.channelId));
  if (index >= 0 && String(accounts[index].userId) !== String(input.userId)) {
    throw Object.assign(new Error('este canal já está conectado a outra conta'), { status: 409, code: 'CHANNEL_ALREADY_CONNECTED' });
  }
  const previous = index >= 0 ? accounts[index] : null;
  const credentialChanged = Boolean(previous && input.refreshToken && input.refreshToken !== previous.refreshToken);
  const now = new Date().toISOString();
  const userAccounts = accounts.filter(account => String(account.userId) === String(input.userId));
  const account = {
    accountId: previous?.accountId || (UUID_RE.test(String(input.accountId || '')) ? input.accountId : crypto.randomUUID()),
    userId: String(input.userId),
    googleAccountId: input.googleAccountId !== undefined ? input.googleAccountId : (previous?.googleAccountId ?? null),
    channelId: String(input.channelId),
    channelTitle: input.channelTitle || previous?.channelTitle || String(input.channelId),
    channelThumbnail: input.channelThumbnail !== undefined ? input.channelThumbnail : (previous?.channelThumbnail || ''),
    credentialSet: Number(input.credentialSet) > 1 ? 2 : (previous?.credentialSet || 1),
    refreshToken: input.refreshToken !== undefined ? (input.refreshToken || previous?.refreshToken || null) : (previous?.refreshToken || null),
    accessToken: input.accessToken !== undefined ? (input.accessToken || null) : (previous?.accessToken || null),
    tokenExpiry: input.tokenExpiry !== undefined ? (input.tokenExpiry || null) : (previous?.tokenExpiry || null),
    status: input.status || previous?.status || 'RECONNECT_REQUIRED',
    isDefault: input.isDefault !== undefined ? Boolean(input.isDefault) : (previous?.isDefault || userAccounts.length === 0),
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
  accounts.forEach(value => { if (String(value.userId) === account.userId) value.isDefault = false; });
  if (index >= 0) accounts[index] = account; else accounts.push(account);
  const ownAccounts = accounts.filter(value => String(value.userId) === account.userId);
  const defaultCount = ownAccounts.filter(value => value.isDefault).length;
  if (defaultCount === 0 && ownAccounts.length) ownAccounts[0].isDefault = true;
  if (credentialChanged) verifiedChannels.delete(account.accountId);
  writeAccounts(accounts);
  return publicAccount(account);
}
function setDefaultAccount(userId, accountId) {
  const accounts = readAccounts();
  const id = String(userId);
  const existing = getAccount(accountId);
  if (!existing) throw Object.assign(new Error('Conta não encontrada.'), { status: 404 });
  if (String(existing.userId) !== id) throw Object.assign(new Error('Este canal não pertence à sua conta.'), { status: 403 });
  const target = accounts.find(account => account.accountId === existing.accountId);
  accounts.forEach(account => { if (String(account.userId) === id) account.isDefault = account.accountId === target.accountId; });
  target.updatedAt = new Date().toISOString(); writeAccounts(accounts); return publicAccount(target);
}
function removeAccount(userId, accountId) {
  const accounts = readAccounts();
  const id = String(userId);
  const index = accounts.findIndex(account => account.accountId === String(accountId) && String(account.userId) === id);
  if (index < 0) return null;
  const [removed] = accounts.splice(index, 1);
  const remaining = accounts.filter(value => String(value.userId) === id);
  if (removed.isDefault && remaining.length) remaining[0].isDefault = true;
  verifiedChannels.delete(removed.accountId); writeAccounts(accounts); return removed;
}
function markAccountStatus(accountId, status) {
  const account = getAccount(accountId);
  if (!account) return null;
  return saveAccount({ ...account, status });
}
function getAccountAuthStatus(accountId) {
  if (!hasGoogleConfig()) return 'NOT_CONFIGURED';
  const account = accountId ? getAccount(accountId) : null;
  if (!account?.refreshToken) return 'RECONNECT_REQUIRED';
  return account.status || 'CONNECTED';
}
async function assertClientChannel(client, account) {
  const cached = verifiedChannels.get(account.accountId);
  if (cached?.refreshToken === account.refreshToken && Date.now() - cached.verifiedAt < CHANNEL_VERIFICATION_TTL_MS) return;
  const response = await google.youtube({ version: 'v3', auth: client }).channels.list({ part: ['id'], mine: true });
  const authenticatedChannelId = response.data.items?.[0]?.id || null;
  if (!authenticatedChannelId || authenticatedChannelId !== account.channelId) {
    markAccountStatus(account.accountId, 'RECONNECT_REQUIRED');
    throw Object.assign(new Error(`A credencial salva não pertence ao canal ${account.channelTitle}. Reconecte o canal antes de publicar.`), {
      code: 'ACCOUNT_CHANNEL_MISMATCH', status: 409, expectedChannelId: account.channelId, authenticatedChannelId
    });
  }
  verifiedChannels.set(account.accountId, { refreshToken: account.refreshToken, verifiedAt: Date.now() });
}
async function getAuthenticatedYouTubeClient(account) {
  const credentialSet = Number(account?.credentialSet) > 1 ? 2 : 1;
  if (!hasGoogleConfig(credentialSet)) throw Object.assign(new Error('Google OAuth não está configurado.'), { code: 'NOT_CONFIGURED', status: 503 });
  const decrypted = decryptAccountTokens(account);
  if (!decrypted?.refreshToken || decrypted.status !== 'CONNECTED') throw Object.assign(new Error('Este canal precisa ser reconectado.'), { code: 'AUTH_REQUIRED', status: 401 });
  const cfg = clientCredentials(credentialSet);
  const client = new google.auth.OAuth2(cfg.id, cfg.secret, cfg.redirectUri);
  client.setCredentials({ refresh_token: decrypted.refreshToken, access_token: decrypted.accessToken || undefined, expiry_date: decrypted.tokenExpiry || undefined });
  client.on('tokens', tokens => saveAccount({
    ...account,
    refreshToken: tokens.refresh_token || account.refreshToken,
    accessToken: tokens.access_token || account.accessToken,
    tokenExpiry: tokens.expiry_date || account.tokenExpiry,
    status: account.status
  }));
  try {
    await client.getAccessToken(); await assertClientChannel(client, decrypted); markAccountStatus(account.accountId, 'CONNECTED'); return client;
  } catch (error) {
    if (error?.response?.status === 401 || error?.code === 401 || error?.code === 'invalid_grant') markAccountStatus(account.accountId, 'RECONNECT_REQUIRED');
    throw error;
  }
}

// Migração de dados legados ------------------------------------------------
function backupLegacyData() {
  const backupDir = path.join(path.dirname(storePath), 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backupDir, { recursive: true });
  for (const filePath of [storePath, inventoryPath]) {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath)));
    }
  }
  console.log(`[migracao] Backup dos dados legados criado em ${backupDir}`);
  return backupDir;
}

function normalizeLegacyIds() {
  // Reescreve accountIds legados não-UUID para UUID e atualiza os vínculos no inventário.
  const raw = parseJson(storePath, []);
  const source = Array.isArray(raw) ? raw : [];
  const byChannel = new Map();
  const legacyIds = new Map();
  const now = new Date().toISOString();
  for (const old of source) {
    if (!old?.channelId) continue;
    const existing = byChannel.get(old.channelId);
    const accountId = UUID_RE.test(String(old.accountId || '')) ? old.accountId : (existing?.accountId || crypto.randomUUID());
    legacyIds.set(String(old.accountId || old.channelId), accountId);
    legacyIds.set(String(old.channelId), accountId);
    byChannel.set(old.channelId, {
      accountId,
      userId: old.userId ?? null,
      googleAccountId: old.googleAccountId ?? null,
      channelId: old.channelId,
      channelTitle: old.channelTitle || old.googleAccountId || old.channelId,
      channelThumbnail: old.channelThumbnail || '',
      credentialSet: Number(old.credentialSet) > 1 ? 2 : 1,
      refreshToken: old.refreshToken || existing?.refreshToken || null,
      accessToken: old.accessToken || existing?.accessToken || null,
      tokenExpiry: old.tokenExpiry || existing?.tokenExpiry || null,
      status: old.status || (old.refreshToken ? 'CONNECTED' : 'RECONNECT_REQUIRED'),
      isDefault: Boolean(old.isDefault || existing?.isDefault),
      createdAt: old.createdAt || existing?.createdAt || old.updatedAt || now,
      updatedAt: old.updatedAt || now
    });
  }
  const accounts = [...byChannel.values()];
  if (accounts.filter(account => account.isDefault).length > 1) {
    let found = false;
    accounts.forEach(account => { account.isDefault = account.isDefault && !found; if (account.isDefault) found = true; });
  }
  if (JSON.stringify(source) !== JSON.stringify(accounts)) writeJsonAtomic(storePath, accounts); else secureFile(storePath);
  if (legacyIds.size && fs.existsSync(inventoryPath)) {
    const items = parseJson(inventoryPath, []);
    let changed = false;
    if (Array.isArray(items)) {
      for (const item of items) {
        const mapped = legacyIds.get(String(item.accountId || '')) || (!item.accountId ? legacyIds.get(String(item.channelId || '')) : null);
        if (!mapped) continue;
        const account = accounts.find(value => value.accountId === mapped);
        if (item.accountId !== mapped || item.channelId !== account?.channelId) {
          item.accountId = mapped; item.channelId = account?.channelId || item.channelId || null; changed = true;
        }
      }
      if (changed) writeJsonAtomic(inventoryPath, items);
    }
  }
}

function runDataMigration() {
  const accounts = readAccounts();
  const hasOrphans = accounts.some(account => !account.userId);
  const hasPlaintextTokens = hasKey() && accounts.some(account =>
    (account.refreshToken && !isEncrypted(account.refreshToken)) || (account.accessToken && !isEncrypted(account.accessToken)));
  if (!hasOrphans && !hasPlaintextTokens) return; // idempotente: nada a migrar

  if (!hasKey()) {
    console.warn('[migracao] TOKEN_ENCRYPTION_KEY ausente: tokens legados permanecem no disco, mas ficam RECONNECT_REQUIRED até a chave existir.');
  }

  backupLegacyData();
  normalizeLegacyIds();

  // Remove contas órfãs (sem userId) e descarta os tokens junto.
  const after = readAccounts();
  const orphanChannelIds = new Set(after.filter(account => !account.userId).map(account => account.channelId));
  const orphanAccountIds = new Set(after.filter(account => !account.userId).map(account => account.accountId));
  const kept = after.filter(account => account.userId);
  writeJsonAtomic(storePath, kept.map(encryptAccountTokens));

  // Itens do inventário que apontavam para órfãos viram "Sem canal" (arquivos preservados).
  if (fs.existsSync(inventoryPath)) {
    const items = parseJson(inventoryPath, []);
    let changed = false;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.accountId && orphanAccountIds.has(String(item.accountId))) {
          item.accountId = null; item.channelId = null; changed = true;
        } else if (!item.accountId && item.channelId && orphanChannelIds.has(String(item.channelId))) {
          item.channelId = null; changed = true;
        }
      }
      if (changed) writeJsonAtomic(inventoryPath, items);
    }
  }
  console.log(`[migracao] Migração concluída: ${orphanAccountIds.size} canal(is) órfão(s) removido(s).`);
}

runDataMigration();

module.exports = {
  storePath, readAccounts, listAccounts, publicAccount,
  saveAccount, getAccount, getDefaultAccountForUser, getAccountByUserAndId,
  setDefaultAccount, removeAccount, markAccountStatus, getAccountAuthStatus,
  getAuthenticatedYouTubeClient, assertAccountOwnership, getAccountsByUserId
};