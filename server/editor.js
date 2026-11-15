const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  mirror: false,
  resolution: 'original',
  aspectRatio: 'original',
  fit: 'cover',
  crf: 20,
  preset: 'veryfast'
});

const RESOLUTIONS = new Set(['original', '1080p', '720p', '480p']);
const ASPECT_RATIOS = new Set(['original', '9:16', '16:9', '1:1', '4:5']);
const FITS = new Set(['cover', 'contain', 'stretch']);
const PRESETS = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']);
const JOB_STATUSES = new Set(['PENDING', 'PROCESSING', 'DONE', 'ERROR', 'CANCELLED']);
const SHORT_SIDE = { '1080p': 1080, '720p': 720, '480p': 480 };
const RATIO_CANVAS = {
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350]
};

function normalizeSettings(input = {}) {
  const next = { ...DEFAULT_SETTINGS };
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.mirror !== undefined) next.mirror = Boolean(input.mirror);
  const resolution = String(input.resolution || '');
  if (RESOLUTIONS.has(resolution)) next.resolution = resolution;
  const aspectRatio = String(input.aspectRatio || '');
  if (ASPECT_RATIOS.has(aspectRatio)) next.aspectRatio = aspectRatio;
  const fit = String(input.fit || '');
  if (FITS.has(fit)) next.fit = fit;
  const crf = Number(input.crf);
  if (Number.isFinite(crf)) next.crf = Math.max(16, Math.min(30, Math.round(crf)));
  const preset = String(input.preset || '');
  if (PRESETS.has(preset)) next.preset = preset;
  return next;
}

function settingsSignature(settings) {
  return crypto.createHash('sha256').update(JSON.stringify({
    mirror: settings.mirror,
    resolution: settings.resolution,
    aspectRatio: settings.aspectRatio,
    fit: settings.fit,
    crf: settings.crf,
    preset: settings.preset
  })).digest('hex').slice(0, 12);
}

function even(value) {
  const rounded = Math.max(2, Math.round(Number(value) || 0));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function canvasFor(settings) {
  const base = RATIO_CANVAS[settings.aspectRatio];
  if (!base) return null;
  const shortSide = SHORT_SIDE[settings.resolution];
  if (!shortSide) return { width: even(base[0]), height: even(base[1]) };
  const scale = shortSide / Math.min(base[0], base[1]);
  return { width: even(base[0] * scale), height: even(base[1] * scale) };
}

function buildFilter(settings) {
  const filters = [];
  const canvas = canvasFor(settings);
  if (canvas) {
    const { width, height } = canvas;
    if (settings.fit === 'contain') {
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
      filters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
    } else if (settings.fit === 'stretch') {
      filters.push(`scale=${width}:${height}`);
    } else {
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`);
      filters.push(`crop=${width}:${height}`);
    }
  } else if (settings.resolution !== 'original') {
    const shortSide = SHORT_SIDE[settings.resolution];
    filters.push(`scale=w='if(gt(iw,ih),${shortSide},-2)':h='if(gt(iw,ih),-2,${shortSide})'`);
  }
  if (settings.mirror) filters.push('hflip');
  filters.push('setsar=1', 'format=yuv420p');
  return filters.join(',');
}

function outputName(sourceHash, signature) {
  const safeHash = String(sourceHash || '').replace(/[^a-f0-9]/gi, '').slice(0, 16) || 'video';
  return `edited-${safeHash}-${signature}.mp4`;
}

function spawnBinary(bin, args) {
  if (/\.(c|m)?js$/i.test(String(bin || ''))) {
    return spawn(process.execPath, [bin, ...args], { windowsHide: true });
  }
  return spawn(bin, args, { windowsHide: true });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function createEditorService({ inventory, executeJobs = true }) {
  const persistence = require('./persistence');
  const dataDir = persistence.dataDir;
  const editedDir = inventory.editedDir || (process.env.EDITED_VIDEOS_DIR ? path.resolve(process.env.EDITED_VIDEOS_DIR) : path.join(dataDir, 'edited'));
  const settingsPath = process.env.EDITOR_SETTINGS_PATH ? path.resolve(process.env.EDITOR_SETTINGS_PATH) : path.join(dataDir, 'editor-settings.json');
  const jobsPath = process.env.EDITOR_JOBS_PATH ? path.resolve(process.env.EDITOR_JOBS_PATH) : path.join(dataDir, 'editor-jobs.json');

  fs.mkdirSync(editedDir, { recursive: true });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(jobsPath), { recursive: true });

  let jobsWriteQueue = Promise.resolve();
  let settingsWriteQueue = Promise.resolve();
  let activeJobId = null;
  let activeChild = null;
  let pumping = false;

  function readSettings() {
    return normalizeSettings(persistence.readDocument(settingsPath, DEFAULT_SETTINGS));
  }

  function saveSettings(input) {
    const settings = normalizeSettings({ ...readSettings(), ...input });
    settingsWriteQueue = settingsWriteQueue.catch(() => {}).then(async () => {
      persistence.writeDocument(settingsPath, settings);
      await persistence.checkpoint();
    });
    return settingsWriteQueue.then(() => settings);
  }

  function readJobs() {
    return persistence.readDocument(jobsPath, []);
  }

  function updateJobs(mutator) {
    jobsWriteQueue = jobsWriteQueue.catch(() => {}).then(async () => {
      const jobs = readJobs();
      const result = await mutator(jobs);
      persistence.writeDocument(jobsPath, jobs);
      await persistence.checkpoint();
      return result;
    });
    return jobsWriteQueue;
  }

  function ffmpegBin() {
    const explicit = String(process.env.FFMPEG_PATH || '').trim();
    if (explicit) return explicit;
    try { return require('@ffmpeg-installer/ffmpeg').path; } catch {}
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  }

  function ffprobeBin() {
    const explicit = String(process.env.FFPROBE_PATH || '').trim();
    if (explicit) return explicit;
    try { return require('@ffprobe-installer/ffprobe').path; } catch {}
    return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  }

  function binaryAvailable(bin) {
    const value = String(bin || '');
    if (!value) return false;
    if (path.isAbsolute(value) || /[\\/]/.test(value)) return fs.existsSync(value);
    return true;
  }

  function availability() {
    return { ffmpegAvailable: binaryAvailable(ffmpegBin()), ffprobeAvailable: binaryAvailable(ffprobeBin()) };
  }

  function settingsView() {
    const settings = readSettings();
    return { ...settings, signature: settingsSignature(settings), ...availability() };
  }

  function getStats(userId) {
    const items = inventory.readItems().filter(item => item.userId === userId);
    const count = status => items.filter(item => item.editorStatus === status).length;
    return {
      total: items.length,
      done: count('DONE'),
      processing: count('PROCESSING'),
      pending: count('PENDING'),
      errors: count('ERROR'),
      cancelled: count('CANCELLED')
    };
  }

  function getJobsForUser(userId, status = '') {
    const normalizedStatus = String(status || '').toUpperCase();
    return readJobs()
      .filter(job => job.userId === userId && (!normalizedStatus || job.status === normalizedStatus))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  function getJob(jobId) {
    return readJobs().find(job => job.id === jobId) || null;
  }

  function previewPath(item, original = false) {
    if (!item) return null;
    if (original) return inventory.physicalPath(item);
    const edited = inventory.editedPath(item);
    return edited && fs.existsSync(edited) ? edited : null;
  }

  function probeVideo(file) {
    return new Promise((resolve, reject) => {
      const child = spawnBinary(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) {
          const detail = String(stderr).trim().slice(-500);
          return reject(new Error(detail || 'O ffprobe não conseguiu analisar o vídeo.'));
        }
        let data;
        try { data = JSON.parse(stdout); }
        catch { return reject(new Error('O ffprobe retornou uma resposta inválida.')); }
        const streams = data.streams || [];
        const video = streams.find(stream => stream.codec_type === 'video');
        if (!video) return reject(new Error('O arquivo não possui uma faixa de vídeo.'));
        let width = Number(video.width || 0);
        let height = Number(video.height || 0);
        const rotationValue = video.tags?.rotate ?? video.side_data_list?.find(entry => entry.rotation !== undefined)?.rotation ?? 0;
        const rotation = Number(rotationValue || 0);
        if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
        if (!width || !height) return reject(new Error('Não foi possível identificar a resolução do vídeo.'));
        resolve({
          width,
          height,
          duration: Number(data.format?.duration || video.duration || 0),
          hasAudio: streams.some(stream => stream.codec_type === 'audio')
        });
      });
    });
  }

  function patchItemsForJob(job, patch) {
    if (!job?.inventoryIds?.length) return Promise.resolve();
    return inventory.mutateItems(items => {
      for (const id of job.inventoryIds) {
        const item = items.find(v => v.id === id);
        if (!item) continue;
        Object.assign(item, patch);
      }
    });
  }

  function pendingPatch(job) {
    return {
      editorStatus: job.status === 'PROCESSING' ? 'PROCESSING' : 'PENDING',
      editorProgress: Number(job.progress || 0),
      editorError: job.status === 'ERROR' ? job.error || null : null,
      editorJobId: job.id
    };
  }

  function donePatch(job) {
    return {
      editedFilePath: job.outputFile,
      editedSourceHash: job.sourceHash,
      editedFileHash: job.outputHash || null,
      editedAt: job.finishedAt || new Date().toISOString(),
      editedSize: job.outputSize || null,
      editorStatus: 'DONE',
      editorProgress: 100,
      editorError: null,
      editorJobId: job.id,
      editorSettingsSignature: job.signature,
      editorSettings: { ...job.settings }
    };
  }

  async function finishDone(jobId, output) {
    let finished = null;
    await updateJobs(jobs => {
      const job = jobs.find(v => v.id === jobId);
      if (!job) return;
      job.status = 'DONE';
      job.progress = 100;
      job.error = null;
      job.finishedAt = new Date().toISOString();
      job.cancelRequested = false;
      job.outputFile = output.outputFile;
      job.outputSize = output.outputSize;
      job.outputHash = output.outputHash;
      finished = { ...job };
    });
    if (!finished) return;
    await inventory.mutateItems(items => {
      for (const id of finished.inventoryIds || []) {
        const item = items.find(v => v.id === id);
        if (!item) continue;
        if (finished.sourceHash && item.fileHash && item.fileHash !== finished.sourceHash) continue;
        Object.assign(item, donePatch(finished));
      }
    });
    console.log(`[editor] concluído job=${jobId} arquivo=${output.outputFile}`);
  }

  async function failJob(jobId, message) {
    let failed = null;
    await updateJobs(jobs => {
      const job = jobs.find(v => v.id === jobId);
      if (!job) return;
      job.status = 'ERROR';
      job.error = message;
      job.progress = Math.min(99, Number(job.progress || 0));
      job.finishedAt = new Date().toISOString();
      job.cancelRequested = false;
      failed = { ...job };
    });
    if (failed) await patchItemsForJob(failed, { editorStatus: 'ERROR', editorProgress: failed.progress, editorError: message, editorJobId: failed.id });
    console.error(`[editor] erro job=${jobId}: ${message}`);
  }

  async function finishCancelled(jobId) {
    let cancelled = null;
    await updateJobs(jobs => {
      const job = jobs.find(v => v.id === jobId);
      if (!job) return;
      job.status = 'CANCELLED';
      job.progress = Number(job.progress || 0);
      job.error = null;
      job.finishedAt = new Date().toISOString();
      job.cancelRequested = false;
      cancelled = { ...job };
    });
    if (cancelled) await patchItemsForJob(cancelled, { editorStatus: 'CANCELLED', editorProgress: cancelled.progress, editorError: null, editorJobId: cancelled.id });
  }

  async function processJob(jobId) {
    let job = readJobs().find(v => v.id === jobId);
    if (!job || job.status !== 'PENDING') return;

    const startedAt = new Date().toISOString();
    const attempts = Number(job.attempts || 0) + 1;
    await updateJobs(jobs => {
      const current = jobs.find(v => v.id === jobId);
      if (!current || current.cancelRequested) return;
      current.status = 'PROCESSING';
      current.progress = 0;
      current.startedAt = startedAt;
      current.finishedAt = null;
      current.error = null;
      current.attempts = attempts;
    });
    job = readJobs().find(v => v.id === jobId);
    if (!job || job.cancelRequested || job.status === 'CANCELLED') {
      await finishCancelled(jobId);
      return;
    }
    await patchItemsForJob(job, { editorStatus: 'PROCESSING', editorProgress: 0, editorError: null, editorJobId: job.id });

    const sourcePath = inventory.physicalPath({ filePath: job.sourceFile });
    if (!fs.existsSync(sourcePath)) {
      await failJob(jobId, 'O arquivo original do vídeo não foi encontrado.');
      return;
    }

    let probe;
    try { probe = await probeVideo(sourcePath); }
    catch (error) {
      await failJob(jobId, `Não foi possível analisar o vídeo: ${error.message}`);
      return;
    }

    const afterProbe = readJobs().find(v => v.id === jobId);
    if (!afterProbe || afterProbe.cancelRequested || afterProbe.status === 'CANCELLED') {
      await finishCancelled(jobId);
      return;
    }

    const settings = normalizeSettings(job.settings);
    const filter = buildFilter(settings);
    const outputFile = job.outputFile || outputName(job.sourceHash, job.signature);
    const outputPath = path.join(editedDir, outputFile);
    await fs.promises.mkdir(editedDir, { recursive: true });
    await fs.promises.unlink(outputPath).catch(() => {});

    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', sourcePath,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', filter,
      '-c:v', 'libx264', '-preset', settings.preset, '-crf', String(settings.crf),
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      outputPath
    ];

    let lastProgress = -1;
    let lastProgressAt = 0;
    let stderr = '';
    let child;
    try { child = spawnBinary(ffmpegBin(), args); }
    catch (error) {
      await failJob(jobId, `Não foi possível iniciar o FFmpeg: ${error.message}`);
      return;
    }
    activeChild = child;
    let controlBusy = false;
    const controlTimer = persistence.shared() ? setInterval(async () => {
      if (controlBusy) return;
      controlBusy = true;
      try {
        const latest = (await persistence.readLatestDocument(jobsPath, [])).find(value => value.id === jobId);
        if (!latest || latest.cancelRequested || latest.status === 'CANCELLED') child.kill();
      } catch { child.kill(); }
      finally { controlBusy = false; }
    }, 1000) : null;

    const result = await new Promise(resolve => {
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          const separator = line.indexOf('=');
          if (separator < 0) continue;
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1);
          if (key !== 'out_time_ms' && key !== 'out_time_us') continue;
          const seconds = Number(value) / 1_000_000;
          if (!Number.isFinite(seconds) || !probe.duration) continue;
          const progress = Math.max(0, Math.min(99, Math.floor((seconds / probe.duration) * 100)));
          if (progress <= lastProgress && progress < 99) continue;
          if (Date.now() - lastProgressAt < 1000 && progress < 99) continue;
          lastProgress = progress;
          lastProgressAt = Date.now();
          updateJobs(jobs => {
            const current = jobs.find(v => v.id === jobId);
            if (current && current.status === 'PROCESSING') current.progress = progress;
          }).catch(() => {});
          inventory.mutateItems(items => {
            for (const id of job.inventoryIds || []) {
              const item = items.find(v => v.id === id);
              if (item && item.editorStatus === 'PROCESSING') item.editorProgress = progress;
            }
          }).catch(() => {});
        }
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.on('error', error => resolve({ error }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    clearInterval(controlTimer);
    activeChild = null;
    const current = readJobs().find(v => v.id === jobId);
    if (current?.cancelRequested || current?.status === 'CANCELLED') {
      await fs.promises.unlink(outputPath).catch(() => {});
      await finishCancelled(jobId);
      return;
    }

    if (result.error || result.code !== 0) {
      await fs.promises.unlink(outputPath).catch(() => {});
      const detail = String(result.error?.message || stderr || '').trim().slice(-600);
      await failJob(jobId, detail ? `Falha ao editar o vídeo: ${detail}` : 'Falha ao editar o vídeo.');
      return;
    }

    let stat;
    try { stat = await fs.promises.stat(outputPath); }
    catch {
      await failJob(jobId, 'O FFmpeg terminou, mas o arquivo editado não foi encontrado.');
      return;
    }
    if (!stat.size) {
      await fs.promises.unlink(outputPath).catch(() => {});
      await failJob(jobId, 'O FFmpeg gerou um arquivo editado vazio.');
      return;
    }

    const outputHash = await hashFile(outputPath);
    await finishDone(jobId, { outputFile, outputSize: stat.size, outputHash });
  }

  function pump() {
    if (!executeJobs) return;
    if (pumping || activeJobId) return;
    const next = readJobs()
      .filter(job => job.status === 'PENDING')
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
    if (!next) return;
    pumping = true;
    activeJobId = next.id;
    processJob(next.id)
      .catch(async error => {
        console.error('[editor] worker:', error);
        await failJob(next.id, `Erro interno no editor: ${error.message}`);
      })
      .finally(() => {
        activeJobId = null;
        activeChild = null;
        pumping = false;
        setTimeout(pump, 100);
      });
  }

  async function enqueueMany(items, { manual = false, force = false } = {}) {
    const list = Array.isArray(items) ? items : [];
    const settings = readSettings();
    if (!manual && !settings.enabled) return { queued: 0, reused: 0, skipped: list.length, jobs: [] };
    const signature = settingsSignature(settings);
    const prepared = [];
    let skipped = 0;

    for (const item of list) {
      if (!item?.id || !item.filePath || !['AVAILABLE', 'ERROR'].includes(item.status)) { skipped += 1; continue; }
      const sourcePath = inventory.physicalPath(item);
      if (!fs.existsSync(sourcePath)) { skipped += 1; continue; }
      let sourceHash = item.fileHash;
      if (!sourceHash) {
        try { sourceHash = await hashFile(sourcePath); }
        catch { skipped += 1; continue; }
      }
      prepared.push({ item, sourceHash, sourcePath });
    }

    if (!prepared.length) return { queued: 0, reused: 0, skipped, jobs: [] };

    const itemPatches = new Map();
    const touchedJobs = new Map();
    let queued = 0;
    let reused = 0;

    await updateJobs(jobs => {
      for (const { item, sourceHash } of prepared) {
        const edited = inventory.editedPath(item);
        const alreadyDone = !force && item.editedFilePath && item.editedSourceHash === sourceHash && item.editorSettingsSignature === signature && edited && fs.existsSync(edited);
        if (alreadyDone) {
          itemPatches.set(item.id, donePatch({ ...item, outputFile: path.basename(item.editedFilePath), outputHash: item.editedFileHash, outputSize: item.editedSize, finishedAt: item.editedAt, signature, settings: item.editorSettings || settings, sourceHash }));
          reused += 1;
          continue;
        }

        let job = jobs.find(candidate => candidate.userId === item.userId && candidate.sourceHash === sourceHash && candidate.signature === signature);
        if (job && job.status === 'DONE' && !force) {
          const outputPath = job.outputFile ? path.join(editedDir, job.outputFile) : null;
          if (outputPath && fs.existsSync(outputPath)) {
            if (!job.inventoryIds.includes(item.id)) job.inventoryIds.push(item.id);
            itemPatches.set(item.id, donePatch(job));
            touchedJobs.set(job.id, job);
            reused += 1;
            continue;
          }
          job.status = 'PENDING';
          job.outputFile = null;
          job.outputHash = null;
          job.outputSize = null;
        }

        if (!job) {
          job = {
            id: crypto.randomUUID(),
            userId: item.userId,
            inventoryIds: [],
            sourceFile: item.filePath,
            sourceHash,
            signature,
            settings: { ...settings },
            status: 'PENDING',
            progress: 0,
            error: null,
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            attempts: 0,
            outputFile: null,
            outputSize: null,
            outputHash: null,
            cancelRequested: false
          };
          jobs.push(job);
        }

        if (!job.inventoryIds.includes(item.id)) job.inventoryIds.push(item.id);
        if (force || job.status === 'ERROR' || job.status === 'CANCELLED' || job.status === 'DONE') {
          job.status = 'PENDING';
          job.progress = 0;
          job.error = null;
          job.finishedAt = null;
          job.cancelRequested = false;
        }
        if (!job.sourceFile) job.sourceFile = item.filePath;
        job.settings = { ...settings };
        itemPatches.set(item.id, pendingPatch(job));
        touchedJobs.set(job.id, job);
        queued += 1;
      }
    });

    if (itemPatches.size) {
      await inventory.mutateItems(items => {
        for (const item of items) {
          const patch = itemPatches.get(item.id);
          if (patch) Object.assign(item, patch);
          if (prepared.some(entry => entry.item.id === item.id && !item.fileHash)) {
            item.fileHash = prepared.find(entry => entry.item.id === item.id).sourceHash;
          }
        }
      });
    }

    if (queued) pump();
    return { queued, reused, skipped, jobs: [...touchedJobs.values()] };
  }

  async function cancelJob(jobId) {
    let job = null;
    await updateJobs(jobs => {
      const current = jobs.find(v => v.id === jobId);
      if (!current) return;
      if (current.status === 'PROCESSING') current.cancelRequested = true;
      else if (current.status === 'PENDING') {
        current.status = 'CANCELLED';
        current.finishedAt = new Date().toISOString();
      }
      job = { ...current };
    });
    if (!job) return null;
    if (job.status === 'PROCESSING' && activeJobId === jobId && activeChild) {
      activeChild.kill();
    } else if (job.status === 'CANCELLED') {
      await patchItemsForJob(job, { editorStatus: 'CANCELLED', editorProgress: job.progress || 0, editorError: null, editorJobId: job.id });
    }
    return job;
  }

  async function retryJob(jobId) {
    let job = null;
    let invalid = null;
    await updateJobs(jobs => {
      const current = jobs.find(v => v.id === jobId);
      if (!current) return;
      if (!['ERROR', 'CANCELLED'].includes(current.status)) { invalid = current.status; return; }
      current.status = 'PENDING';
      current.progress = 0;
      current.error = null;
      current.startedAt = null;
      current.finishedAt = null;
      current.cancelRequested = false;
      current.attempts = Number(current.attempts || 0) + 1;
      job = { ...current };
    });
    if (!job) {
      if (invalid) throw Object.assign(new Error('Somente trabalhos com erro ou cancelados podem ser repetidos.'), { status: 409 });
      return null;
    }
    await patchItemsForJob(job, { editorStatus: 'PENDING', editorProgress: 0, editorError: null, editorJobId: job.id });
    pump();
    return job;
  }

  async function start() {
    await updateJobs(jobs => {
      for (const job of jobs) {
        if (job.status === 'PROCESSING') {
          job.status = job.cancelRequested ? 'CANCELLED' : 'PENDING';
          job.progress = 0;
          job.error = null;
          job.startedAt = null;
          job.cancelRequested = false;
        }
      }
    });
    const recoveredJobs = readJobs();
    await inventory.mutateItems(items => {
      for (const item of items) {
        const job = recoveredJobs.find(value => value.id === item.editorJobId);
        if (['PROCESSING', 'PENDING'].includes(item.editorStatus) && job?.status === 'DONE') {
          Object.assign(item, donePatch(job));
        } else if (item.editorStatus === 'PROCESSING') {
          item.editorStatus = ['CANCELLED', 'ERROR'].includes(job?.status) ? job.status : 'PENDING';
          item.editorProgress = 0;
          item.editorError = job?.status === 'ERROR' ? job.error || null : null;
        }
      }
    });
    pump();
  }

  return {
    editedDir,
    settingsPath,
    jobsPath,
    readSettings,
    saveSettings,
    settingsView,
    settingsSignature,
    getStats,
    getJobsForUser,
    getJob,
    previewPath,
    enqueueMany,
    cancelJob,
    retryJob,
    start,
    processNext: async () => {
      await start();
      const next = readJobs().filter(job => job.status === 'PENDING').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (next) await processJob(next.id);
      await jobsWriteQueue;
    },
    stop: () => { if (activeChild) activeChild.kill(); },
    buildFilter,
    outputName
  };
}

function publicJob(job, items) {
  if (!job) return null;
  const byId = new Map((items || []).map(item => [item.id, item]));
  return {
    id: job.id,
    status: job.status,
    progress: Number(job.progress || 0),
    error: job.error || null,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    attempts: Number(job.attempts || 0),
    outputFile: job.outputFile || null,
    outputSize: job.outputSize || null,
    signature: job.signature || null,
    settings: {
      mirror: Boolean(job.settings?.mirror),
      resolution: job.settings?.resolution || 'original',
      aspectRatio: job.settings?.aspectRatio || 'original',
      fit: job.settings?.fit || 'cover'
    },
    items: (job.inventoryIds || []).map(id => {
      const item = byId.get(id);
      if (!item) return { id, missing: true };
      return {
        id: item.id,
        title: item.title || item.originalFilename || 'Vídeo',
        originalFilename: item.originalFilename || null,
        contentType: item.contentType || 'LONG',
        status: item.status || null,
        hasEdited: Boolean(item.editedFilePath)
      };
    })
  };
}

function createEditorRouter({ editor, inventory }) {
  const router = express.Router();
  const userId = req => req.session.userId;

  function ownedJob(req) {
    const job = editor.getJob(req.params.id);
    if (!job || job.userId !== userId(req)) {
      const error = new Error('Trabalho de edição não encontrado.');
      error.status = 404;
      throw error;
    }
    return job;
  }

  router.get('/settings', (req, res) => {
    res.json({ ...editor.settingsView(), stats: editor.getStats(userId(req)) });
  });

  router.put('/settings', async (req, res, next) => {
    try {
      await editor.saveSettings(req.body || {});
      res.json({ ...editor.settingsView(), stats: editor.getStats(userId(req)) });
    } catch (error) { next(error); }
  });

  router.get('/jobs', (req, res) => {
    const items = inventory.readItems();
    const jobs = editor.getJobsForUser(userId(req), req.query.status).slice(0, 200).map(job => publicJob(job, items));
    res.json({ jobs, stats: editor.getStats(userId(req)) });
  });

  router.get('/jobs/:id', (req, res, next) => {
    try {
      const job = ownedJob(req);
      res.json(publicJob(job, inventory.readItems()));
    } catch (error) { next(error); }
  });

  router.post('/jobs/:id/retry', async (req, res, next) => {
    try {
      const job = ownedJob(req);
      const retried = await editor.retryJob(job.id);
      res.json(publicJob(retried || editor.getJob(job.id), inventory.readItems()));
    } catch (error) { next(error); }
  });

  router.post('/jobs/:id/cancel', async (req, res, next) => {
    try {
      const job = ownedJob(req);
      const cancelled = await editor.cancelJob(job.id);
      res.json(publicJob(cancelled || editor.getJob(job.id), inventory.readItems()));
    } catch (error) { next(error); }
  });

  router.post('/process', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
      const force = Boolean(req.body?.force);
      let items = inventory.readItems().filter(item => item.userId === userId(req));
      if (ids) items = items.filter(item => ids.includes(item.id));
      const result = await editor.enqueueMany(items, { manual: true, force });
      res.json({
        queued: result.queued,
        reused: result.reused,
        skipped: result.skipped,
        jobs: result.jobs.map(job => publicJob(job, inventory.readItems()))
      });
    } catch (error) { next(error); }
  });

  router.get('/preview/:inventoryId', (req, res, next) => {
    try {
      const item = inventory.readItems().find(v => v.id === req.params.inventoryId && v.userId === userId(req));
      if (!item) return res.status(404).json({ error: 'Vídeo não encontrado.' });
      const filePath = editor.previewPath(item, req.query.original === '1');
      if (!filePath) return res.status(404).json({ error: 'Este vídeo ainda não foi editado.' });
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(filePath);
    } catch (error) { next(error); }
  });

  router.use((error, req, res, next) => {
    console.error('editor:', error);
    res.status(error.status || 400).json({ error: error.message || 'Falha no editor de vídeos.' });
  });

  return router;
}

module.exports = { createEditorService, createEditorRouter, DEFAULT_SETTINGS, normalizeSettings, buildFilter, settingsSignature };
