const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAccount } = require('./oauth-store');
const { categoriesConfig } = require('./categories');
const persistence = require('./persistence');

const dataDir = persistence.dataDir;
const settingsPath = process.env.COMMENT_SETTINGS_PATH ? path.resolve(process.env.COMMENT_SETTINGS_PATH) : path.join(dataDir, 'comment-settings.json');
const MAX_COMMENT_ATTEMPTS = 5;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
function readSettings() { return persistence.readDocument(settingsPath, { enabled: false, text: '', categories: {}, channels: {} }); }
function saveSettings(value) { persistence.writeDocument(settingsPath, value); return value; }
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
  if (item.youtubeCommentId) { item.commentStatus = 'POSTED'; return item; }
  if (['POSTED', 'POSTING', 'RECONCILING', 'REVIEW_REQUIRED'].includes(item.commentStatus)) return item;
  // Vídeos sem conta OAuth vinculada nunca conseguirão postar comentário.
  if (!item.userId || !item.accountId) {
    item.autoCommentEnabled = false; item.commentText = '';
    item.commentStatus = 'DISABLED'; item.commentError = 'NO_ACCOUNT';
    item.commentAttemptCount = 0; item.lastCommentAttemptAt = null;
    return item;
  }
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
  const response = await youtube.commentThreads.insert({ part: ['snippet'], requestBody: { snippet: { videoId: item.youtubeVideoId, topLevelComment: { snippet: { textOriginal: item.commentText } } } } }, { retry: false, timeout: 60000 });
  return response.data.snippet?.topLevelComment?.id || response.data.id;
}
async function reconcileComment({ auth, item, youtube = google.youtube({ version: 'v3', auth }) }) {
  const text = String(item.commentAttemptText || item.commentText || '').replace(/\r\n/g, '\n').trim();
  const channelId = item.commentAttemptChannelId || item.channelId;
  if (!text || !channelId) return null;
  let pageToken;
  do {
    const response = await youtube.commentThreads.list({ part: ['snippet'], videoId: item.youtubeVideoId, maxResults: 100, textFormat: 'plainText', pageToken });
    for (const thread of response.data.items || []) {
      const comment = thread.snippet?.topLevelComment;
      const snippet = comment?.snippet;
      if (snippet?.authorChannelId?.value === channelId && String(snippet.textOriginal || snippet.textDisplay || '').replace(/\r\n/g, '\n').trim() === text) return comment.id || thread.id;
    }
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return null;
}
function reevaluateComments(items) {
  let changed = false;
  for (const item of items) {
    if (!item.youtubeVideoId) continue;
    if (!['PUBLISHED', 'SCHEDULED'].includes(item.status)) continue;
    // Reavaliar vídeos que estavam DISABLED (podiam ter sido desativados antes
    // da configuração de comentário ser feita). Também reavalia PENDING sem conta
    // para garantir consistência.
    if (item.commentStatus === 'DISABLED' || (item.commentStatus === 'PENDING' && item.commentError === 'AUTH_REQUIRED')) {
      markPending(item);
      changed = true;
    }
  }
  return changed;
}
module.exports = { MAX_COMMENT_ATTEMPTS, readSettings, saveSettings, markPending, postComment, reconcileComment, apiError, reevaluateComments };
