const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const os = require('os');
const path = require('path');
const metadataPath = path.join(__dirname, '..', 'data', 'metadata-overrides.json');
const crypto = require('crypto');
require('dotenv').config();
const createInventoryRouter = require('./inventory');
const createTikTokRouter = require('./tiktok');
const { categoriesConfig, generateTitle, buildYoutubeSnippet } = require('./categories');
const { saveAccount, getAccount, getAccountsByUserId, getDefaultAccountForUser, getAccountByUserAndId, assertAccountOwnership, setDefaultAccount, removeAccount, getAuthenticatedYouTubeClient } = require('./oauth-store');
const { isSupabaseConfigured, signUp, signIn } = require('./users');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const uploadDir = path.join(os.tmpdir(), 'tube-autopilot-uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = file.mimetype?.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Selecione um arquivo de vídeo válido.'), ok);
  }
});

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '..', 'src')));

function googleConfig(index) {
  if (Number(index) > 1) {
    return { id: process.env.YOUTUBE_CLIENT_ID_2, secret: process.env.YOUTUBE_CLIENT_SECRET_2, redirectUri: process.env.YOUTUBE_REDIRECT_URI_2 };
  }
  return { id: process.env.YOUTUBE_CLIENT_ID, secret: process.env.YOUTUBE_CLIENT_SECRET, redirectUri: process.env.YOUTUBE_REDIRECT_URI };
}

function hasGoogleConfig(index) {
  if (index) { const cfg = googleConfig(index); return Boolean(cfg.id && cfg.secret && cfg.redirectUri); }
  return [1, 2].some(idx => hasGoogleConfig(idx));
}

function oauthClient(index) {
  const cfg = googleConfig(index);
  if (!hasGoogleConfig(index)) return null;
  return new google.auth.OAuth2(cfg.id, cfg.secret, cfg.redirectUri);
}

function safeReturnTo(value) {
  const returnTo = String(value || '/#settings');
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/#settings';
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Não autenticado. Faça login para continuar.' });
  next();
}

function ownAccountOr404(req, res, next) {
  try { res.locals.account = assertAccountOwnership(req.session.userId, req.params.accountId); next(); }
  catch (error) { return res.status(error.status || 403).json({ error: error.message }); }
}

app.get('/api/health', (_, res) => res.json({ ok: true, googleConfigured: hasGoogleConfig() }));

app.get('/api/auth/status', requireAuth, (req, res) => {
  const accounts = getAccountsByUserId(req.session.userId);
  const defaultAccount = getDefaultAccountForUser(req.session.userId);
  res.json({
    configured: hasGoogleConfig(),
    connected: accounts.some(account => account.connected),
    connectedCount: accounts.filter(account => account.connected).length,
    defaultAccountId: defaultAccount?.accountId || null,
    accounts,
    channel: defaultAccount ? { id: defaultAccount.channelId, title: defaultAccount.channelTitle, thumbnail: defaultAccount.channelThumbnail } : null
  });
});

app.get('/api/auth/accounts', requireAuth, (req, res) => res.json(getAccountsByUserId(req.session.userId)));

app.post('/api/auth/register', async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(503).json({ error: 'Autenticação não configurada no servidor.' });
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
  try {
    const user = await signUp({ email, password });
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Não foi possível iniciar a sessão.' });
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      res.status(201).json({ user: { id: user.id, email: user.email } });
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(503).json({ error: 'Autenticação não configurada no servidor.' });
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  try {
    const user = await signIn({ email, password });
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Não foi possível iniciar a sessão.' });
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      res.json({ user: { id: user.id, email: user.email } });
    });
  } catch (error) {
    res.status(error.status || 401).json({ error: 'E-mail ou senha inválidos.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.clearCookie('connect.sid').json({ ok: true }));
  } else {
    res.clearCookie('connect.sid').json({ ok: true });
  }
});

app.get('/api/auth/session', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Não autenticado.' });
  res.json({ user: { id: req.session.userId, email: req.session.userEmail || null } });
});

function startGoogleOAuth(req, res) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Não autenticado. Faça login antes de conectar um canal.' });
  const credentialSet = req.query.client === '2' ? 2 : 1;
  const client = oauthClient(credentialSet);
  if (!client) return res.redirect('/?auth=missing-config#settings');
  const state = crypto.randomBytes(32).toString('hex');
  req.session.googleOauth = {
    userId: req.session.userId,
    state,
    returnTo: safeReturnTo(req.query.returnTo),
    credentialSet,
    reconnectAccountId: req.query.accountId ? String(req.query.accountId) : null,
    createdAt: Date.now()
  };
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ]
  });
  res.redirect(url);
}

app.get('/api/auth/google', startGoogleOAuth);
app.get('/auth/youtube', startGoogleOAuth);

async function finishGoogleOAuth(req, res) {
  const flow = req.session.googleOauth;
  if (req.query.error) return res.redirect('/?auth=denied#settings');
  if (!flow || !req.query.state || req.query.state !== flow.state || Date.now() - flow.createdAt > 10 * 60 * 1000) {
    return res.status(400).send('Falha de segurança no login (state inválido). Volte ao site e tente conectar novamente.');
  }
  const userId = flow.userId;
  if (!userId) {
    console.error('OAuth callback: usuário não identificado na sessão.');
    delete req.session.googleOauth;
    return res.redirect('/?auth=require-login#login');
  }
  try {
    let reconnecting = flow.reconnectAccountId ? getAccount(flow.reconnectAccountId) : null;
    if (reconnecting && String(reconnecting.userId) !== String(userId)) reconnecting = null;
    const credentialSet = Number(reconnecting?.credentialSet) > 1 ? 2 : (flow.credentialSet || 1);
    const client = oauthClient(credentialSet);
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    const channelResponse = await google.youtube({ version: 'v3', auth: client }).channels.list({ part: ['id', 'snippet'], mine: true });
    const channel = channelResponse.data.items?.[0];
    if (!channel?.id) throw new Error('Nenhum canal do YouTube foi retornado para esta autorização.');
    if (reconnecting && reconnecting.channelId !== channel.id) throw new Error(`Você autorizou ${channel.snippet?.title || channel.id}, mas solicitou reconectar ${reconnecting.channelTitle}.`);
    const existingChannel = getAccount(channel.id);
    let googleAccountId = reconnecting?.googleAccountId ?? existingChannel?.googleAccountId ?? null;
    if (tokens.id_token) {
      try { googleAccountId = (await client.verifyIdToken({ idToken: tokens.id_token, audience: googleConfig(credentialSet).id })).getPayload()?.sub || googleAccountId; }
      catch { /* youtube scopes do not guarantee an ID token */ }
    }
    try {
      saveAccount({
        userId,
        channelId: channel.id,
        googleAccountId,
        channelTitle: channel.snippet?.title || 'Canal do YouTube',
        channelThumbnail: channel.snippet?.thumbnails?.default?.url || '',
        credentialSet,
        refreshToken: tokens.refresh_token || undefined,
        accessToken: tokens.access_token || null,
        tokenExpiry: tokens.expiry_date || null,
        status: tokens.refresh_token || reconnecting?.refreshToken || existingChannel?.refreshToken ? 'CONNECTED' : 'RECONNECT_REQUIRED'
      });
    } catch (error) {
      if (error.status === 409) {
        delete req.session.googleOauth;
        return res.redirect('/?auth=channel-claimed#settings');
      }
      throw error;
    }
    const returnTo = flow.returnTo;
    delete req.session.googleOauth;
    const hashIndex = returnTo.indexOf('#');
    const base = hashIndex >= 0 ? returnTo.slice(0, hashIndex) : returnTo;
    const hash = hashIndex >= 0 ? returnTo.slice(hashIndex) : '';
    res.redirect(`${base}${base.includes('?') ? '&' : '?'}auth=success${hash}`);
  } catch (err) {
    console.error('OAuth callback:', err?.response?.data?.error?.message || err.message);
    delete req.session.googleOauth;
    res.redirect('/?auth=error#settings');
  }
}

app.get('/api/auth/google/callback', finishGoogleOAuth);
app.get('/auth/youtube/callback', finishGoogleOAuth);

app.post('/api/auth/accounts/:accountId/default', requireAuth, (req, res) => {
  const account = setDefaultAccount(req.session.userId, req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Canal não encontrado.' });
  res.json(account);
});

app.delete('/api/auth/accounts/:accountId', requireAuth, ownAccountOr404, async (req, res) => {
  const account = res.locals.account;
  const owned = getAccountByUserAndId(req.session.userId, req.params.accountId);
  const token = owned?.refreshToken || owned?.accessToken;
  if (token) {
    try { await oauthClient(Number(account?.credentialSet) > 1 ? 2 : 1).revokeToken(token); }
    catch (error) { console.warn(`Não foi possível revogar a credencial do canal ${account.channelId}:`, error.message); }
  }
  removeAccount(req.session.userId, req.params.accountId);
  res.json({ ok: true, accountId: account.accountId });
});

const inventoryRouter = createInventoryRouter({ oauthClient, hasGoogleConfig });
app.use('/api/inventory', requireAuth, inventoryRouter);
app.use('/api/shorts', requireAuth, inventoryRouter);
inventoryRouter.startScheduler();
app.use('/api/tiktok', createTikTokRouter());

app.get('/api/metadata', (_, res) => { const overrides = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {}; res.json(Object.values(categoriesConfig).map(c => ({ ...c, ...(overrides[c.id] || {}) }))); });
app.put('/api/metadata/:categoryId', (req, res) => { const id = String(req.params.categoryId); const base = categoriesConfig[id]; if (!base) return res.status(404).json({ error: 'Categoria inválida.' }); const body = req.body || {}; if (body.description !== undefined && typeof body.description !== 'string') return res.status(400).json({ error: 'description deve ser string.' }); if (body.tags !== undefined && !Array.isArray(body.tags)) return res.status(400).json({ error: 'tags deve ser array.' }); if (body.youtubeCategoryId !== undefined && typeof body.youtubeCategoryId !== 'string') return res.status(400).json({ error: 'youtubeCategoryId deve ser string.' }); const overrides = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {}; overrides[id] = { ...(overrides[id] || {}), ...Object.fromEntries(['description','tags','youtubeCategoryId','longTitleTemplates','shortTitleTemplates','autoComment'].filter(k => body[k] !== undefined).map(k => [k, body[k]])) }; fs.writeFileSync(metadataPath, JSON.stringify(overrides, null, 2), 'utf8'); Object.assign(base, overrides[id]); res.json({ ...base }); });

app.post('/api/generate', (req, res) => {
  const categoryId = String(req.body?.categoryId || 'brainrot');
  const config = categoriesConfig[categoryId];
  if (!config) return res.status(400).json({ error: 'Categoria inválida.' });
  const title = generateTitle(categoryId, `${req.body?.fileName || ''}:${req.body?.topic || ''}:${Date.now()}`, []);
  console.log(`[metadata] category=${categoryId}`);
  console.log(`[metadata] title generated=${Boolean(title)}`);
  console.log(`[metadata] description loaded=${Boolean(config.description)}`);
  console.log(`[metadata] tags count=${config.tags.length}`);
  res.json({ title, titles: [title], description: config.description, tags: config.tags, youtubeCategoryId: config.youtubeCategoryId, youtubeCategoryName: config.youtubeCategoryName });
});

app.post('/api/generate-legacy-template', async (req, res) => {
  const { topic = '', keywords = '', fileName = '' } = req.body || {};
  const source = `${topic} ${keywords} ${fileName}`.toUpperCase();
  const game = source.includes('TSUNAMI') ? 'FUJA DO TSUNAMI' : source.includes('FLORESTA') || source.includes('FOREST') ? '99 NOITES NA FLORESTA' : 'ROUBE UM BRAINROT';
  const mobile = /MOBILE|CELULAR|ANDROID|IOS/.test(source);
  const action = /AUTO.?FARM|FARM/.test(source) ? 'AUTO FARM' : /AUTO.?COLLECT|COLLECT/.test(source) ? 'AUTO COLLECT' : /SEM.?KEY|NO.?KEY/.test(source) ? 'SEM KEY' : '';
  const device = mobile ? 'MOBILE E PC' : 'MOBILE E PC';
  const titles = [
    `🔥 NOVO SCRIPT ${game} SEM KEY 2026 🤯`,
    `🧠 MELHOR SCRIPT ${game} ${device} 🏆`,
    `⚡ SCRIPT ${game} ${action || 'AUTO FARM'} 2026`,
    `🚀 NOVO HACK ${game} FUNCIONANDO 2026`,
    `😍 SCRIPT ${game} TESTADO E APROVADO`,
    `🏆 O MELHOR SCRIPT DE ${game} QUE EXISTE 🔥`
  ].map(v => v.slice(0, 100));
  const customKeywords = String(keywords).split(',').map(v => v.trim()).filter(Boolean);
  const tags = [...new Set([game.toLowerCase(), 'script', 'roblox', 'sem key', 'mobile', 'pc', 'auto farm', 'hack roblox', '2026', ...customKeywords])];
  const description = `🔥 NOVO SCRIPT DE ${game} FUNCIONANDO EM 2026!\n\nConfira o vídeo completo com ${action || 'as melhores funções'}, compatível com ${device}.\n\n👍 Deixe o like e se inscreva para receber mais vídeos de ${game}.\n\n#roblox #script #${game.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
  res.json({ title: titles[0], titles, description, tags: tags.join(', ') });
});

app.post('/api/generate-legacy', async (req, res) => {
  const { topic = '', keywords = '', tone = 'viral' } = req.body || {};
  const base = topic.trim() || 'Seu vídeo';
  const kw = keywords.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);
  const suffix = tone === 'seo' ? 'Guia Completo' : tone === 'clean' ? 'Passo a Passo' : 'Você Precisa Ver Isso';
  res.json({
    title: `${base} — ${suffix}`.slice(0, 100),
    description: `Neste vídeo você vai descobrir ${base.toLowerCase()}.\n\n${kw.length ? 'Palavras-chave: ' + kw.join(', ') + '\n\n' : ''}Inscreva-se no canal e ative as notificações para não perder os próximos vídeos.`,
    tags: [...kw, base, 'youtube', 'video'].filter(Boolean).join(', ')
  });
});

function mapVisibility(v) {
  const x = String(v || '').toLowerCase();
  if (x.includes('não') || x.includes('nao') || x === 'unlisted') return 'unlisted';
  if (x.includes('priv') || x === 'private') return 'private';
  return 'public';
}

app.post('/api/youtube/upload', requireAuth, upload.single('video'), async (req, res) => {
  const tmpPath = req.file?.path;
  try {
    if (!hasGoogleConfig()) return res.status(503).json({ error: 'Google OAuth ainda não foi configurado no arquivo .env.' });
    if (!req.file) return res.status(400).json({ error: 'Selecione um vídeo.' });
    let account;
    if (req.body.accountId) {
      account = getAccountByUserAndId(req.session.userId, String(req.body.accountId));
      if (!account) return res.status(403).json({ error: 'Este canal não pertence à sua conta.' });
    } else {
      account = getDefaultAccountForUser(req.session.userId);
    }
    if (!account) return res.status(400).json({ error: 'Selecione um canal conectado para o envio.' });

    const title = String(req.body.title || '').trim().slice(0, 100);
    const systemCategory = categoriesConfig[String(req.body.categoryId || 'brainrot')] || categoriesConfig.brainrot;
    const description = systemCategory.description;
    const tags = systemCategory.tags;
    const visibility = mapVisibility(req.body.visibility);
    const date = String(req.body.date || '');
    const time = String(req.body.time || '');
    const notifySubscribers = String(req.body.notify) !== 'false';
    const requestedCategoryId = systemCategory.youtubeCategoryId;
    const youtubeCategoryId = Object.values(categoriesConfig).some(v => v.youtubeCategoryId === requestedCategoryId) ? requestedCategoryId : '20';
    if (!title) return res.status(400).json({ error: 'Informe o título do vídeo.' });

    let publishAt;
    let privacyStatus = visibility;
    if (visibility === 'public' && date && time) {
      const localDate = new Date(`${date}T${time}:00-03:00`);
      if (Number.isNaN(localDate.getTime())) return res.status(400).json({ error: 'Data ou hora inválida.' });
      if (localDate.getTime() <= Date.now() + 60_000) return res.status(400).json({ error: 'Para agendar como público, escolha um horário futuro.' });
      publishAt = localDate.toISOString();
      privacyStatus = 'private';
    }

    const auth = await getAuthenticatedYouTubeClient(account);
    const youtube = google.youtube({ version: 'v3', auth });
    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      notifySubscribers,
      requestBody: {
        snippet: buildYoutubeSnippet({ title, description, tags, youtubeCategoryId }),
        status: {
          privacyStatus,
          ...(publishAt ? { publishAt } : {}),
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        mimeType: req.file.mimetype || 'video/*',
        body: fs.createReadStream(req.file.path)
      }
    });

    res.json({
      ok: true,
      id: response.data.id,
      url: `https://www.youtube.com/watch?v=${response.data.id}`,
      title,
      visibility,
      scheduled: Boolean(publishAt),
      publishAt: publishAt || null,
      accountId: account.accountId,
      channelId: account.channelId
    });
  } catch (err) {
    const detail = err?.response?.data?.error?.message || err?.errors?.[0]?.message || err.message || 'Falha no upload.';
    console.error('YouTube upload:', detail);
    res.status(err?.status || (err?.code && Number.isInteger(err.code) ? err.code : 500)).json({ error: detail, code: err?.code || 'UPLOAD_FAILED' });
  } finally {
    if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'O vídeo ultrapassa o limite local configurado.' });
  }
  const status = err?.status || (err?.code && Number.isInteger(err.code) ? err.code : 400);
  res.status(status).json({ error: err.message || 'Erro na requisição.' });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, '..', 'src', 'index.html')));

const httpServer = app.listen(PORT, () => console.log(`Tube AutoPilot v2 rodando em http://localhost:${PORT}`));

module.exports = { app, server: httpServer };
