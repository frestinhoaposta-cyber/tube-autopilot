const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAccount } = require('./oauth-store');
const { categoriesConfig } = require('./categories');

const dataDir = path.join(__dirname, '..', 'data');
const settingsPath = path.join(dataDir, 'comment-settings.json');
const MAX_COMMENT_ATTEMPTS = 5;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(settingsPath)) fs.writeFileSync(settingsPath, JSON.stringify({ enabled: false, text: '', categories: {}, channels: {} }, null, 2));
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return { enabled: false, text: '', categories: {}, channels: {} }; } }
function saveSettings(value) { fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2), 'utf8'); return value; }
function channelConfigFor(item) {
  const settings = readSettings(); const channels = settings.channels || {};
  const account = item.accountId ? getAccount(item.accountId) : null;
  const names = [account?.channelTitle, item.channelId].filter(Boolean);
  for (const name of names) {
    for (const [configuredName, config] of Object.entries(channels)) {
      if (String(configuredName).trim().toLowerCase() === String(name).trim().toLowerCase()) {
        return { enabled: config?.enabled !== false, text: String(config?.text || '') };
      }
    }
  }
  return null;
}
function resolveComment(item) {
  const settings = readSettings();
  const byChannel = channelConfigFor(item);
  if (byChannel) return byChannel;
  if (item.commentText) return { enabled: item.autoCommentEnabled !== false, text: item.commentText };
  const category = settings.categories?.[item.category] || {};
  if (category.text) return { enabled: category.enabled !== false, text: category.text };
  const catConfig = categoriesConfig[item.category];
  if (catConfig?.autoComment?.text) return { enabled: catConfig.autoComment.enabled !== false, text: catConfig.autoComment.text };
  return { enabled: settings.enabled === true, text: String(settings.text || '') };
}
function markPending(item) {
  const choice = resolveComment(item);
  item.autoCommentEnabled = choice.enabled && Boolean(choice.text.trim()); item.commentText = choice.text;
  item.commentStatus = item.autoCommentEnabled ? 'PENDING' : 'DISABLED';
  item.commentAttemptCount = 0; item.lastCommentAttemptAt = null; item.commentError = null;
  return item;
}
function apiError(error) {
  const reason = error?.response?.data?.error?.errors?.[0]?.reason || error?.errors?.[0]?.reason;
  if (reason === 'commentsDisabled') return Object.assign(new Error('Comentários desativados neste vídeo.'), { code: 'COMMENTS_DISABLED', permanent: true });
  if (reason === 'videoNotFound') return Object.assign(new Error('Vídeo não encontrado no YouTube.'), { code: 'VIDEO_NOT_FOUND', permanent: true });
  if (reason === 'forbidden' || reason === 'insufficientPermissions') return Object.assign(new Error('A conta não possui permissão para comentar.'), { code: 'OAUTH_PERMISSION', permanent: true });
  return error;
}
async function postComment({ auth, item }) {
  const youtube = google.youtube({ version: 'v3', auth });
  const response = await youtube.commentThreads.insert({ part: ['snippet'], requestBody: { snippet: { videoId: item.youtubeVideoId, topLevelComment: { snippet: { textOriginal: item.commentText } } } } });
  return response.data.id;
}
module.exports = { MAX_COMMENT_ATTEMPTS, readSettings, saveSettings, markPending, postComment, apiError };
