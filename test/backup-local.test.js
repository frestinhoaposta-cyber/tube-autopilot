'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyBackup } = require('../scripts/backup-local');

const execFileAsync = promisify(execFile);
const script = path.resolve(__dirname, '..', 'scripts', 'backup-local.js');
const SEGREDO = 'token-de-teste-nao-imprimir';

async function criarFixture(root) {
  await fsp.mkdir(path.join(root, 'data', 'videos'), { recursive: true });
  await fsp.mkdir(path.join(root, 'data', 'backups', 'local', 'antigo'), { recursive: true });
  await fsp.mkdir(path.join(root, 'config'), { recursive: true });
  await fsp.writeFile(path.join(root, 'data', 'inventory.json'), JSON.stringify([
    { id: 'v1', filePath: 'videos/a.mp4', status: 'SCHEDULED', scheduledAt: '2026-11-20T12:00:00.000Z' }
  ]));
  await fsp.writeFile(path.join(root, 'data', 'videos', 'a.mp4'), Buffer.from('video-de-teste'));
  await fsp.writeFile(path.join(root, 'data', 'oauth-accounts.json'), '[]');
  await fsp.writeFile(path.join(root, 'data', 'backups', 'local', 'antigo', 'ignorado.txt'), 'backup anterior');
  await fsp.writeFile(path.join(root, 'config', 'extra-inventory.json'), '[]');
  await fsp.writeFile(path.join(root, '.env'), `TOKEN_ENCRYPTION_KEY=${SEGREDO}\nINVENTORY_PATH=config/extra-inventory.json\n`);
}

async function snapshot(root) {
  const mapa = {};
  async function walk(current, base) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) {
        const bytes = await fsp.readFile(absolute);
        mapa[relative] = crypto.createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  await walk(root, '');
  return mapa;
}

test('backup local copia dados, config e OAuth sem expor segredos nem alterar originais', async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tube-backup-local-'));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const destino = path.join(temp, 'backup');
  await fsp.mkdir(root, { recursive: true });
  await criarFixture(root);
  const antes = await snapshot(root);

  const { stdout } = await execFileAsync(process.execPath, [script, '--dest', destino], {
    cwd: root,
    env: { ...process.env, PERSISTENCE_DRIVER: '' }
  });

  assert.ok(!stdout.includes(SEGREDO), 'o conteúdo do .env não pode aparecer no terminal');
  assert.deepEqual(await snapshot(root), antes, 'os arquivos originais não podem mudar');
  const manifesto = JSON.parse(await fsp.readFile(path.join(destino, 'manifesto.json'), 'utf8'));
  assert.equal(manifesto.arquivos.length, 5);
  assert.equal(manifesto.grupos.dados, 3);
  assert.equal(manifesto.grupos.config, 1);
  assert.equal(manifesto.grupos.extras, 1);
  assert.ok(manifesto.arquivos.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.ok(!manifesto.arquivos.some(entry => entry.caminho.includes('backups/local')));
  assert.ok(fs.existsSync(path.join(destino, 'config', '.env')));
  assert.ok(fs.existsSync(path.join(destino, 'extras', 'inventory.json')));
  assert.ok(fs.existsSync(path.join(destino, 'RESTAURAR.md')));

  const relatorio = await fsp.readFile(path.join(destino, 'RELATORIO-BACKUP.md'), 'utf8');
  assert.match(relatorio, /SHA-256 do conjunto/);
  assert.match(relatorio, /Restauração \(resumo\)/);
  assert.ok(!relatorio.includes(SEGREDO));

  const verificacao = await verifyBackup(destino);
  assert.equal(verificacao.ok, true);
  assert.equal(verificacao.verificados, 5);
  assert.equal(process.exitCode, undefined);
});

test('verificação aponta arquivo alterado no backup', async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tube-backup-verify-'));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const destino = path.join(temp, 'backup');
  await fsp.mkdir(root, { recursive: true });
  await criarFixture(root);

  await execFileAsync(process.execPath, [script, '--dest', destino], {
    cwd: root,
    env: { ...process.env, PERSISTENCE_DRIVER: '' }
  });
  await fsp.appendFile(path.join(destino, 'dados', 'videos', 'a.mp4'), 'alterado');

  const error = await execFileAsync(process.execPath, [script, '--verify', destino], {
    cwd: root,
    env: { ...process.env, PERSISTENCE_DRIVER: '' }
  }).catch(caught => caught);

  assert.equal(error.code, 1);
  assert.match(error.stdout, /FALHOU/);
  assert.match(error.stdout, /SHA-256 divergente/);
  assert.ok(!error.stdout.includes(SEGREDO));
});
