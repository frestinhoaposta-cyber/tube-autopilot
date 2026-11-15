// Bucket privado: nenhuma URL pública ou credencial é enviada ao navegador.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { dataDir } = require('./persistence');
let client;
const fingerprints = new Map();
function getClient() {
  if (!client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    client = new S3Client({ region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' });
  }
  return client;
}
function portableName(value) { return String(value || '').replace(/\\/g, '/').split('/').pop(); }
function localPath(group, name) {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('Nome de arquivo inválido no armazenamento.');
  const directory = group === 'edited' && process.env.EDITED_VIDEOS_DIR ? path.resolve(process.env.EDITED_VIDEOS_DIR) : path.join(dataDir, group);
  return path.join(directory, name);
}
function references(documents) {
  const refs = new Map();
  const add = (group, value) => { if (value) { const name = portableName(value); refs.set(`${group}/${name}`, localPath(group, name)); } };
  for (const item of documents.get('inventory.json') || []) { add('videos', item.filePath); add('edited', item.editedFilePath); }
  for (const item of documents.get('tiktok-inventory.json') || []) add('tiktok-videos', item.storedName);
  for (const job of documents.get('editor-jobs.json') || []) if (job.status === 'DONE') add('edited', job.outputFile);
  return refs;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function uploadFile(file, hash, s3 = getClient()) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const key = `videos/sha256/${hash}`;
  await new Upload({ client: s3, params: { Bucket: process.env.S3_BUCKET, Key: key, Body: fs.createReadStream(file), Metadata: { sha256: hash } }, queueSize: 2, partSize: 10 * 1024 * 1024, leavePartsOnError: false }).done();
  return key;
}
async function persistMedia(state, { upload = uploadFile } = {}) {
  const manifest = structuredClone(state.documents.get('_media.json') || {});
  let changed = false;
  for (const [logical, file] of references(state.documents)) {
    let stat;
    try { stat = await fs.promises.stat(file); } catch (error) { if (error.code === 'ENOENT' && manifest[logical]) continue; throw error; }
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (manifest[logical] && fingerprints.get(file) === `${manifest[logical].sha256}:${stamp}`) continue;
    const hash = await hashFile(file);
    if (manifest[logical]?.sha256 !== hash) {
      const key = await upload(file, hash);
      if (await hashFile(file) !== hash) throw new Error('O vídeo mudou durante a persistência. A referência não foi confirmada.');
      manifest[logical] = { key, sha256: hash, size: stat.size };
      changed = true;
    }
    fingerprints.set(file, `${hash}:${stamp}`);
  }
  if (changed) { state.documents.set('_media.json', manifest); state.dirty.add('_media.json'); }
}
async function downloadFile(entry, file, s3 = getClient()) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const response = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: entry.key }));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await pipeline(response.Body, new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } }), fs.createWriteStream(temp, { mode: 0o600 }));
    if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('Integridade do vídeo não confere com o manifesto.');
    await fs.promises.rename(temp, file);
  } finally { await fs.promises.unlink(temp).catch(() => {}); }
}
async function hydrateMedia(state, { download = downloadFile } = {}) {
  const manifest = state.documents.get('_media.json') || {};
  for (const [logical, file] of references(state.documents)) {
    const entry = manifest[logical];
    if (!entry) throw new Error(`Vídeo não migrado: ${logical}.`);
    let stat = await fs.promises.stat(file).catch(() => null);
    if (stat && fingerprints.get(file) === `${entry.sha256}:${stat.size}:${stat.mtimeMs}`) continue;
    if (!stat || stat.size !== entry.size || await hashFile(file) !== entry.sha256) await download(entry, file);
    stat = await fs.promises.stat(file);
    fingerprints.set(file, `${entry.sha256}:${stat.size}:${stat.mtimeMs}`);
  }
}
module.exports = { getClient, portableName, localPath, references, hashFile, uploadFile, downloadFile, persistMedia, hydrateMedia };
