const path = require('node:path');
const { dataDir, readDocument, writeDocument, shared } = require('./persistence');
const { categoriesConfig } = require('./categories');
const metadataPath = process.env.METADATA_PATH ? path.resolve(process.env.METADATA_PATH) : path.join(dataDir, 'metadata-overrides.json');
function read() { return readDocument(metadataPath, {}); }
function refresh() {
  if (shared()) return;
  const overrides = read();
  for (const [id, override] of Object.entries(overrides)) if (categoriesConfig[id]) Object.assign(categoriesConfig[id], override);
}
function save(value) { writeDocument(metadataPath, value); if (!shared()) refresh(); }
module.exports = { read, save, refresh };
