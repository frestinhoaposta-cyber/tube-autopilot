require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const persistence = require('./persistence');

async function exportBackup({ destination, database = persistence.getPool() }) {
  const result = await database.query(`SELECT name, payload, revision FROM ${persistence.documentsTable} ORDER BY name`);
  const documents = result.rows.map(row => ({ name: row.name, revision: row.revision, value: persistence.decode(row.payload) }));
  if (!documents.some(value => value.name === '_migration.json')) throw new Error('Banco não migrado.');
  const payload = persistence.encode({ version: 1, createdAt: new Date().toISOString(), documents });
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, payload, { mode: 0o600, flag: 'wx' });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  fs.writeFileSync(`${destination}.sha256`, `${hash}\n`, { mode: 0o600, flag: 'wx' });
  if (persistence.decode(fs.readFileSync(destination, 'utf8')).documents.length !== documents.length) throw new Error('Backup inválido.');
  return { documents: documents.length, sha256: hash };
}
async function main() {
  persistence.validateEnvironment();
  if (!persistence.shared() || !process.env.BACKUP_PATH) throw new Error('Informe PERSISTENCE_DRIVER=postgres e BACKUP_PATH fora do repositório.');
  const result = await exportBackup({ destination: path.resolve(process.env.BACKUP_PATH) });
  console.log(`Backup criptografado verificado: ${result.documents} documentos. SHA-256: ${result.sha256}`);
}
if (require.main === module) main().catch(() => { console.error('Não foi possível concluir o backup. Verifique o banco e um destino novo.'); process.exitCode = 1; }).finally(() => persistence.close());
module.exports = { exportBackup };
