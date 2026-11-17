const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVICES = {
  web: {
    entry: 'server/server.js',
    lockPortEnv: 'TUBE_AUTOPILOT_WEB_LOCK_PORT',
    lockPort: 43110,
    portEnv: 'TUBE_AUTOPILOT_PORT',
    port: '3000'
  },
  worker: {
    entry: 'server/local-worker.js',
    lockPortEnv: 'TUBE_AUTOPILOT_WORKER_LOCK_PORT',
    lockPort: 43111
  }
};

function parseArgs(argv) {
  let service;
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--service') service = argv[++index];
    else if (argv[index] === '--root') root = argv[++index];
  }
  return { service, root: path.resolve(root) };
}

function fail(message, code = 1) {
  console.error(`[supervisor] ${message}`);
  process.exit(code);
}

const { service, root } = parseArgs(process.argv.slice(2));
const config = SERVICES[service];
if (!config) fail('Informe --service web ou --service worker.');
const codeRoot = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(codeRoot, 'package.json'))) fail(`Pasta do projeto inválida: ${codeRoot}.`);

const lockPort = Number(process.env[config.lockPortEnv] || config.lockPort);
if (!Number.isInteger(lockPort) || lockPort < 1 || lockPort > 65535) fail('Porta de travamento inválida.');

const logDir = path.join(root, 'logs', 'windows');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `${service}.log`);

function rotateLog(file) {
  try {
    if (fs.statSync(file).size < 10 * 1024 * 1024) return;
    const previous = `${file}.1`;
    fs.rmSync(previous, { force: true });
    fs.renameSync(file, previous);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[supervisor] não foi possível girar o log: ${error.message}`);
  }
}

rotateLog(logPath);
const logFd = fs.openSync(logPath, 'a');
function write(message) {
  fs.writeSync(logFd, `[${new Date().toISOString()}] [${service}] ${message}\n`);
}

let child = null;
let stopping = false;
let finished = false;
let attempt = 0;
let startedAt = 0;
let restartTimer = null;

function childEnvironment() {
  const env = { ...process.env };
  env.PERSISTENCE_DRIVER = 'local';
  env.HOST = '127.0.0.1';
  if (service === 'web') env.PORT = String(process.env[config.portEnv] || config.port);
  return env;
}

function pipeWithPrefix(stream, label) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) if (line) write(`${label}: ${line}`);
  });
  stream.on('end', () => {
    if (buffer) write(`${label}: ${buffer}`);
    buffer = '';
  });
}

function scheduleRestart() {
  if (stopping || restartTimer) return;
  const base = Math.max(1000, Number(process.env.TUBE_AUTOPILOT_RESTART_DELAY_MS || 5000));
  const maximum = Math.max(base, Number(process.env.TUBE_AUTOPILOT_MAX_RESTART_DELAY_MS || 60000));
  const delay = Math.min(maximum, base * (2 ** Math.min(Math.max(attempt - 1, 0), 6)));
  write(`Reiniciando em ${delay} ms (tentativa ${attempt + 1}).`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startChild();
  }, delay);
}

function startChild() {
  if (stopping) return;
  attempt += 1;
  const entry = path.join(codeRoot, config.entry);
  write(`Iniciando ${config.entry} (tentativa ${attempt}).`);
  child = spawn(process.execPath, [entry], {
    cwd: root,
    env: childEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  startedAt = Date.now();
  write(`Processo filho pid=${child.pid}.`);
  pipeWithPrefix(child.stdout, 'out');
  pipeWithPrefix(child.stderr, 'err');
  child.once('error', error => {
    write(`Falha ao iniciar o processo filho: ${error.message}`);
    child = null;
    scheduleRestart();
  });
  child.once('exit', (code, signal) => {
    write(`Processo filho encerrado pid=${child?.pid ?? '-'} codigo=${code} sinal=${signal || '-'}.`);
    child = null;
    if (stopping) return;
    if (Date.now() - startedAt > 30000) attempt = 0;
    scheduleRestart();
  });
}

function finish() {
  if (finished) return;
  finished = true;
  try { lock.close(); } catch {}
  try { fs.closeSync(logFd); } catch {}
  process.exit(0);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  write(`Recebido ${signal}; encerrando serviço.`);
  if (restartTimer) clearTimeout(restartTimer);
  const target = child;
  if (!target || target.exitCode !== null || target.signalCode !== null) return finish();
  const deadline = setTimeout(() => {
    write('Encerramento forçado após tempo limite.');
    try { target.kill('SIGKILL'); } catch {}
    finish();
  }, 10000);
  target.once('exit', () => {
    clearTimeout(deadline);
    finish();
  });
  try { target.kill('SIGTERM'); } catch {}
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGHUP', () => shutdown('SIGHUP'));

const lock = net.createServer();
lock.on('error', error => {
  if (error.code === 'EADDRINUSE') write('Já existe outra instância deste serviço; encerrando.');
  else write(`Falha na trava local: ${error.message}`);
  try { fs.closeSync(logFd); } catch {}
  process.exit(error.code === 'EADDRINUSE' ? 3 : 1);
});
lock.listen({ host: '127.0.0.1', port: lockPort, exclusive: true }, () => {
  write(`Trava local adquirida na porta ${lockPort}.`);
  startChild();
});
