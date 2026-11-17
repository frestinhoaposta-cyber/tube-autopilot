const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const repoRoot = path.resolve(__dirname, '..');
const runService = path.join(repoRoot, 'scripts', 'run-service.js');
const localWorker = path.join(repoRoot, 'server', 'local-worker.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function environment(root, port, extra = {}) {
  const packageFile = path.join(root, 'package.json');
  if (!fs.existsSync(packageFile)) fs.writeFileSync(packageFile, '{"name":"tube-autopilot-test","private":true}');
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    NODE_ENV: 'test', PORT: String(port), PERSISTENCE_DRIVER: 'local', DATA_DIR: root,
    SESSION_SECRET: 'sessao-isolada-de-inicializacao', TOKEN_ENCRYPTION_KEY: 'd'.repeat(64),
    INVENTORY_PATH: path.join(root, 'inventory.json'), OAUTH_ACCOUNTS_PATH: path.join(root, 'oauth-accounts.json'),
    COMMENT_SETTINGS_PATH: path.join(root, 'comment-settings.json'), METADATA_PATH: path.join(root, 'metadata-overrides.json'),
    EDITOR_SETTINGS_PATH: path.join(root, 'editor-settings.json'), EDITOR_JOBS_PATH: path.join(root, 'editor-jobs.json'),
    EDITED_VIDEOS_DIR: path.join(root, 'edited'),
    TUBE_AUTOPILOT_PORT: String(port),
    TUBE_AUTOPILOT_RESTART_DELAY_MS: '500',
    TUBE_AUTOPILOT_MAX_RESTART_DELAY_MS: '500',
    ...extra
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

function killTree(pid) {
  if (!pid) return;
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (result.error) process.kill(pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function spawnSupervisor(root, env, service) {
  const child = spawn(process.execPath, [runService, '--service', service, '--root', root], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  return { child, exited: once(child, 'exit') };
}

async function waitForMatch(file, regex, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let content = '';
  while (Date.now() < deadline) {
    try { content = fs.readFileSync(file, 'utf8'); const match = content.match(regex); if (match) return match; } catch {}
    await delay(50);
  }
  assert.fail(`Log não contém ${regex}. Fim do log: ${content.slice(-1500)}`);
}

async function waitForNewPid(file, known, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let content = '';
  while (Date.now() < deadline) {
    try {
      content = fs.readFileSync(file, 'utf8');
      const pids = [...content.matchAll(/Processo filho pid=(\d+)/g)].map(match => match[1]);
      const fresh = pids.find(pid => !known.includes(pid));
      if (fresh) return fresh;
    } catch {}
    await delay(50);
  }
  assert.fail(`Nenhum novo pid em ${file}. Fim do log: ${content.slice(-1500)}`);
}

async function waitForHealth(base, timeout = 20000, logFile = null) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(50);
  }
  const logTail = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : '';
  assert.fail(`Painel não respondeu: ${lastError?.message}. Log: ${logTail}`);
}

test('supervisor web bloqueia duplicata, libera a trava e reinicia o painel local', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-windows-web-'));
  const port = await freePort();
  const lockPort = await freePort();
  const env = environment(root, port, { TUBE_AUTOPILOT_WEB_LOCK_PORT: String(lockPort) });
  const log = path.join(root, 'logs', 'windows', 'web.log');
  const base = `http://127.0.0.1:${port}`;
  let first;
  let duplicate;
  let third;
  try {
    first = spawnSupervisor(root, env, 'web');
    await waitForMatch(log, /Trava local adquirida/);
    const firstPid = (await waitForMatch(log, /Processo filho pid=(\d+)/))[1];
    assert.equal((await waitForHealth(base, 20000, log)).status, 200);
    assert.match(fs.readFileSync(log, 'utf8'), /rodando em http:\/\/127\.0\.0\.1:/);

    duplicate = spawnSupervisor(root, env, 'web');
    const [code] = await duplicate.exited;
    assert.equal(code, 3);
    assert.match(fs.readFileSync(log, 'utf8'), /Já existe outra instância deste serviço/);

    killTree(first.child.pid);
    killTree(firstPid);
    await first.exited;
    await delay(300);

    third = spawnSupervisor(root, env, 'web');
    await waitForMatch(log, /Trava local adquirida/);
    const thirdPid = await waitForNewPid(log, [firstPid]);
    assert.notEqual(thirdPid, firstPid);
    assert.equal((await waitForHealth(base, 20000, log)).status, 200);
  } finally {
    for (const entry of [first, duplicate, third]) if (entry?.child.exitCode === null) killTree(entry.child.pid);
    const content = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    for (const match of content.matchAll(/Processo filho pid=(\d+)/g)) killTree(match[1]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supervisor reinicia o worker local quando o processo falha', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-windows-worker-'));
  const lockPort = await freePort();
  const env = environment(root, 0, { TUBE_AUTOPILOT_WORKER_LOCK_PORT: String(lockPort) });
  const log = path.join(root, 'logs', 'windows', 'worker.log');
  let supervisor;
  try {
    supervisor = spawnSupervisor(root, env, 'worker');
    await waitForMatch(log, /Trava local adquirida/);
    const firstPid = (await waitForMatch(log, /Processo filho pid=(\d+)/))[1];
    await waitForMatch(log, /\[worker local\] ciclo concluído/);
    killTree(firstPid);
    await waitForMatch(log, /Reiniciando em \d+ ms/);
    const secondPid = await waitForNewPid(log, [firstPid]);
    assert.notEqual(secondPid, firstPid);
    await waitForMatch(log, /\[worker local\] ciclo concluído/);
  } finally {
    if (supervisor?.child.exitCode === null) killTree(supervisor.child.pid);
    const content = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    for (const match of content.matchAll(/Processo filho pid=(\d+)/g)) killTree(match[1]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker local processa agendamentos em JSON sem PostgreSQL ou S3', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-local-worker-'));
  const inventoryPath = path.join(root, 'inventory.json');
  const item = {
    id: crypto.randomUUID(),
    userId: 'usuario-original',
    title: 'Agendamento local',
    status: 'SCHEDULED',
    scheduledAt: new Date(Date.now() - 60000).toISOString(),
    youtubeVideoId: 'video-do-youtube'
  };
  fs.writeFileSync(inventoryPath, JSON.stringify([item], null, 2));
  const child = spawn(process.execPath, [localWorker], {
    cwd: root, env: environment(root, 0), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitForMatch(inventoryPath, new RegExp(`"status": "PUBLISHED"`), 15000).catch(async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !output.includes('ciclo concluído')) await delay(50);
      assert.fail(`Worker não concluiu o ciclo: ${output}`);
    });
    const saved = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    assert.equal(saved[0].status, 'PUBLISHED');
    assert.ok(saved[0].publishedAt);
    assert.doesNotMatch(output, /PERSISTENCE_DRIVER=postgres|S3_BUCKET|TOKEN_ENCRYPTION_KEY/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scripts Windows registram duas tarefas, têm fallback de logon e não apagam dados nem backups', () => {
  const read = name => fs.readFileSync(path.join(repoRoot, 'scripts', 'windows', name), 'utf8');
  const common = read('_common.ps1');
  const install = read('instalar-inicio.ps1');
  const diagnostic = read('diagnostico.ps1');
  const uninstall = read('desinstalar-inicio.ps1');
  const supervisor = fs.readFileSync(runService, 'utf8');
  const worker = fs.readFileSync(localWorker, 'utf8');
  const server = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');

  assert.match(common, /TubeAutoPilot-Web/);
  assert.match(common, /TubeAutoPilot-Worker/);
  assert.match(common, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(common, /function Set-TubeRunEntries/);
  assert.match(install, /Get-Service -Name Schedule/);
  assert.match(install, /Register-ScheduledTask/);
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(install, /Set-TubeRunEntries/);
  assert.match(install, /Start-TubeServicesDirect/);
  assert.match(diagnostic, /Agendador de Tarefas/);
  assert.match(diagnostic, /Registro do usuário/);
  assert.match(install, /MultipleInstances IgnoreNew/);
  assert.match(install, /RestartCount 3/);
  assert.doesNotMatch(install, /Remove-Item|Clear-Content|Set-Content|data\\backups|\.env\s*=/);

  assert.match(uninstall, /Unregister-ScheduledTask/);
  assert.match(uninstall, /Remove-TubeRunEntries/);
  assert.match(uninstall, /Dados, vídeos, chaves, backups e logs foram preservados/);
  assert.doesNotMatch(uninstall, /Remove-Item[^\r\n]*(data|backups|\.env)/);

  assert.match(supervisor, /PERSISTENCE_DRIVER = 'local'/);
  assert.match(supervisor, /HOST = '127\.0\.0\.1'/);
  assert.match(supervisor, /exclusive: true/);
  assert.match(supervisor, /EADDRINUSE/);

  assert.match(worker, /persistence\.shared\(\)\)/);
  assert.match(worker, /\[worker local\] ciclo concluído/);
  assert.match(server, /app\.listen\(PORT, HOST/);

  for (const name of ['_common.ps1', 'instalar-inicio.ps1', 'iniciar-logon.ps1', 'iniciar-servicos.ps1', 'parar-servicos.ps1', 'diagnostico.ps1', 'desinstalar-inicio.ps1']) {
    const bytes = fs.readFileSync(path.join(repoRoot, 'scripts', 'windows', name));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} precisa de BOM para o Windows PowerShell 5.1`);
  }
});
