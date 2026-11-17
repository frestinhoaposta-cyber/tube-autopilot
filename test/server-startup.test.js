const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const entry = path.resolve(__dirname, '../server/server.js');
function environment(root, port) {
  // Não herdar credenciais nem ler o .env real durante a inicialização de teste.
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    NODE_ENV: 'test', PORT: String(port), PERSISTENCE_DRIVER: 'local', DATA_DIR: root,
    SESSION_SECRET: 'sessao-isolada-de-inicializacao', TOKEN_ENCRYPTION_KEY: 'd'.repeat(64),
    INVENTORY_PATH: path.join(root, 'inventory.json'), OAUTH_ACCOUNTS_PATH: path.join(root, 'oauth-accounts.json'),
    COMMENT_SETTINGS_PATH: path.join(root, 'comment-settings.json'), METADATA_PATH: path.join(root, 'metadata-overrides.json'),
    EDITOR_SETTINGS_PATH: path.join(root, 'editor-settings.json'), EDITOR_JOBS_PATH: path.join(root, 'editor-jobs.json'),
    EDITED_VIDEOS_DIR: path.join(root, 'edited')
  };
}
async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('node server/server.js inicia, serve o site e responde health sem iniciar workers', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-startup-'));
  const port = await freePort();
  const child = spawn(process.execPath, [entry], { cwd: root, env: environment(root, port), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) assert.fail(`Servidor encerrou antes de iniciar: ${output}`);
      try { health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); if (health.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(health?.status, 200, output);
    assert.deepEqual(await health.json(), { ok: true, googleConfigured: false });
    const site = await fetch(base);
    assert.equal(site.status, 200);
    assert.match(await site.text(), /<!doctype html>/i);
    assert.equal((await fetch(`${base}/api/auth/accounts`)).status, 401);
    const tiktok = await (await fetch(`${base}/api/tiktok/status`)).json();
    assert.equal(tiktok.configured, false); assert.equal(tiktok.connected, false);
    assert.doesNotMatch(output, /\[scheduler\] started|\[comment\] posting|\[editor\] concluído/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('painel single-user usa userId original e não depende de Supabase', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-single-'));
  const port = await freePort();
  const panelPassword = crypto.randomBytes(24).toString('hex');
  const env = {
    ...environment(root, port),
    AUTH_MODE: 'single',
    SINGLE_USER_ID: 'usuario-original',
    SINGLE_USER_EMAIL: 'dono@local.test',
    PANEL_PASSWORD: panelPassword
  };
  const child = spawn(process.execPath, [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) assert.fail(`Servidor encerrou antes de iniciar: ${output}`);
      try { health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); if (health.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(health?.status, 200, output);
    assert.deepEqual(await (await fetch(`${base}/api/auth/mode`)).json(), { mode: 'single', registrationEnabled: false, email: 'dono@local.test' });
    const register = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'outro@local.test', password: panelPassword }) });
    assert.equal(register.status, 403);
    const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'qualquer@local.test', password: `${panelPassword}-invalida` }) });
    assert.equal(wrong.status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'qualquer@local.test', password: panelPassword }) });
    assert.equal(login.status, 200);
    const user = { id: 'usuario-original', email: 'dono@local.test' };
    assert.deepEqual((await login.json()).user, user);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^connect\.sid=/);
    assert.deepEqual((await (await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } })).json()).user, user);
    const status = await (await fetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } })).text();
    assert.doesNotMatch(status, /refreshToken|accessToken|enc:gcm:/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('modo single-user recusa inicialização sem identificação do usuário', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-single-invalid-'));
  const env = { ...environment(root, 0), AUTH_MODE: 'single', PANEL_PASSWORD: crypto.randomBytes(24).toString('hex') };
  const child = spawn(process.execPath, [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(output, /SINGLE_USER_ID/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('servidor de produção recusa inicialização com persistência JSON local', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-startup-invalid-'));
  const env = { ...environment(root, 0), NODE_ENV: 'production' };
  const child = spawn(process.execPath, [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(output, /Produção exige PERSISTENCE_DRIVER=postgres/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
