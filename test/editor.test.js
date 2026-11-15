const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const {
  createEditorService,
  createEditorRouter,
  DEFAULT_SETTINGS,
  normalizeSettings,
  buildFilter,
  settingsSignature
} = require('../server/editor');

const scriptsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-editor-scripts-'));
const ffmpegScript = path.join(scriptsRoot, 'fake-ffmpeg.js');
const ffprobeScript = path.join(scriptsRoot, 'fake-ffprobe.js');

fs.writeFileSync(ffmpegScript, `
const fs = require('fs');
const args = process.argv.slice(2);
const output = args[args.length - 1];
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_FFMPEG_FAIL === '1') {
  process.stderr.write('erro simulado no ffmpeg');
  process.exit(1);
}
fs.writeFileSync(output, 'edited-video');
process.stdout.write('out_time_ms=5000000\\nprogress=end\\n');
`, 'utf8');

fs.writeFileSync(ffprobeScript, `
console.log(JSON.stringify({
  format: { duration: '10.0', size: '12' },
  streams: [
    { codec_type: 'video', width: 1920, height: 1080 },
    { codec_type: 'audio' }
  ]
}));
`, 'utf8');

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-editor-'));
  const videosDir = path.join(root, 'videos');
  const editedDir = path.join(root, 'edited');
  fs.mkdirSync(videosDir, { recursive: true });
  fs.mkdirSync(editedDir, { recursive: true });
  const items = [];

  process.env.EDITED_VIDEOS_DIR = editedDir;
  process.env.EDITOR_SETTINGS_PATH = path.join(root, 'editor-settings.json');
  process.env.EDITOR_JOBS_PATH = path.join(root, 'editor-jobs.json');
  process.env.FFMPEG_PATH = ffmpegScript;
  process.env.FFPROBE_PATH = ffprobeScript;
  delete process.env.FAKE_FFMPEG_LOG;
  delete process.env.FAKE_FFMPEG_FAIL;

  const inventory = {
    editedDir,
    videosDir,
    readItems: () => items,
    mutateItems: mutator => Promise.resolve().then(() => mutator(items)),
    physicalPath(item) {
      const value = String(item.filePath || '');
      return path.isAbsolute(value) ? value : path.join(videosDir, value);
    },
    editedPath(item) {
      const value = String(item.editedFilePath || '');
      return value ? (path.isAbsolute(value) ? value : path.join(editedDir, value)) : null;
    }
  };

  const editor = createEditorService({ inventory });

  function addItem({ id = 'item-1', content = 'source-video-bytes', title = 'Vídeo de teste' } = {}) {
    const fileName = `${id}.mp4`;
    fs.writeFileSync(path.join(videosDir, fileName), content);
    const item = { id, userId: 'u1', filePath: fileName, status: 'AVAILABLE', contentType: 'LONG', title, originalFilename: fileName };
    items.push(item);
    return item;
  }

  return { root, videosDir, editedDir, items, inventory, editor, addItem };
}

async function waitFor(check, timeout = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Tempo esgotado aguardando a edição.');
}

function jobOf(editor, id) {
  return editor.getJob(id);
}

test('normaliza configurações e limita CRF', () => {
  const settings = normalizeSettings({ enabled: true, mirror: true, resolution: '720p', aspectRatio: '9:16', fit: 'contain', preset: 'fast', crf: 99 });
  assert.equal(settings.resolution, '720p');
  assert.equal(settings.aspectRatio, '9:16');
  assert.equal(settings.fit, 'contain');
  assert.equal(settings.preset, 'fast');
  assert.equal(settings.crf, 30);
  assert.notEqual(settingsSignature(settings), settingsSignature({ ...settings, mirror: false }));
});

test('reinício recupera edição concluída parcialmente e preserva cancelamento solicitado', async () => {
  const harness = makeHarness();
  const done = harness.addItem({ id: 'concluido' });
  const cancelled = harness.addItem({ id: 'cancelado' });
  const interrupted = harness.addItem({ id: 'interrompido' });
  for (const item of [done, cancelled, interrupted]) { item.editorStatus = 'PROCESSING'; item.editorJobId = `job-${item.id}`; }
  fs.writeFileSync(path.join(harness.editedDir, 'concluido.mp4'), 'vídeo editado');
  fs.writeFileSync(harness.editor.jobsPath, JSON.stringify([
    { id: done.editorJobId, status: 'DONE', outputFile: 'concluido.mp4', inventoryIds: [done.id], settings: {} },
    { id: cancelled.editorJobId, status: 'PROCESSING', cancelRequested: true, inventoryIds: [cancelled.id] },
    { id: interrupted.editorJobId, status: 'PROCESSING', cancelRequested: false, inventoryIds: [interrupted.id] }
  ]));
  const restarted = createEditorService({ inventory: harness.inventory, executeJobs: false });
  await restarted.start();
  assert.equal(done.editorStatus, 'DONE');
  assert.equal(done.editedFilePath, 'concluido.mp4');
  assert.equal(done.editorProgress, 100);
  assert.equal(cancelled.editorStatus, 'CANCELLED');
  assert.equal(restarted.getJob(cancelled.editorJobId).status, 'CANCELLED');
  assert.equal(interrupted.editorStatus, 'PENDING');
  assert.equal(restarted.getJob(interrupted.editorJobId).status, 'PENDING');
});

test('monta filtros de enquadramento, resolução e espelhamento', () => {
  assert.equal(
    buildFilter({ ...DEFAULT_SETTINGS, aspectRatio: '9:16', resolution: '720p', mirror: true }),
    'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,hflip,setsar=1,format=yuv420p'
  );
  assert.match(buildFilter({ ...DEFAULT_SETTINGS, aspectRatio: '16:9', fit: 'contain' }), /pad=1920:1080/);
  assert.match(buildFilter({ ...DEFAULT_SETTINGS, resolution: '480p' }), /scale=w='if\(gt\(iw,ih\),480,-2\)'/);
});

test('sem edição habilitada não enfileira; modo manual enfileira', async () => {
  const harness = makeHarness();
  const item = harness.addItem();
  const skipped = await harness.editor.enqueueMany([item]);
  assert.equal(skipped.queued, 0);
  assert.equal(skipped.skipped, 1);

  const queued = await harness.editor.enqueueMany([item], { manual: true });
  assert.equal(queued.queued, 1);
  assert.equal(harness.editor.getJobsForUser('u1').length, 1);
  await waitFor(() => jobOf(harness.editor, queued.jobs[0].id)?.status === 'DONE');
});

test('processa o vídeo, preserva original e reaproveita o resultado', async () => {
  const harness = makeHarness();
  const item = harness.addItem();
  const sourceHash = crypto.createHash('sha256').update('source-video-bytes').digest('hex');
  const logPath = path.join(harness.root, 'ffmpeg.log');
  process.env.FAKE_FFMPEG_LOG = logPath;

  const result = await harness.editor.enqueueMany([item], { manual: true });
  const jobId = result.jobs[0].id;
  await waitFor(() => jobOf(harness.editor, jobId)?.status === 'DONE');
  const job = jobOf(harness.editor, jobId);

  assert.equal(item.editorStatus, 'DONE');
  assert.equal(item.editorProgress, 100);
  assert.equal(item.editedSourceHash, sourceHash);
  assert.ok(item.editedFilePath);
  assert.equal(fs.readFileSync(path.join(harness.editedDir, item.editedFilePath), 'utf8'), 'edited-video');
  assert.equal(fs.readFileSync(path.join(harness.videosDir, item.filePath), 'utf8'), 'source-video-bytes');
  assert.equal(job.outputSize, Buffer.byteLength('edited-video'));

  const args = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).pop());
  assert.ok(args.includes('-vf'));
  assert.ok(args.includes('setsar=1,format=yuv420p'));
  assert.ok(args.includes('-progress'));

  const reused = await harness.editor.enqueueMany([item], { manual: true });
  assert.equal(reused.queued, 0);
  assert.equal(reused.reused, 1);
  assert.equal(harness.editor.getJobsForUser('u1').length, 1);
});

test('marca erro quando o FFmpeg falha', async () => {
  const harness = makeHarness();
  const item = harness.addItem({ id: 'item-fail' });
  process.env.FAKE_FFMPEG_FAIL = '1';
  const result = await harness.editor.enqueueMany([item], { manual: true });
  const jobId = result.jobs[0].id;
  await waitFor(() => jobOf(harness.editor, jobId)?.status === 'ERROR');
  const job = jobOf(harness.editor, jobId);
  assert.match(job.error, /erro simulado/);
  assert.equal(item.editorStatus, 'ERROR');
  assert.equal(item.editedFilePath, undefined);
  delete process.env.FAKE_FFMPEG_FAIL;
});

test('API do editor não vaza campos internos e serve prévia editada e original', async () => {
  const harness = makeHarness();
  const item = harness.addItem({ id: 'item-api' });
  const result = await harness.editor.enqueueMany([item], { manual: true });
  const jobId = result.jobs[0].id;
  await waitFor(() => jobOf(harness.editor, jobId)?.status === 'DONE');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: 'u1' }; next(); });
  app.use('/api/editor', createEditorRouter({ editor: harness.editor, inventory: harness.inventory }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const settings = await fetch(`${base}/api/editor/settings`).then(response => response.json());
    assert.equal(settings.ffmpegAvailable, true);
    assert.equal(settings.ffprobeAvailable, true);

    const jobsResponse = await fetch(`${base}/api/editor/jobs`);
    const jobsText = await jobsResponse.text();
    assert.equal(jobsResponse.status, 200);
    assert.doesNotMatch(jobsText, /sourceFile|sourceHash|outputHash|"userId"/);
    const jobs = JSON.parse(jobsText);
    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].items[0].id, item.id);

    const preview = await fetch(`${base}/api/editor/preview/${item.id}`);
    assert.equal(preview.status, 200);
    assert.equal(await preview.text(), 'edited-video');

    const original = await fetch(`${base}/api/editor/preview/${item.id}?original=1`);
    assert.equal(original.status, 200);
    assert.equal(await original.text(), 'source-video-bytes');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
