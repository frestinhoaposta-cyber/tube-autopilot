const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const { categoriesConfig, generateTitle, generateShortTitle, normalizeTitle, publicCategories, buildYoutubeSnippet, MAX_SHORTS_PER_DAY, SHORTS_DAILY_SLOTS } = require('./categories');
const { MAX_COMMENT_ATTEMPTS, readSettings, saveSettings, markPending, postComment, apiError } = require('./comments');
const { getAccount, getAccountByUserAndId, getAuthenticatedYouTubeClient, getAccountAuthStatus, assertAccountOwnership } = require('./oauth-store');

module.exports = function createInventoryRouter({ oauthClient, hasGoogleConfig }) {
  const router = express.Router();
  const dataDir = path.join(__dirname, '..', 'data');
  const videosDir = path.join(dataDir, 'videos');
  const dbPath = process.env.INVENTORY_PATH ? path.resolve(process.env.INVENTORY_PATH) : path.join(dataDir, 'inventory.json');
  fs.mkdirSync(videosDir, { recursive: true });
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, '[]', 'utf8');

  const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, videosDir),
    filename: (_, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname || '.mp4').toLowerCase()}`)
  });
  const stockUpload = multer({
    storage,
    limits: { files: 100, fileSize: 10 * 1024 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
      const ok = file.mimetype?.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.originalname || '');
      cb(ok ? null : new Error(`Formato nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o suportado: ${file.originalname}`), ok);
    }
  });

  let writeQueue = Promise.resolve();
  let shortsScheduleLock = Promise.resolve();
  let commentWorkerBusy = false;
  let schedulerTimer = null;
  const schedulerLocks = new Set();
  function readItems() {
    try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); }
    catch (error) { console.error('inventory read:', error); return []; }
  }
  function saveItems(items) {
    const payload = JSON.stringify(items, null, 2);
    writeQueue = writeQueue.then(async () => {
      const temp = `${dbPath}.tmp`;
      await fs.promises.writeFile(temp, payload, 'utf8');
      await fs.promises.rename(temp, dbPath);
    });
    return writeQueue;
  }
  function physicalPath(item) {
    const value = String(item.filePath || '');
    return path.resolve(path.isAbsolute(value) ? value : path.join(videosDir, value));
  }
  function isFileReferencedByOtherRecords(items, item) { const target = path.resolve(physicalPath(item)); return items.some(other => other.id !== item.id && other.filePath && path.resolve(physicalPath(other)) === target && other.status !== "DELETED"); }
  function scopedByUser(items, userId) {
    return items.filter(v => v.userId === userId || (!v.userId && !v.accountId));
  }
  function assertOwned(userId, item) {
    if (!item || item.userId !== userId) {
      const error = new Error('Vídeo não encontrado.');
      error.status = 404; error.code = 'VIDEO_NOT_FOUND'; throw error;
    }
    return item;
  }
  function resolveOwnedAccount(userId, accountId) {
    if (!accountId) throw Object.assign(new Error('Selecione um canal conectado.'), { status: 400 });
    try {
      assertAccountOwnership(userId, accountId);
      const owned = getAccountByUserAndId(userId, accountId);
      if (!owned) throw Object.assign(new Error('Selecione um canal conectado.'), { status: 400 });
      return owned;
    } catch (error) {
      if (error?.status === 403) throw Object.assign(new Error('Este canal não pertence à sua conta.'), { status: 403 });
      if (error?.status === 400) throw error;
      throw Object.assign(new Error('Selecione um canal conectado.'), { status: 400 });
    }
  }
  function clientItem(item) {
    const account = item.userId && item.accountId ? getAccountByUserAndId(item.userId, item.accountId) : null;
    return { ...item, accountName: account?.channelTitle || account?.channelId || null, filePath: item.filePath ? path.basename(item.filePath) : null, fileExists: item.filePath ? fs.existsSync(physicalPath(item)) : false };
  }
  function findVideoById(items, id) {
    console.log(`[inventory] requested id: ${id}`);
    console.log(`[inventory] total records: ${items.length}`);
    const item = items.find(v => v.id === id);
    console.log(`[inventory] found: ${Boolean(item)}`);
    if (!item) { const error = new Error('O vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo solicitado nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o existe no estoque.'); error.status = 404; error.code = 'VIDEO_NOT_FOUND'; error.requestedId = id; throw error; }
    return item;
  }
  function availableOrThrow(item, allowUploading = false) {
    const filePath = physicalPath(item);
    if (!fs.existsSync(filePath)) { const error = new Error('O registro existe, mas o arquivo fÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­sico nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o foi encontrado.'); error.status = 410; error.code = 'VIDEO_FILE_MISSING'; throw error; }
    if (!allowUploading && !['AVAILABLE', 'ERROR', 'SCHEDULED'].includes(item.status)) { const error = new Error('Este vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ estÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ sendo enviado ou jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ foi publicado.'); error.status = 409; throw error; }
    if (item.youtubeVideoId) { const error = new Error('Este vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ foi enviado e nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o pode ser enviado duas vezes.'); error.status = 409; throw error; }
  }
  function userError(error) {
    const reason = error?.response?.data?.error?.errors?.[0]?.reason || error?.errors?.[0]?.reason;
    const apiMessage = error?.response?.data?.error?.message || error?.message || '';
    if (reason === 'uploadLimitExceeded' || /exceeded the number of videos they may upload|video uploads per day/i.test(apiMessage)) return 'O canal atingiu o limite diário de uploads do YouTube. Esse limite é por canal e renova à meia-noite do horário do Pacífico (cerca de 04:00 no horário de Brasília). Trocar de conta OAuth não o reinicia — use outro canal ou aguarde a renovação.';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || /quota exceeded/i.test(apiMessage)) return 'O limite diário de uploads do projeto Google Cloud foi atingido. Essa cota é compartilhada entre os canais e trocar de conta não a reinicia. Aguarde a renovação da cota.';
    if (reason === 'invalidTitle' || reason === 'invalidDescription' || reason === 'invalidTags') return 'O YouTube recusou os metadados deste vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo. Revise tÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­tulo, descriÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o e tags.';
    if (error?.code === 401) return 'A conexÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o com o Google expirou. Conecte sua conta novamente.';
    return error?.response?.data?.error?.message || error.message || 'O upload para o YouTube falhou.';
  }
  async function uploadOne(req, item, publishAt = null) {
    availableOrThrow(item, Boolean(req._schedulerClaimed));
    if (!hasGoogleConfig()) throw Object.assign(new Error('Google OAuth nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o estÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ configurado no arquivo .env.'), { status: 503 });
    if (!req._youtubeClient && !item.accountId) throw Object.assign(new Error('Este vídeo está sem canal. Atribua-o a um canal conectado antes de publicar ou agendar.'), { status: 409 });
    if (publishAt && new Date(publishAt).getTime() <= Date.now() + 60000) throw Object.assign(new Error('O horÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio de agendamento precisa estar no futuro.'), { status: 400 });
    item.status = 'UPLOADING'; item.error = null; await saveItems(readItems().map(v => v.id === item.id ? item : v));
    try {
      if (!item.userId) throw Object.assign(new Error('Este vídeo está sem canal. Atribua-o a um canal conectado antes de publicar ou agendar.'), { code: 'AUTH_REQUIRED', status: 401 });
      const account = getAccountByUserAndId(item.userId, item.accountId);
      if (!account || account.accountId !== item.accountId) throw Object.assign(new Error('O canal deste vídeo foi desconectado. Selecione outro canal ou reconecte o canal original.'), { code: 'AUTH_REQUIRED', status: 401 });
      item.channelId = account.channelId;
      const auth = req._youtubeClient || await getAuthenticatedYouTubeClient(account);
      const youtube = google.youtube({ version: 'v3', auth });
      const response = await youtube.videos.insert({
        part: ['snippet', 'status'], notifySubscribers: true,
        requestBody: {
          snippet: buildYoutubeSnippet(item),
          status: { privacyStatus: publishAt ? 'private' : 'public', ...(publishAt ? { publishAt: new Date(publishAt).toISOString() } : {}), selfDeclaredMadeForKids: false }
        },
        media: { mimeType: item.mimeType || 'video/*', body: fs.createReadStream(physicalPath(item)) }
      });
      item.youtubeVideoId = response.data.id;
      markPending(item);
      item.uploadedAt = new Date().toISOString();
      item.scheduledAt = publishAt ? new Date(publishAt).toISOString() : null;
      item.status = publishAt ? 'SCHEDULED' : 'PUBLISHED';
      item.error = null;
      return item;
    } catch (error) {
      item.status = 'ERROR'; item.error = ['AUTH_REQUIRED', 'RECONNECT_REQUIRED', 'ACCOUNT_CHANNEL_MISMATCH'].includes(error?.code) ? 'AUTH_REQUIRED' : userError(error); console.error('inventory youtube upload:', userError(error)); throw error;
    } finally {
      const latest = readItems(); const index = latest.findIndex(v => v.id === item.id); if (index >= 0) latest[index] = item; await saveItems(latest);
    }
  }

  async function processComments() {
    if (commentWorkerBusy || !hasGoogleConfig()) return;
    commentWorkerBusy = true;
    try {
      const items = readItems(); 
      for (const item of items) {
        if (!item.youtubeVideoId) continue;
        if (!item.commentStatus) { markPending(item); await saveItems(items); }
        // Vídeos agendados ainda estão privados até a data de publicação no YouTube.
        // Só postar comentário quando o vídeo estiver realmente público.
        if (item.status !== 'PUBLISHED') continue;
        if (item.autoCommentEnabled !== true || ['POSTED', 'DISABLED'].includes(item.commentStatus)) continue;
        if (item.commentAttemptCount >= MAX_COMMENT_ATTEMPTS || item.commentStatus === 'POSTING') continue;
        if (item.lastCommentAttemptAt && Date.now() - new Date(item.lastCommentAttemptAt).getTime() < 60000) continue;
        item.commentStatus = 'POSTING'; item.commentAttemptCount = Number(item.commentAttemptCount || 0) + 1; item.lastCommentAttemptAt = new Date().toISOString();
        await saveItems(items);
        console.log(`[comment] posting video=${item.id}`);
        try {
          const account = item.userId && item.accountId ? getAccountByUserAndId(item.userId, item.accountId) : null;
          if (!item.userId || !account) { item.commentStatus = 'PENDING'; item.commentError = 'AUTH_REQUIRED'; await saveItems(items); continue; }
          item.accountId = account.accountId;
          item.youtubeCommentId = await postComment({ auth: await getAuthenticatedYouTubeClient(account), item });
          item.commentStatus = 'POSTED'; item.commentPostedAt = new Date().toISOString(); item.commentError = null;
          console.log(`[comment] success commentId=${item.youtubeCommentId}`);
        } catch (error) {
          const normalized = apiError(error); item.commentStatus = normalized.permanent ? (normalized.code === 'COMMENTS_DISABLED' ? 'DISABLED' : 'ERROR') : 'ERROR'; item.commentError = normalized.code || normalized.message;
        }
        await saveItems(items);
      }
    } finally { commentWorkerBusy = false; }
  }
  async function processPendingSchedules() {
    const now = Date.now();
    const pending = readItems().filter(v => v.status === 'SCHEDULED' && v.scheduledAt && new Date(v.scheduledAt).getTime() <= now);
    console.log("[scheduler] pending=" + pending.length);
    for (const item of pending) {
      if (schedulerLocks.has(item.id)) continue;
      schedulerLocks.add(item.id);
      try {
        const latestItems = readItems();
        const latestIndex = latestItems.findIndex(v => v.id === item.id);
        if (latestIndex < 0 || latestItems[latestIndex].status !== 'SCHEDULED') continue;
        const latest = latestItems[latestIndex];

        if (!latest.userId && !latest.youtubeVideoId) {
          latest.status = 'ERROR';
          latest.error = 'OWNER_MIGRATION_REQUIRED';
          await saveItems(latestItems);
          continue;
        }

        // Shorts (e outros vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deos) enviados ao YouTube com publishAt jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ possuem
        // youtubeVideoId. Nesse caso o prÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³prio YouTube farÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ a publicaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o.
        // O scheduler local sÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ atualiza o estado e NUNCA faz um segundo upload.
        if (latest.youtubeVideoId) {
          latest.status = 'PUBLISHED';
          latest.publishedAt = new Date().toISOString();
          latest.error = null;
          markPending(latest);
          await saveItems(latestItems);
          console.log("[scheduler] youtube scheduled item marked published id=" + latest.id);
          continue;
        }

        // Compatibilidade com agendamentos locais antigos que ainda nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o foram
        // enviados ao YouTube.
        const account = latest.accountId ? getAccountByUserAndId(latest.userId, latest.accountId) : null;
        if (!account?.accountId || getAccountAuthStatus(account.accountId) === 'RECONNECT_REQUIRED') {
          console.log("[scheduler] blocked auth id=" + latest.id);
          latest.status = 'ERROR';
          latest.error = 'AUTH_REQUIRED';
          await saveItems(latestItems);
          continue;
        }
        if (!fs.existsSync(physicalPath(latest))) {
          latest.status = 'MISSING';
          latest.error = 'VIDEO_FILE_MISSING';
          await saveItems(latestItems);
          continue;
        }

        latest.status = 'UPLOADING';
        latest.attemptCount = Number(latest.attemptCount || 0) + 1;
        latest.lastAttemptAt = new Date().toISOString();
        latest.accountId = account.accountId;
        latest.channelId = account.channelId || null;
        await saveItems(latestItems);
        console.log("[scheduler] processing id=" + latest.id);

        try {
          const client = await getAuthenticatedYouTubeClient(account);
          const req = { _schedulerClaimed: true, _youtubeClient: client };
          await uploadOne(req, latest, null);
          console.log("[scheduler] uploaded id=" + latest.id);
        } catch (error) {
          const failedItems = readItems();
          const failed = failedItems.find(v => v.id === latest.id);
          if (failed) {
            failed.status = 'ERROR';
            failed.error = ['AUTH_REQUIRED', 'RECONNECT_REQUIRED', 'ACCOUNT_CHANNEL_MISMATCH'].includes(error?.code) ? 'AUTH_REQUIRED' : userError(error);
            await saveItems(failedItems);
          }
          console.error("[scheduler] error id=" + latest.id);
        }
      } finally {
        schedulerLocks.delete(item.id);
      }
    }
    await processComments();
  }
  function startScheduler() { if (schedulerTimer) return; console.log('[scheduler] started'); schedulerTimer = setInterval(() => processPendingSchedules().catch(() => {}), 60000); schedulerTimer.unref(); processPendingSchedules().catch(() => {}); }
  router.get('/comments/settings', (_, res) => res.json(readSettings()));
  router.put('/comments/settings', (req, res, next) => { try { const current = readSettings(); const nextValue = { ...current, enabled: req.body.enabled !== undefined ? Boolean(req.body.enabled) : current.enabled, text: req.body.text !== undefined ? String(req.body.text || '').slice(0, 10000) : current.text, categories: req.body.categories || current.categories || {}, channels: req.body.channels || current.channels || {} }; saveSettings(nextValue); res.json(nextValue); } catch (error) { next(error); } });
  router.post('/:id([0-9a-fA-F-]+)/comment', async (req, res, next) => { try { const items = readItems(); const item = findVideoById(items, req.params.id); assertOwned(req.session.userId, item); if (!item.youtubeVideoId) throw Object.assign(new Error('O vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo ainda nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o possui youtubeVideoId.'), { status: 409 }); if (item.commentStatus === 'POSTED' || item.youtubeCommentId) return res.json(clientItem(item)); item.autoCommentEnabled = true; item.commentText = String(req.body.text || item.commentText || readSettings().text || '').trim(); item.commentStatus = 'PENDING'; await saveItems(items); await processComments(); res.json(clientItem(findVideoById(readItems(), item.id))); } catch (error) { next(error); } });

  function localSlotIso(date, slot) { return new Date(`${date}T${slot}:00-03:00`).toISOString(); }
  function dateAfter(date, days) { const value = new Date(`${date}T12:00:00-03:00`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
  function itemSlot(item) {
    if (item.scheduledDate && item.scheduledSlot) return `${item.scheduledDate}|${item.scheduledSlot}`;
    if (!item.scheduledAt) return null;
    const value = new Date(new Date(item.scheduledAt).getTime() - 3 * 60 * 60000);
    return `${value.toISOString().slice(0, 10)}|${value.toISOString().slice(11, 16)}`;
  }
  function getNextAvailableSlots(items, count, startDate, contentType = 'SHORT', accountId = null) {
    const occupied = new Set(items.filter(v => (v.contentType || 'LONG') === contentType && (!accountId || v.accountId === accountId) && ['SCHEDULED', 'UPLOADING', 'PUBLISHED'].includes(v.status)).map(itemSlot).filter(Boolean));
    const result = []; let date = startDate || new Date(Date.now() - 3 * 60 * 60000).toISOString().slice(0, 10);
    for (let day = 0; result.length < count && day < 366; day += 1) {
      for (const slot of SHORTS_DAILY_SLOTS) {
        const key = `${date}|${slot}`; const candidate = new Date(`${date}T${slot}:00-03:00`);
        if (!occupied.has(key) && candidate.getTime() > Date.now() + 60000) { occupied.add(key); result.push({ scheduledDate: date, scheduledSlot: slot, scheduledAt: candidate.toISOString() }); if (result.length === count) break; }
      }
      date = dateAfter(date, 1);
    }
    if (result.length < count) throw Object.assign(new Error('NÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o foi possÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­vel encontrar slots de Shorts disponÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­veis nos prÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ximos 12 meses.'), { status: 409 });
    return result;
  }
  function getNextAvailableShortSlots(items, count, startDate) { return getNextAvailableSlots(items, count, startDate, 'SHORT'); }
  async function withShortsScheduleLock(callback) {
    const previous = shortsScheduleLock; let release; shortsScheduleLock = new Promise(resolve => { release = resolve; }); await previous;
    try { return await callback(); } finally { release(); }
  }

  router.get('/categories', (_, res) => res.json(publicCategories()));
  router.post('/from-library', async (req, res, next) => {
    try {
      const videoIds = [...new Set(Array.isArray(req.body.videoIds) ? req.body.videoIds.map(String) : [])];
      const requestedCategory = String(req.body.categoryId || '');
      const accountId = String(req.body.accountId || '');
      if (!videoIds.length) throw Object.assign(new Error('Selecione pelo menos um vídeo da Biblioteca.'), { status: 400 });
      const targetAccount = resolveOwnedAccount(req.session.userId, accountId);
      if (requestedCategory && !categoriesConfig[requestedCategory]) throw Object.assign(new Error('Categoria inválida.'), { status: 400 });
      const items = readItems();
      const sources = videoIds.map(id => findVideoById(items, id)).filter(v => v.userId === req.session.userId || (!v.userId && !v.accountId));
      if (sources.some(item => (item.contentType || 'LONG') !== 'LONG')) throw Object.assign(new Error('Somente vídeos LONG da Biblioteca podem ser usados como fonte.'), { status: 400 });
      const existingShortHashes = new Set(items.filter(item => item.contentType === 'SHORT' && item.accountId === accountId && item.fileHash).map(item => item.fileHash));
      const usedTitles = items.filter(item => item.contentType === 'SHORT').map(item => item.title);
      const created = []; const skipped = [];
      for (const source of sources) {
        const sourcePath = physicalPath(source);
        if (!fs.existsSync(sourcePath)) { skipped.push({ videoId: source.id, reason: 'VIDEO_FILE_MISSING' }); continue; }
        if (!source.fileHash) source.fileHash = crypto.createHash('sha256').update(await fs.promises.readFile(sourcePath)).digest('hex');
        if (existingShortHashes.has(source.fileHash)) { skipped.push({ videoId: source.id, reason: 'SHORT_ALREADY_EXISTS' }); continue; }
        const category = requestedCategory || source.category || 'brainrot'; const config = categoriesConfig[category] || categoriesConfig.brainrot;
        const id = crypto.randomUUID(); const title = generateShortTitle(category, `${source.fileHash}:${id}`, usedTitles); usedTitles.push(title);
        const item = {
          id, fileHash: source.fileHash, filename: source.filename, originalFilename: source.originalFilename,
          filePath: source.filePath, mimeType: source.mimeType, size: source.size, sourceInventoryId: source.id,
          category, contentType: 'SHORT', userId: req.session.userId, accountId, channelId: targetAccount.channelId, title, normalizedTitle: normalizeTitle(title), description: config.description,
          tags: config.tags, youtubeCategoryId: config.youtubeCategoryId, youtubeCategoryName: config.youtubeCategoryName,
          status: 'AVAILABLE', createdAt: new Date().toISOString(), scheduledAt: null, scheduledDate: null,
          scheduledSlot: null, uploadedAt: null, youtubeVideoId: null, error: null
        };
        items.push(item); created.push(item); existingShortHashes.add(source.fileHash);
      }
      await saveItems(items);
      res.status(201).json({ added: created.length, skipped: skipped.length, videos: created.map(clientItem), skippedVideos: skipped });
    } catch (error) { next(error); }
  });
  router.post('/reuse-as-shorts', async (req, res, next) => {
    try {
      const sourceIds = [...new Set(Array.isArray(req.body.sourceIds) ? req.body.sourceIds.map(String) : [])];
      const accountIds = [...new Set(Array.isArray(req.body.accountIds) ? req.body.accountIds.map(String) : [])];
      if (!sourceIds.length) throw Object.assign(new Error('Selecione pelo menos um vídeo da Biblioteca.'), { status: 400 });
      if (!accountIds.length) throw Object.assign(new Error('Selecione pelo menos um canal do YouTube.'), { status: 400 });
      const items = readItems();
      const sources = sourceIds.map(id => findVideoById(items, id)).filter(v => v.userId === req.session.userId || (!v.userId && !v.accountId));
      if (sources.some(item => (item.contentType || 'LONG') !== 'LONG')) throw Object.assign(new Error('A origem precisa ser um vídeo da Biblioteca.'), { status: 400 });
      const ownedAccounts = new Map();
      for (const accountId of accountIds) {
        const account = resolveOwnedAccount(req.session.userId, accountId);
        if (getAccountAuthStatus(accountId) !== 'CONNECTED') throw Object.assign(new Error(`O canal ${accountId} precisa ser conectado novamente.`), { status: 401 });
        ownedAccounts.set(accountId, account);
      }
      const created = [];
      for (const source of sources) {
        if (!fs.existsSync(physicalPath(source))) throw Object.assign(new Error(`O arquivo de ${source.originalFilename || source.title} não foi encontrado.`), { status: 410 });
        for (const accountId of accountIds) {
          const targetAccount = ownedAccounts.get(accountId);
          const duplicate = items.find(item => item.sourceInventoryId === source.id && item.accountId === accountId && item.contentType === 'SHORT' && item.status !== 'DELETED');
          if (duplicate) continue;
          const copy = {
            ...source,
            id: crypto.randomUUID(),
            contentType: 'SHORT',
            sourceInventoryId: source.id,
            userId: req.session.userId,
            accountId,
            channelId: targetAccount.channelId,
            status: 'AVAILABLE',
            createdAt: new Date().toISOString(),
            scheduledAt: null,
            scheduledDate: null,
            scheduledSlot: null,
            uploadedAt: null,
            youtubeVideoId: null,
            error: null
          };
          items.push(copy);
          created.push(copy);
        }
      }
      await saveItems(items);
      res.json({ created: created.map(clientItem), skipped: sourceIds.length * accountIds.length - created.length });
    } catch (error) { next(error); }
  });
  router.post('/long-schedule/preview', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body.videoIds) ? req.body.videoIds : [];
      if (!ids.length) throw Object.assign(new Error('Selecione pelo menos um vídeo.'), { status: 400 });
      const items = readItems(); const selected = scopedByUser(ids.map(id => findVideoById(items, id)), req.session.userId);
      if (selected.some(v => (v.contentType || 'LONG') !== 'LONG')) throw Object.assign(new Error('Este agendamento aceita somente vídeos LONG da Biblioteca.'), { status: 400 });
      const accountId = selected[0]?.accountId || null; if (selected.some(v => (v.accountId || null) !== accountId)) throw Object.assign(new Error('Agende somente vídeos do mesmo canal por vez.'), { status: 400 });
      const slots = await withShortsScheduleLock(async () => getNextAvailableSlots(items, selected.length, req.body.startDate || null, 'LONG', accountId));
      res.json({ items: selected.map((item, index) => ({ videoId: item.id, title: item.title, scheduledAt: slots[index].scheduledAt, scheduledDate: slots[index].scheduledDate, scheduledSlot: slots[index].scheduledSlot })), maxPerDay: MAX_SHORTS_PER_DAY, slots: SHORTS_DAILY_SLOTS });
    } catch (error) { next(error); }
  });
  router.get('/long-schedule/capacity', (req, res, next) => {
    try {
      const startDate = req.query.startDate || new Date(Date.now() - 3 * 60 * 60000).toISOString().slice(0, 10); const items = scopedByUser(readItems(), req.session.userId); const accountId = String(req.query.accountId || '');
      const days = [0, 1].map(offset => { const date = dateAfter(startDate, offset); const used = new Set(items.filter(v => (v.contentType || 'LONG') === 'LONG' && (!accountId || (accountId === '__unassigned__' ? !v.accountId : v.accountId === accountId)) && ['SCHEDULED', 'UPLOADING', 'PUBLISHED'].includes(v.status) && itemSlot(v)?.startsWith(`${date}|`)).map(itemSlot)); return { date, occupied: used.size, available: Math.max(0, MAX_SHORTS_PER_DAY - used.size), full: used.size >= MAX_SHORTS_PER_DAY }; });
      res.json({ maxPerDay: MAX_SHORTS_PER_DAY, slots: SHORTS_DAILY_SLOTS, days });
    } catch (error) { next(error); }
  });
  router.post('/long-schedule/confirm', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body.videoIds) ? req.body.videoIds : [];
      if (!ids.length) throw Object.assign(new Error('Selecione pelo menos um vídeo.'), { status: 400 });
      const results = await withShortsScheduleLock(async () => {
        const items = readItems(); const selected = ids.map(id => findVideoById(items, id)).filter(v => v.userId === req.session.userId);
        if (selected.some(v => (v.contentType || 'LONG') !== 'LONG')) throw Object.assign(new Error('Este agendamento aceita somente vídeos LONG da Biblioteca.'), { status: 400 });
        const accountId = selected[0]?.accountId || null; if (selected.some(v => (v.accountId || null) !== accountId)) throw Object.assign(new Error('Agende somente vídeos do mesmo canal por vez.'), { status: 400 });
        const slots = getNextAvailableSlots(items, selected.length, req.body.startDate || null, 'LONG', accountId); const output = [];
        for (let index = 0; index < selected.length; index += 1) { const item = selected[index]; const slot = slots[index]; item.scheduledDate = slot.scheduledDate; item.scheduledSlot = slot.scheduledSlot; try { output.push({ ok: true, item: clientItem(await uploadOne(req, item, slot.scheduledAt)) }); } catch (error) { output.push({ ok: false, videoId: item.id, scheduledAt: slot.scheduledAt, error: userError(error) }); } }
        return output;
      });
      res.json({ items: results, maxPerDay: MAX_SHORTS_PER_DAY });
    } catch (error) { next(error); }
  });
  router.post('/schedule/preview', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body.videoIds) ? req.body.videoIds : []; if (!ids.length) throw Object.assign(new Error('Selecione pelo menos um Short.'), { status: 400 });
        const items = readItems(); const selected = ids.map(id => findVideoById(items, id)).filter(v => v.userId === req.session.userId); if (selected.some(v => v.contentType !== 'SHORT')) throw Object.assign(new Error('O agendamento automÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡tico aceita somente vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deos marcados como SHORT.'), { status: 400 });
      const accountId = selected[0]?.accountId || null; if (!accountId || selected.some(v => v.accountId !== accountId)) throw Object.assign(new Error('Atribua os Shorts ao mesmo canal antes de agendar.'), { status: 400 });
      const slots = await withShortsScheduleLock(async () => getNextAvailableSlots(items, selected.length, req.body.startDate || null, 'SHORT', accountId));
      res.json({ items: selected.map((item, index) => ({ videoId: item.id, title: item.title, scheduledAt: slots[index].scheduledAt, scheduledDate: slots[index].scheduledDate, scheduledSlot: slots[index].scheduledSlot })), maxPerDay: MAX_SHORTS_PER_DAY, slots: SHORTS_DAILY_SLOTS });
    } catch (error) { next(error); }
  });
  router.get('/schedule/capacity', (req, res, next) => {
    try {
      const startDate = req.query.startDate || new Date(Date.now() - 3 * 60 * 60000).toISOString().slice(0, 10); const items = scopedByUser(readItems(), req.session.userId); const accountId = String(req.query.accountId || ''); const days = [0, 1].map(offset => { const date = dateAfter(startDate, offset); const used = new Set(items.filter(v => v.contentType === 'SHORT' && (!accountId || (accountId === '__unassigned__' ? !v.accountId : v.accountId === accountId)) && ['SCHEDULED', 'UPLOADING', 'PUBLISHED'].includes(v.status) && itemSlot(v)?.startsWith(`${date}|`)).map(itemSlot)); return { date, occupied: used.size, available: Math.max(0, MAX_SHORTS_PER_DAY - used.size), full: used.size >= MAX_SHORTS_PER_DAY }; }); res.json({ maxPerDay: MAX_SHORTS_PER_DAY, slots: SHORTS_DAILY_SLOTS, days });
    } catch (error) { next(error); }
  });
  router.post('/schedule/confirm', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body.videoIds) ? req.body.videoIds : []; if (!ids.length) throw Object.assign(new Error('Selecione pelo menos um Short.'), { status: 400 });
      const results = await withShortsScheduleLock(async () => {
      const items = readItems(); const selected = scopedByUser(ids.map(id => findVideoById(items, id)), req.session.userId); if (selected.some(v => v.contentType !== 'SHORT')) throw Object.assign(new Error('O agendamento automÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡tico aceita somente vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deos marcados como SHORT.'), { status: 400 });
        const accountId = selected[0]?.accountId || null; if (!accountId || selected.some(v => v.accountId !== accountId)) throw Object.assign(new Error('Atribua os Shorts ao mesmo canal antes de agendar.'), { status: 400 }); const slots = getNextAvailableSlots(items, selected.length, req.body.startDate || null, 'SHORT', accountId); const output = [];
        for (let index = 0; index < selected.length; index += 1) { const item = selected[index]; const slot = slots[index]; item.scheduledDate = slot.scheduledDate; item.scheduledSlot = slot.scheduledSlot; try { output.push({ ok: true, item: clientItem(await uploadOne(req, item, slot.scheduledAt)) }); } catch (error) { output.push({ ok: false, videoId: item.id, scheduledAt: slot.scheduledAt, error: userError(error) }); } }
        return output;
      });
      res.json({ items: results, adjusted: results.some(v => v.ok && v.item?.scheduledAt !== req.body.previewScheduledAt), maxPerDay: MAX_SHORTS_PER_DAY });
    } catch (error) { next(error); }
  });
  router.get('/dashboard', (req, res, next) => { try { const items = readItems().filter(v => v.userId === req.session.userId); const count = (type, status, category) => items.filter(v => (!type || (v.contentType || 'LONG') === type) && (!status || v.status === status) && (!category || v.category === category)).length; const categories = publicCategories().map(c => ({ id: c.id, name: c.name, emoji: c.emoji, long: count('LONG', 'AVAILABLE', c.id), short: count('SHORT', 'AVAILABLE', c.id), scheduled: count(null, 'SCHEDULED', c.id), published: count(null, 'PUBLISHED', c.id) })); const upcoming = items.filter(v => v.status === 'SCHEDULED' && v.scheduledAt).sort((a,b) => new Date(a.scheduledAt)-new Date(b.scheduledAt)).slice(0,10).map(clientItem); res.json({ stats: { longAvailable: count('LONG','AVAILABLE'), shortAvailable: count('SHORT','AVAILABLE'), scheduled: count(null,'SCHEDULED'), uploading: count(null,'UPLOADING'), published: count(null,'PUBLISHED'), errors: count(null,'ERROR') }, categories, upcoming }); } catch (error) { next(error); } });
  router.get('/schedules', (req, res, next) => { try { const type = String(req.query.contentType || '').toUpperCase(); const category = String(req.query.categoryId || ''); const status = String(req.query.status || '');       const items = readItems().filter(v => v.userId === req.session.userId).filter(v => (!type || (v.contentType || 'LONG') === type) && (!category || v.category === category) && (!status || v.status === status) && ['SCHEDULED','UPLOADING','PUBLISHED','ERROR'].includes(v.status)).sort((a,b) => new Date(a.scheduledAt || a.uploadedAt || a.createdAt)-new Date(b.scheduledAt || b.uploadedAt || b.createdAt)); res.json(items.map(clientItem)); } catch (error) { next(error); } });
  router.get('/', async (req, res, next) => {
    try {
    const category = String(req.query.categoryId || req.query.category || '');
    const contentType = String(req.query.contentType || '').toUpperCase();
    const status = String(req.query.status || '').toUpperCase();
    const accountFilter = req.query.accountId === '__unassigned__' ? '__unassigned__' : String(req.query.accountId || '');
    const allItems = readItems(); let changed = false;
    allItems.forEach(item => { if (!item.contentType) { item.contentType = 'LONG'; changed = true; } });
    allItems.forEach(item => { if (item.status === 'SCHEDULED' && item.scheduledAt && new Date(item.scheduledAt).getTime() <= Date.now()) { item.status = 'PUBLISHED'; changed = true; } });
    if (changed) await saveItems(allItems);
    const items = scopedByUser(allItems, req.session.userId).filter(v => (!category || v.category === category) && (!contentType || (v.contentType || 'LONG') === contentType) && (!status || v.status === status) && (!accountFilter || (accountFilter === '__unassigned__' ? !v.accountId : v.accountId === accountFilter))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(items.map(clientItem));
    } catch (error) { next(error); }
  });
  router.get('/stats', (req, res, next) => { try { const contentType = String(req.query.contentType || '').toUpperCase(); const category = String(req.query.categoryId || req.query.category || ''); const accountId = String(req.query.accountId || ''); const items = scopedByUser(readItems(), req.session.userId).filter(v => (!contentType || (v.contentType || 'LONG') === contentType) && (!category || v.category === category) && (!accountId || (accountId === '__unassigned__' ? !v.accountId : v.accountId === accountId))); const count = status => items.filter(v => v.status === status).length; res.json({ available: count('AVAILABLE'), scheduled: count('SCHEDULED'), published: count('PUBLISHED'), errors: count('ERROR'), missing: count('MISSING'), total: items.length }); } catch (error) { next(error); } });
  router.post('/', stockUpload.array('videos', 100), async (req, res, next) => {
    try {
      const category = String(req.body.category || 'brainrot'); const config = categoriesConfig[category]; const accountId = String(req.body.accountId || ''); const targetAccount = accountId ? resolveOwnedAccount(req.session.userId, accountId) : null;
      if (!config) throw Object.assign(new Error('Categoria invÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡lida.'), { status: 400 });
      if (!req.files?.length) throw Object.assign(new Error('Selecione pelo menos um vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo.'), { status: 400 });
      const current = readItems(); const used = current.filter(v => v.category === category && !['PUBLISHED'].includes(v.status)).map(v => v.title);
      const contentType = req.baseUrl === "/api/shorts" ? "SHORT" : "LONG";
      const normalizeContentType = value => String(value || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
      const accountKey = accountId || '__unassigned__';
      const existingNames = new Set(current.filter(v => normalizeContentType(v.contentType) === contentType && (v.accountId || '__unassigned__') === accountKey).map(v => String(v.originalFilename || v.filename || "").toLowerCase()));
      const existingKeys = new Set(current.map(v => String(v.fileHash || "") + ":" + normalizeContentType(v.contentType) + ":" + (v.accountId || '__unassigned__')));
      const results = await Promise.all(req.files.map(async (file, index) => {
        try {
          const filenameKey = String(file.originalname || "").toLowerCase();
          if (existingNames.has(filenameKey)) { await fs.promises.unlink(file.path).catch(() => {}); return { skipped: true, reason: "DUPLICATE_FILENAME", filename: file.originalname }; }
          const fileHash = crypto.createHash("sha256").update(await fs.promises.readFile(file.path)).digest("hex");
          const duplicateKey = fileHash + ":" + contentType + ":" + accountKey;
          console.log("[duplicate-check] filename=" + file.originalname + " requestedType=" + contentType + " duplicate=" + existingKeys.has(duplicateKey));
          if (existingKeys.has(duplicateKey)) { await fs.promises.unlink(file.path).catch(() => {}); return { skipped: true, reason: "DUPLICATE_VIDEO", filename: file.originalname }; }
          const sharedSource = current.find(v => v.fileHash === fileHash && normalizeContentType(v.contentType) === contentType && v.filePath && fs.existsSync(physicalPath(v)));
          if (sharedSource) await fs.promises.unlink(file.path).catch(() => {});
          const id = crypto.randomUUID(); const title = generateTitle(category, file.originalname + ":" + id + ":" + index, used); used.push(title); existingNames.add(filenameKey); existingKeys.add(duplicateKey);
          return { item: { id, fileHash, filename: sharedSource?.filename || file.filename, originalFilename: file.originalname, filePath: sharedSource?.filePath || file.path, mimeType: sharedSource?.mimeType || file.mimetype, size: sharedSource?.size || file.size, category, contentType, userId: req.session.userId, accountId: accountId || null, channelId: targetAccount?.channelId || null, title, normalizedTitle: normalizeTitle(title), description: config.description, tags: config.tags, youtubeCategoryId: config.youtubeCategoryId, youtubeCategoryName: config.youtubeCategoryName, status: "AVAILABLE", createdAt: new Date().toISOString(), scheduledAt: null, scheduledDate: null, scheduledSlot: null, uploadedAt: null, youtubeVideoId: null, error: null } };
        } catch (error) { await fs.promises.unlink(file.path).catch(() => {}); return { skipped: true, reason: error.code || "IMPORT_FAILED", filename: file.originalname, message: error.message }; }
      }));
      const created = results.filter(result => result.item).map(result => result.item);
      const skipped = results.filter(result => result.skipped);
      await saveItems([...current, ...created]); res.status(201).json({ length: created.length, videos: created.map(clientItem), added: created.length, skipped: skipped.length, skippedFiles: skipped.map(v => ({ filename: v.filename, reason: v.reason })) });
    } catch (error) { next(error); }
  });
  router.patch('/:id([0-9a-fA-F-]+)', async (req, res, next) => {
    try {
      const items = readItems(); const item = findVideoById(items, req.params.id); assertOwned(req.session.userId, item);
      if (req.body.contentType !== undefined) { const contentType = String(req.body.contentType).toUpperCase(); if (!['SHORT', 'LONG'].includes(contentType)) throw Object.assign(new Error('Tipo de conteÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âºdo invÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡lido.'), { status: 400 }); item.contentType = contentType; }
      if (!['AVAILABLE', 'ERROR'].includes(item.status)) throw Object.assign(new Error('SÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© possÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­vel editar vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deos disponÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­veis ou com erro.'), { status: 409 });
      if (req.body.title !== undefined) { const title = String(req.body.title).trim().slice(0, 100); if (!title) throw Object.assign(new Error('O tÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­tulo nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o pode ficar vazio.'), { status: 400 }); item.title = title; item.normalizedTitle = normalizeTitle(title); }
      await saveItems(items); res.json(clientItem(item));
    } catch (error) { next(error); }
  });
  router.post('/:id([0-9a-fA-F-]+)/regenerate', async (req, res, next) => {
    try {
      const items = readItems(); const item = findVideoById(items, req.params.id); assertOwned(req.session.userId, item); const used = items.filter(v => v.id !== item.id && v.category === item.category).map(v => v.title);
      item.title = generateTitle(item.category, `${item.id}:${Date.now()}`, used); item.error = null; if (item.status === 'ERROR') item.status = 'AVAILABLE'; await saveItems(items); res.json(clientItem(item));
    } catch (error) { next(error); }
  });
  router.post('/actions/regenerate', async (req, res, next) => {
    try {
      const ids = new Set(req.body.ids || []); const items = readItems(); const selected = items.filter(v => ids.has(v.id) && v.userId === req.session.userId); if (!selected.length) throw Object.assign(new Error('Selecione vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deos para gerar novos tÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­tulos.'), { status: 400 });
      const used = items.filter(v => !ids.has(v.id)).map(v => v.title);
      selected.forEach((item, index) => { item.title = generateTitle(item.category, `${item.id}:${Date.now()}:${index}`, used); used.push(item.title); }); await saveItems(items); res.json(selected.map(clientItem));
    } catch (error) { next(error); }
  });
  router.delete('/:id([0-9a-fA-F-]+)', async (req, res, next) => {
    try { const items = readItems(); const item = findVideoById(items, req.params.id); assertOwned(req.session.userId, item); if (item.status === 'SCHEDULED') throw Object.assign(new Error('Este vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo estÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ agendado. Cancele o agendamento antes de excluir.'), { status: 409, code: 'VIDEO_SCHEDULED' }); if (item.status === 'UPLOADING') throw Object.assign(new Error('NÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© possÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­vel excluir durante o envio.'), { status: 409, code: 'VIDEO_UPLOADING' }); if (item.status !== 'PUBLISHED' && !isFileReferencedByOtherRecords(items, item)) await fs.promises.unlink(physicalPath(item)).catch(error => { if (error.code !== 'ENOENT') throw error; }); if (item.status === 'PUBLISHED') { item.status = 'DELETED'; item.filePath = null; item.error = null; await saveItems(items); } else { await saveItems(items.filter(v => v.id !== item.id)); } res.json({ ok: true }); }
    catch (error) { next(error); }
  });
  // Keep shared Library/Short files until the last inventory reference is removed.
  router.post('/actions/delete', async (req, res, next) => {
    try {
      const ids = new Set(req.body.ids || []); const items = readItems(); const selected = items.filter(v => ids.has(v.id) && v.userId === req.session.userId);
      if (selected.some(v => v.status === 'UPLOADING')) throw Object.assign(new Error('Há um vídeo sendo enviado na seleção.'), { status: 409 });
      if (selected.some(v => v.status === 'SCHEDULED')) throw Object.assign(new Error('Cancele os agendamentos antes de excluir.'), { status: 409 });
      const selectedIdSet = new Set(selected.map(v => v.id));
      const remaining = items.filter(v => !selectedIdSet.has(v.id));
      for (const item of selected) {
        const shared = remaining.some(other => other.filePath && path.resolve(physicalPath(other)) === path.resolve(physicalPath(item)) && other.status !== 'DELETED');
        if (!shared && item.status !== 'PUBLISHED') await fs.promises.unlink(physicalPath(item)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await saveItems(remaining); res.json({ ok: true, deleted: selected.length });
    } catch (error) { next(error); }
  });
  router.post('/actions/assign-account', async (req, res, next) => {
    try {
      const ids = new Set(Array.isArray(req.body.ids) ? req.body.ids.map(String) : []); const accountId = String(req.body.accountId || '');
      if (!ids.size) throw Object.assign(new Error('Selecione pelo menos um vídeo.'), { status: 400 });
      const targetAccount = resolveOwnedAccount(req.session.userId, accountId);
      const items = readItems(); const allById = items.filter(item => ids.has(item.id));
      if (allById.some(item => item.userId && item.userId !== req.session.userId)) { const error = new Error('Vídeo não encontrado.'); error.status = 404; error.code = 'VIDEO_NOT_FOUND'; throw error; }
      const selected = allById.filter(item => item.userId === req.session.userId || (!item.userId && !item.accountId));
      if (selected.some(item => !['AVAILABLE', 'ERROR'].includes(item.status))) throw Object.assign(new Error('Somente vídeos disponíveis ou com erro podem ser movidos de canal.'), { status: 409 });
      if (selected.some(item => items.some(other => !ids.has(other.id) && other.accountId === accountId && other.contentType === item.contentType && other.fileHash && other.fileHash === item.fileHash))) throw Object.assign(new Error('Este canal já possui um dos vídeos selecionados.'), { status: 409 });
      selected.forEach(item => { item.userId = req.session.userId; item.accountId = accountId; item.channelId = targetAccount.channelId; item.error = null; if (item.status === 'ERROR') item.status = 'AVAILABLE'; });
      await saveItems(items); res.json({ updated: selected.length, items: selected.map(clientItem) });
    } catch (error) { next(error); }
  });
  router.post('/actions/delete-legacy-unused', async (req, res, next) => {
    try { const ids = new Set(req.body.ids || []); const items = readItems(); const selected = items.filter(v => ids.has(v.id) && v.userId === req.session.userId); const selectedIdSet = new Set(selected.map(v => v.id)); if (selected.some(v => v.status === 'UPLOADING')) throw Object.assign(new Error('HÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo sendo enviado na seleÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o.'), { status: 409 }); await Promise.all(selected.map(v => fs.promises.unlink(v.filePath).catch(() => {}))); await saveItems(items.filter(v => !selectedIdSet.has(v.id))); res.json({ ok: true, deleted: selected.length }); }
    catch (error) { next(error); }
  });
  router.post('/:id([0-9a-fA-F-]+)/cancel-schedule', async (req, res, next) => { try { const items = readItems(); const item = findVideoById(items, req.params.id); assertOwned(req.session.userId, item); if (item.status !== 'SCHEDULED') throw Object.assign(new Error('Somente vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deos agendados podem ser cancelados.'), { status: 409 }); item.status = 'AVAILABLE'; item.scheduledAt = null; item.scheduledDate = null; item.scheduledSlot = null; await saveItems(items); res.json(clientItem(item)); } catch (error) { next(error); } });
  router.post('/:id([0-9a-fA-F-]+)/upload', async (req, res, next) => {
    try { const items = readItems(); const item = findVideoById(items, req.params.id); assertOwned(req.session.userId, item); const result = await uploadOne(req, item, req.body.publishAt || null); await processComments(); res.json(clientItem(result)); }
    catch (error) { next(Object.assign(error, { message: userError(error) })); }
  });
  router.post('/actions/upload', async (req, res, next) => {
    try {
      const ids = req.body.ids || []; if (!ids.length) throw Object.assign(new Error('Selecione pelo menos um vÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­deo.'), { status: 400 });
      const start = req.body.startAt ? new Date(req.body.startAt) : null; const intervalMinutes = Number(req.body.intervalMinutes || 0); const results = [];
      const selected = readItems().filter(v => ids.includes(v.id) && v.userId === req.session.userId);
      for (let index = 0; index < selected.length; index += 1) {
        const item = selected[index]; const publishAt = start ? new Date(start.getTime() + index * intervalMinutes * 60000).toISOString() : null;
        try { results.push({ ok: true, item: clientItem(await uploadOne(req, item, publishAt)) }); }
        catch (error) { results.push({ ok: false, id: item.id, error: userError(error) }); }
      }
      res.json({ results });
    } catch (error) { next(error); }
  });

  router.use((error, req, res, next) => { console.error('inventory:', error); if (error.code === 'VIDEO_NOT_FOUND') return res.status(404).json({ error: 'VIDEO_NOT_FOUND', message: error.message, requestedId: error.requestedId }); if (error.code === 'VIDEO_FILE_MISSING') return res.status(410).json({ error: 'VIDEO_FILE_MISSING', message: error.message }); return res.status(error.status || 400).json({ error: userError(error) }); });
  router.startScheduler = startScheduler; router.processPendingSchedules = processPendingSchedules;
  return router;
};
