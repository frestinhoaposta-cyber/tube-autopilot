'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const EXTRA_PATHS = [
  ['INVENTORY_PATH', 'inventory.json'],
  ['OAUTH_ACCOUNTS_PATH', 'oauth-accounts.json'],
  ['METADATA_PATH', 'metadata-overrides.json'],
  ['COMMENT_SETTINGS_PATH', 'comment-settings.json'],
  ['EDITOR_SETTINGS_PATH', 'editor-settings.json'],
  ['EDITOR_JOBS_PATH', 'editor-jobs.json'],
  ['EDITED_VIDEOS_DIR', 'edited']
];

function isInside(child, parent) {
  const absoluteChild = path.resolve(child);
  const absoluteParent = path.resolve(parent);
  return absoluteChild === absoluteParent || absoluteChild.startsWith(`${absoluteParent}${path.sep}`);
}

function posix(relative) {
  return relative.split(path.sep).join('/');
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${units[index]}`;
}

function timestampId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

async function copyFileWithHash(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256');
  let size = 0;
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    }
  });
  await pipeline(
    fs.createReadStream(source),
    hasher,
    fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  );
  await fsp.chmod(destination, 0o600).catch(() => {});
  return { sha256: hash.digest('hex'), size };
}

async function listTree(root, skipPrefixes = []) {
  const files = [];
  async function walk(current, base) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    for (const entry of entries) {
      if (/[\r\n]/.test(entry.name)) throw new Error('Nome de arquivo inválido para o manifesto.');
      const absolute = path.join(current, entry.name);
      if (skipPrefixes.some(prefix => isInside(absolute, prefix))) continue;
      const relative = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Links simbólicos não são suportados no backup: ${relative}`);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(absolute);
        files.push({ absolute, relative, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(root, '');
  return files;
}

async function collectExtras({ root, dataDir, env }) {
  const jobs = [];
  const used = new Set();
  for (const [key, logical] of EXTRA_PATHS) {
    const value = env[key];
    if (!value || used.has(key)) continue;
    used.add(key);
    const absolute = path.resolve(root, String(value));
    if (!fs.existsSync(absolute) || isInside(absolute, dataDir)) continue;
    const stat = await fsp.stat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Link simbólico configurado em ${key} não é suportado no backup.`);
    if (stat.isDirectory()) {
      const files = await listTree(absolute);
      for (const file of files) {
        jobs.push({
          source: file.absolute,
          sourceLabel: `${key}: ${posix(path.relative(root, absolute))}/${file.relative}`,
          relative: `extras/${logical}/${file.relative}`,
          size: file.size,
          mtimeMs: file.mtimeMs
        });
      }
    } else if (stat.isFile()) {
      jobs.push({
        source: absolute,
        sourceLabel: `${key}: ${posix(path.relative(root, absolute))}`,
        relative: `extras/${logical}`,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
  }
  return jobs;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildRestoreInstructions(summary) {
  const origin = psQuote(summary.destino);
  return `# Restauração local — Tube AutoPilot

A restauração **substitui** arquivos no destino. Use um ambiente de teste ou faça um novo backup antes de sobrescrever uma instalação existente.

## Antes de começar

1. Pare os processos \`node server/server.js\` e \`node server/worker.js\` (ou o serviço equivalente).
2. Confira a integridade do pacote:

\`\`\`powershell
node scripts/backup-local.js --verify ${origin}
\`\`\`

## Restauração dos arquivos

No diretório do projeto, execute no PowerShell:

\`\`\`powershell
$origem = ${origin}
Copy-Item -LiteralPath (Join-Path $origem 'config\\.env') -Destination '.env' -Force
Get-ChildItem -LiteralPath (Join-Path $origem 'dados') -Force | Copy-Item -Destination 'data' -Recurse -Force
\`\`\`

Se o manifesto listar arquivos em \`extras/\`, restaure-os nos caminhos indicados no campo \`origem\` de \`manifesto.json\`.

## Conexões OAuth

- Mantenha o \`.env\` original: \`TOKEN_ENCRYPTION_KEY\` descriptografa os tokens em \`data/oauth-accounts.json\`; sem a mesma chave as contas entram como \`RECONNECT_REQUIRED\`.
- \`YOUTUBE_CLIENT_ID\`/\`YOUTUBE_CLIENT_SECRET\` (e o par \`_2\`) precisam ser os mesmos projetos do Google Cloud. \`TIKTOK_CLIENT_KEY\`/\`TIKTOK_CLIENT_SECRET\` devem ser do mesmo app TikTok.
- \`SESSION_SECRET\` e as variáveis \`SUPABASE_*\` precisam corresponder ao projeto de autenticação usado, pois \`userId\` está vinculado a ele.
- Se o domínio mudou, ajuste os redirect URIs no \`.env\` **e** nos consoles Google/TikTok.

## Depois de restaurar

1. Confira se \`data/inventory.json\`, \`data/videos/\`, \`data/tiktok-inventory.json\` e os JSONs de configuração estão presentes.
2. Inicie com \`npm run dev\` e valide \`GET /api/health\`.
3. Sessões em modo local não são persistidas: faça login novamente.
4. Não execute \`npm run migrate:shared\` nesta restauração local. Esse comando migra dados para Postgres/S3 e transforma os arquivos.
`;
}

function buildReport(summary) {
  const groups = summary.grupos;
  const warnings = summary.avisos.length
    ? summary.avisos.map(item => `- ${item}`).join('\n')
    : '- Nenhum.';
  const exclusions = summary.exclusoes.length
    ? summary.exclusoes.map(item => `- ${item}`).join('\n')
    : '- Nenhuma.';
  return `# Relatório de backup local — Tube AutoPilot

- **Status:** ${summary.status}
- **Criado em:** ${summary.criadoEm}
- **Origem:** \`${summary.origem}\`
- **Destino:** \`${summary.destino}\`
- **Arquivos copiados:** ${summary.arquivos.toLocaleString('pt-BR')}
- **Tamanho total:** ${formatBytes(summary.tamanhoTotalBytes)} (${summary.tamanhoTotalBytes.toLocaleString('pt-BR')} bytes)
- **SHA-256 do conjunto:** \`${summary.sha256Conjunto}\`
- **Verificação:** ${summary.arquivos.toLocaleString('pt-BR')} arquivos recopiados e conferidos por SHA-256; originais conferidos por tamanho/data de modificação antes e depois da cópia.

## Cobertura

| Grupo | Arquivos |
| --- | ---: |
| Pasta \`data/\` (vídeos, agendamentos, configurações e snapshots) | ${groups.dados.toLocaleString('pt-BR')} |
| Configuração \`.env\` (valores nunca exibidos) | ${groups.config.toLocaleString('pt-BR')} |
| Caminhos externos configurados (\`*_PATH\`/\`EDITED_VIDEOS_DIR\`) | ${groups.extras.toLocaleString('pt-BR')} |

## Exclusões

${exclusions}

## Avisos

${warnings}

## Arquivos de verificação

- \`SHA256SUMS.txt\` — SHA-256 de cada arquivo do backup.
- \`SHA256SUMS.sha256\` — SHA-256 do próprio \`SHA256SUMS.txt\` (valor do conjunto).
- \`manifesto.json\` — lista completa com caminho de origem, tamanho e SHA-256.
- \`RESTAURAR.md\` — instruções detalhadas de restauração.

Para validar novamente sem modificar nada:

\`\`\`powershell
node scripts/backup-local.js --verify ${psQuote(summary.destino)}
\`\`\`

## Restauração (resumo)

1. Pare os serviços e execute o comando de verificação acima.
2. Restaure \`config/.env\` para \`.env\` e o conteúdo de \`dados/\` para \`data/\`.
3. Restaure \`extras/\` nos caminhos do manifesto, se houver.
4. Preserve \`TOKEN_ENCRYPTION_KEY\` e as credenciais OAuth do \`.env\`; sem elas as contas precisam ser reconectadas.
5. Inicie com \`npm run dev\` e faça login novamente (sessões locais não são persistidas).
6. Não execute migração/deploy como parte desta restauração local.

Nenhum dado foi enviado a serviços externos e nenhum arquivo original foi alterado ou removido.
`;
}

async function createBackup(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const dataDir = path.resolve(options.dataDir || path.join(root, 'data'));
  const envFile = path.resolve(options.envFile || path.join(root, '.env'));
  const destination = path.resolve(options.destination || path.join(dataDir, 'backups', 'local', timestampId()));
  const includeLocalBackups = Boolean(options.includeLocalBackups);
  const includeExtras = options.includeExtras !== false;
  const env = options.env || {};
  const onProgress = options.onProgress || (() => {});

  const dataStat = await fsp.stat(dataDir).catch(() => null);
  if (!dataStat || !dataStat.isDirectory()) throw new Error('Pasta de dados não encontrada.');
  if (isInside(dataDir, destination)) throw new Error('O destino não pode conter a pasta de dados.');
  if (fs.existsSync(destination)) throw new Error('O destino já existe; escolha outro caminho.');
  if (!fs.existsSync(envFile) || !(await fsp.stat(envFile)).isFile()) throw new Error('Arquivo .env não encontrado; ele é necessário para restaurar OAuth.');

  const exclusions = [];
  const skipPrefixes = [];
  if (isInside(destination, dataDir)) {
    skipPrefixes.push(destination);
    exclusions.push(`${posix(path.relative(dataDir, destination))}/** (destino deste backup)`);
  }
  if (!includeLocalBackups) {
    skipPrefixes.push(path.join(dataDir, 'backups', 'local'));
    exclusions.push('data/backups/local/** (backups locais gerados por este script; use --include-local-backups para incluir)');
  }

  const dataFiles = await listTree(dataDir, skipPrefixes);
  const jobs = dataFiles.map(file => ({
    source: file.absolute,
    sourceLabel: `data/${file.relative}`,
    relative: `dados/${file.relative}`,
    size: file.size,
    mtimeMs: file.mtimeMs,
    group: 'dados'
  }));

  const envStat = await fsp.stat(envFile);
  jobs.push({
    source: envFile,
    sourceLabel: '.env',
    relative: 'config/.env',
    size: envStat.size,
    mtimeMs: envStat.mtimeMs,
    group: 'config'
  });

  if (includeExtras) {
    const extraJobs = await collectExtras({ root, dataDir, env });
    for (const job of extraJobs) jobs.push({ ...job, group: 'extras' });
  }

  const avisos = [];
  const temporarios = jobs.filter(job => job.relative.endsWith('.tmp')).length;
  if (temporarios) avisos.push(`${temporarios} arquivo(s) temporário(s) copiado(s); confirme com os serviços parados.`);

  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = [];
  const problems = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const result = await copyFileWithHash(job.source, path.join(destination, job.relative));
    entries.push({
      caminho: job.relative,
      origem: job.sourceLabel,
      grupo: job.group,
      tamanho: result.size,
      sha256: result.sha256
    });
    onProgress({ done: index + 1, total: jobs.length });
  }

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const entry = entries[index];
    const copied = await hashFile(path.join(destination, entry.caminho));
    if (copied.sha256 !== entry.sha256) problems.push(`Divergência de SHA-256 em ${entry.caminho}.`);
    const current = await fsp.stat(job.source).catch(() => null);
    if (!current || current.size !== job.size || Math.abs(current.mtimeMs - job.mtimeMs) > 2) {
      problems.push(`Arquivo de origem alterado durante a cópia: ${job.sourceLabel}.`);
    }
  }

  const sums = entries.map(entry => `${entry.sha256}  ${entry.caminho}`).sort().join('\n') + '\n';
  await fsp.writeFile(path.join(destination, 'SHA256SUMS.txt'), sums, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const sha256Conjunto = crypto.createHash('sha256').update(sums).digest('hex');
  await fsp.writeFile(path.join(destination, 'SHA256SUMS.sha256'), `${sha256Conjunto}  SHA256SUMS.txt\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

  const counts = {
    dados: entries.filter(entry => entry.grupo === 'dados').length,
    config: entries.filter(entry => entry.grupo === 'config').length,
    extras: entries.filter(entry => entry.grupo === 'extras').length
  };
  const tamanhoTotalBytes = entries.reduce((total, entry) => total + entry.tamanho, 0);
  const summary = {
    status: problems.length ? 'INCOMPLETO' : 'OK',
    criadoEm: new Date().toISOString(),
    origem: root,
    destino: destination,
    arquivos: entries.length,
    tamanhoTotalBytes,
    sha256Conjunto,
    grupos: counts,
    avisos: avisos.concat(problems.map(item => item.trim())),
    exclusoes: exclusions
  };
  const manifest = {
    versao: 1,
    tipo: 'backup-local',
    ...summary,
    arquivos: entries
  };
  await fsp.writeFile(path.join(destination, 'manifesto.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await fsp.writeFile(path.join(destination, 'RELATORIO-BACKUP.md'), buildReport(summary), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await fsp.writeFile(path.join(destination, 'RESTAURAR.md'), buildRestoreInstructions(summary), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return summary;
}

async function verifyBackup(directory) {
  const root = path.resolve(directory);
  const problems = [];
  const sumsPath = path.join(root, 'SHA256SUMS.txt');
  if (!fs.existsSync(sumsPath)) throw new Error('Backup inválido: SHA256SUMS.txt não encontrado.');
  const sums = await fsp.readFile(sumsPath, 'utf8');
  const actualOverall = crypto.createHash('sha256').update(sums).digest('hex');
  const checksumPath = path.join(root, 'SHA256SUMS.sha256');
  const expectedOverall = (await fsp.readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0];
  if (actualOverall !== expectedOverall) problems.push('SHA-256 do arquivo de somas divergente.');

  let verificados = 0;
  const lines = sums.trimEnd().split('\n').filter(Boolean);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) {
      problems.push(`linha inválida em SHA256SUMS.txt: ${line}`);
      continue;
    }
    const [, expected, relative] = match;
    const file = path.resolve(root, relative);
    if (!isInside(file, root)) {
      problems.push(`caminho fora do backup: ${relative}`);
      continue;
    }
    if (!fs.existsSync(file)) {
      problems.push(`arquivo ausente: ${relative}`);
      continue;
    }
    const { sha256 } = await hashFile(file);
    if (sha256 !== expected) problems.push(`SHA-256 divergente: ${relative}`);
    verificados += 1;
  }

  const manifestPath = path.join(root, 'manifesto.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (Array.isArray(manifest.arquivos) && manifest.arquivos.length !== lines.length) {
      problems.push('quantidade de arquivos divergente entre manifesto e SHA256SUMS.txt.');
    }
  }
  return { ok: problems.length === 0, verificados, problemas: problems, sha256Conjunto: actualOverall };
}

function getOption(args, name) {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];
  const prefix = `${name}=`;
  const found = args.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main(argv = process.argv.slice(2)) {
  const verifyPath = getOption(argv, '--verify');
  if (verifyPath) {
    const result = await verifyBackup(verifyPath);
    console.log(`Verificação: ${result.ok ? 'OK' : 'FALHOU'} — ${result.verificados.toLocaleString('pt-BR')} arquivos.`);
    console.log(`SHA-256 do conjunto: ${result.sha256Conjunto}`);
    for (const problem of result.problemas.slice(0, 10)) console.log(`- ${problem}`);
    if (result.problemas.length > 10) console.log(`- ... e mais ${result.problemas.length - 10} problema(s).`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const envPath = path.join(root, '.env');
  const parsed = dotenv.parse(await fsp.readFile(envPath));
  const env = { ...parsed, ...process.env };
  if (env.PERSISTENCE_DRIVER === 'postgres') {
    throw new Error('Modo compartilhado detectado: use npm run backup:shared. Este script é somente para backup local.');
  }
  let lastProgress = 0;
  const summary = await createBackup({
    root,
    dataDir: path.resolve(root, env.DATA_DIR || 'data'),
    destination: getOption(argv, '--dest'),
    envFile: envPath,
    env,
    includeLocalBackups: argv.includes('--include-local-backups'),
    onProgress: ({ done, total }) => {
      if (done - lastProgress >= 100 || done === total) {
        lastProgress = done;
        console.log(`Copiados ${done}/${total} arquivos...`);
      }
    }
  });
  console.log(`Backup local ${summary.status}: ${summary.arquivos.toLocaleString('pt-BR')} arquivos, ${formatBytes(summary.tamanhoTotalBytes)}.`);
  console.log(`SHA-256 do conjunto: ${summary.sha256Conjunto}`);
  console.log(`Relatório: ${path.join(summary.destino, 'RELATORIO-BACKUP.md')}`);
  if (summary.avisos.length) console.log(`Avisos: ${summary.avisos.length} (veja o relatório).`);
  if (summary.status !== 'OK') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Não foi possível concluir o backup: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createBackup, verifyBackup, buildReport, buildRestoreInstructions };
