// Religação dos vídeos do SHADOW CLIENT que ficaram "Sem canal" após a migração multi-canal.
//
// Contexto: a migração de dados (server/oauth-store.js) removeu uma conta órfã do SHADOW CLIENT
// e zerou o vínculo (accountId/channelId) dos 138 vídeos dela. A conta foi reconectada depois com
// um novo UUID, mas os vídeos nunca foram religados. Este script religa esses itens ao canal
// SHADOW CLIENT atual, seguindo as mesmas regras do endpoint /api/inventory/actions/assign-account.
//
// Uso:
//   node scripts/relink-shadow-client.js --dry-run   # simula e reporta, sem gravar nada
//   node scripts/relink-shadow-client.js             # aplica (recomendado com o servidor parado)
//
// Varredura (com verificação dupla):
//   - Fonte dos IDs: data/backups/2026-08-30T23-12-26-488Z/inventory.json (accountId legado do SHADOW).
//   - Destino: conta atual do SHADOW CLIENT no oauth-accounts.json (resolvida pelo channelId).
//   - Somente itens que continuam "Sem canal" (accountId/channelId vazios) são religados.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const INVENTORY_PATH = process.env.INVENTORY_PATH ? path.resolve(process.env.INVENTORY_PATH) : path.join(DATA_DIR, 'inventory.json');
const ACCOUNTS_PATH = process.env.OAUTH_ACCOUNTS_PATH ? path.resolve(process.env.OAUTH_ACCOUNTS_PATH) : path.join(DATA_DIR, 'oauth-accounts.json');
const BACKUP_SOURCE_PATH = path.join(DATA_DIR, 'backups', '2026-08-30T23-12-26-488Z', 'inventory.json');

const OLD_ACCOUNT_ID = 'efae79d9-548e-456a-8aa6-d1a98837e1d0'; // accountId do SHADOW CLIENT no backup (23:12)
const TARGET_CHANNEL_ID = 'UC1dVggWcbupBWdco2_HyfHQ';          // SHADOW CLIENT (canal atual)

const DRY_RUN = process.argv.includes('--dry-run');
const NOW_TAG = new Date().toISOString().replace(/[:.]/g, '-');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}
function backupCurrentData() {
  const backupDir = path.join(path.dirname(INVENTORY_PATH), 'backups', NOW_TAG);
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(INVENTORY_PATH)) fs.copyFileSync(INVENTORY_PATH, path.join(backupDir, 'inventory.json'));
  if (fs.existsSync(ACCOUNTS_PATH)) fs.copyFileSync(ACCOUNTS_PATH, path.join(backupDir, 'oauth-accounts.json'));
  return backupDir;
}

function main() {
  const accounts = readJson(ACCOUNTS_PATH);
  const shadowAccount = accounts.find(account => String(account.channelId) === TARGET_CHANNEL_ID);
  if (!shadowAccount) {
    console.error('[relink] Conta do SHADOW CLIENT não encontrada em OAUTH_ACCOUNTS_PATH. Abortando.');
    process.exit(1);
  }
  const { accountId, userId, channelTitle } = shadowAccount;
  console.log(`[relink] Alvo: ${channelTitle} (accountId=${accountId}, userId=${userId})`);

  if (!fs.existsSync(BACKUP_SOURCE_PATH)) {
    console.error(`[relink] Backup de origem não encontrado: ${BACKUP_SOURCE_PATH}. Abortando.`);
    process.exit(1);
  }
  const backupItems = readJson(BACKUP_SOURCE_PATH);
  const shadowIds = new Set(backupItems.filter(item => String(item.accountId) === OLD_ACCOUNT_ID).map(item => String(item.id)));
  console.log(`[relink] IDs do SHADOW CLIENT encontrados no backup (23:12): ${shadowIds.size}`);

  const items = readJson(INVENTORY_PATH);
  const byId = new Map(items.map(item => [item.id, item]));

  const matched = [];   // itens do backup presentes no inventário atual
  const missing = [];   // IDs do backup que não existem mais no inventário
  for (const id of shadowIds) {
    if (byId.has(id)) matched.push(byId.get(id));
    else missing.push(id);
  }
  console.log(`[relink] Presentes no inventário atual: ${matched.length} | Removidos/inexistentes: ${missing.length}`);

  const toRelink = matched.filter(item => {
    const noAccount = !item.accountId || String(item.accountId) === '';
    const noChannel = !item.channelId || String(item.channelId) === '';
    return noAccount && noChannel;
  });
  const alreadyAssigned = matched.filter(item => !(toRelink.includes(item)));
  console.log(`[relink] "Sem canal" hoje (serão religados): ${toRelink.length} | Já atribuídos a algum canal: ${alreadyAssigned.length}`);

  if (!DRY_RUN && toRelink.length === 0) {
    console.error('[relink] Nada a religar. Abortando.');
    process.exit(1);
  }

  const missingFile = toRelink.filter(item => !item.filePath || !fs.existsSync(item.filePath));
  const statusReport = {};
  const converted = { error: 0, uploading: 0, published: 0 };
  for (const item of toRelink) {
    const before = item.status;
    item.userId = userId;
    item.accountId = accountId;
    item.channelId = TARGET_CHANNEL_ID;
    if (item.status === 'ERROR') {
      item.status = 'AVAILABLE';
      item.error = null;
      converted.error += 1;
    } else {
      statusReport[before] = (statusReport[before] || 0) + 1;
      if (before === 'UPLOADING') converted.uploading += 1;
      if (before === 'PUBLISHED') converted.published += 1;
    }
  }

  if (DRY_RUN) {
    console.log('\n[relink] === DRY-RUN (nada foi gravado) ===');
  } else {
    backupCurrentData();
    writeJsonAtomic(INVENTORY_PATH, items);
    console.log('\n[relink] === APLICADO ===');
    console.log(`[relink] Backup criado em data/backups/${NOW_TAG}/`);
  }

  console.log(`[relink] Vídeos religados: ${toRelink.length}`);
  console.log(`[relink]   ERROR -> AVAILABLE (prontos para reenvio): ${converted.error}`);
  console.log(`[relink]   UPLOADING mantidos: ${converted.uploading} | PUBLISHED mantidos: ${converted.published}`);
  if (Object.keys(statusReport).length) {
    console.log(`[relink]   Demais status mantidos (por status): ${JSON.stringify(statusReport)}`);
  }
  if (missingFile.length) {
    console.warn(`[relink] AVISO: ${missingFile.length} vídeo(s) religado(s) sem arquivo físico no disco (ficarão com erro de arquivo ausente ao tentar enviar).`);
  }
}

main();