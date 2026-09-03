// Criptografia AES-256-GCM dos tokens OAuth em repouso.
// Chave vem de TOKEN_ENCRYPTION_KEY (hex de 64 chars = 32 bytes).
// Formato persistido: enc:gcm:base64(iv):base64(tag):base64(cipher)
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:gcm:';
const KEY = process.env.TOKEN_ENCRYPTION_KEY || '';

function hasKey() {
  return Boolean(KEY);
}

function normalizeKey() {
  if (!KEY) throw new Error('TOKEN_ENCRYPTION_KEY não está configurada.');
  let key = /^[0-9a-fA-F]{64}$/.test(KEY) ? Buffer.from(KEY, 'hex') : Buffer.from(KEY, 'utf8');
  if (key.length !== 32) key = crypto.createHash('sha256').update(String(KEY), 'utf8').digest();
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptToken(value) {
  if (!value) return null;
  const key = normalizeKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptToken(value) {
  if (!value) return null;
  const valueStr = String(value);
  if (!isEncrypted(valueStr)) return value;
  const parts = valueStr.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, cipherB64] = parts;
  try {
    const key = normalizeKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null; // chave trocada ou payload inválido
  }
}

function encryptAccountTokens(account) {
  if (!account) return account;
  if (!hasKey()) return account; // sem chave, preserva o estado em disco
  const clone = { ...account };
  if (clone.refreshToken && !isEncrypted(clone.refreshToken)) clone.refreshToken = encryptToken(clone.refreshToken);
  if (clone.accessToken && !isEncrypted(clone.accessToken)) clone.accessToken = encryptToken(clone.accessToken);
  return clone;
}

function decryptAccountTokens(account) {
  if (!account) return account;
  if (!hasKey()) {
    // Sem chave o servidor segue de pé, mas nada de token em uso: força reconexão.
    return { ...account, refreshToken: null, accessToken: null, status: 'RECONNECT_REQUIRED' };
  }
  return { ...account, refreshToken: decryptToken(account.refreshToken), accessToken: decryptToken(account.accessToken) };
}

module.exports = { hasKey, isEncrypted, encryptToken, decryptToken, encryptAccountTokens, decryptAccountTokens };