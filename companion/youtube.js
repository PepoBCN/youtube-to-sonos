// Fetching YouTube audio with yt-dlp into a local MP3 cache.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isVideoId } from './util.js';

export const CACHE_DIR = process.env.YTS_CACHE_DIR || path.join(os.homedir(), 'Library/Caches/youtube-to-sonos');
const YTDLP = process.env.YTS_YTDLP || '/opt/homebrew/bin/yt-dlp';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_BYTES = 2 * 1024 ** 3;
const YTDLP_TIMEOUT_MS = 15 * 60 * 1000;

export const mp3Path = (id) => path.join(CACHE_DIR, `${id}.mp3`);
export const artPath = (id) => path.join(CACHE_DIR, `${id}.jpg`);
const metaPath = (id) => path.join(CACHE_DIR, `${id}.json`);

const jobs = new Map(); // videoId -> Promise<{ file, meta }>

export function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), YTDLP_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't run yt-dlp at ${YTDLP} (${err.code || err.message}).`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(explainYtDlpError(stderr, code, signal)));
    });
  });
}

function explainYtDlpError(stderr, code, signal) {
  const lines = stderr.split('\n').filter((l) => /ERROR/.test(l));
  const last = (lines.at(-1) || stderr.trim().split('\n').at(-1) || '').replace(/^.*?ERROR:\s*/, '');
  if (signal) return `yt-dlp was stopped (${signal}) before it finished.`;
  if (/private video/i.test(last)) return 'That video is private, so it cannot be played.';
  if (/sign in to confirm your age|age-restricted/i.test(last)) return 'That video is age-restricted, so yt-dlp cannot fetch it without a login.';
  if (/unavailable|removed|does not exist/i.test(last)) return 'That video is unavailable on YouTube.';
  if (/live event|is live|premieres/i.test(last)) return 'Live streams and premieres are not supported yet.';
  return `yt-dlp couldn't fetch the audio: ${last || `exit code ${code}`}`;
}

async function download(id, hints) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const tmp = await fsp.mkdtemp(path.join(CACHE_DIR, `.tmp-${id}-`));
  try {
    console.log(`[yt] downloading ${id}`);
    const t0 = Date.now();
    await runYtDlp([
      '--no-playlist',
      '--no-progress',
      '--quiet',
      '--no-warnings',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3', '--audio-quality', '192K',
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--write-info-json',
      '-o', path.join(tmp, `${id}.%(ext)s`),
      `https://www.youtube.com/watch?v=${id}`,
    ]);
    const tmpMp3 = path.join(tmp, `${id}.mp3`);
    if (!fs.existsSync(tmpMp3)) throw new Error('yt-dlp finished but no MP3 was produced.');

    let info = {};
    try { info = JSON.parse(await fsp.readFile(path.join(tmp, `${id}.info.json`), 'utf8')); } catch { /* ignore */ }
    const meta = {
      videoId: id,
      title: hints.title || info.title || null,
      channel: hints.channel || info.channel || info.uploader || null,
      thumbnail: hints.thumbnail || info.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      duration: Number(info.duration) || 0,
      fetchedAt: new Date().toISOString(),
    };

    const tmpJpg = path.join(tmp, `${id}.jpg`);
    if (fs.existsSync(tmpJpg)) await fsp.rename(tmpJpg, artPath(id));
    await fsp.writeFile(metaPath(id), JSON.stringify(meta, null, 2));
    // The MP3 goes into place last: its presence means the cache entry is complete.
    await fsp.rename(tmpMp3, mp3Path(id));
    const size = (await fsp.stat(mp3Path(id))).size;
    console.log(`[yt] cached ${id} "${meta.title}" ${(size / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return meta;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

// Make sure <id>.mp3 is in the cache. One download per videoId at a time:
// a second caller waits on the first caller's job.
export function ensureAudio(id, hints = {}) {
  if (!isVideoId(id)) return Promise.reject(new Error('That is not a valid YouTube video ID.'));
  const existing = readMeta(id);
  if (existing && fs.existsSync(mp3Path(id))) {
    const now = new Date();
    fs.utimes(mp3Path(id), now, now, () => {}); // mark as recently used for cleanup
    let meta = existing;
    const merged = {
      ...existing,
      title: hints.title || existing.title,
      channel: hints.channel || existing.channel,
      thumbnail: hints.thumbnail || existing.thumbnail,
    };
    if (merged.title !== existing.title || merged.channel !== existing.channel || merged.thumbnail !== existing.thumbnail) {
      meta = merged;
      fs.writeFile(metaPath(id), JSON.stringify(meta, null, 2), () => {});
    }
    return Promise.resolve(meta);
  }
  if (jobs.has(id)) return jobs.get(id);
  const job = download(id, hints).finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job;
}

// Start-up housekeeping: drop leftovers and anything older than 30 days, then
// trim to 2 GB, least recently used first. Files are grouped per videoId.
export async function cleanupCache() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const names = await fsp.readdir(CACHE_DIR);
  const now = Date.now();
  const entries = new Map(); // id -> { files: [], bytes, mtime }
  let removed = 0;
  let freed = 0;

  for (const name of names) {
    const full = path.join(CACHE_DIR, name);
    if (name.startsWith('.tmp-')) {
      await fsp.rm(full, { recursive: true, force: true });
      continue;
    }
    const m = /^([A-Za-z0-9_-]{11})\.(mp3|jpg|json)$/.exec(name);
    if (!m) continue;
    const st = await fsp.stat(full);
    const e = entries.get(m[1]) || { id: m[1], files: [], bytes: 0, mtime: 0, hasMp3: false };
    e.files.push(full);
    e.bytes += st.size;
    // Age is taken from the MP3, which is touched on every play.
    if (m[2] === 'mp3') { e.hasMp3 = true; e.mtime = st.mtimeMs; }
    entries.set(m[1], e);
  }

  const drop = async (e) => {
    for (const f of e.files) await fsp.rm(f, { force: true });
    removed += 1;
    freed += e.bytes;
  };

  let list = [...entries.values()];
  for (const e of list) if (now - e.mtime > MAX_AGE_MS || !e.hasMp3) await drop(e);
  list = list.filter((e) => now - e.mtime <= MAX_AGE_MS && e.hasMp3).sort((a, b) => a.mtime - b.mtime);
  let total = list.reduce((s, e) => s + e.bytes, 0);
  while (total > MAX_BYTES && list.length) {
    const e = list.shift();
    total -= e.bytes;
    await drop(e);
  }
  console.log(`[cache] ${CACHE_DIR}: kept ${list.length} videos, ${(total / 1e6).toFixed(1)} MB; removed ${removed} (${(freed / 1e6).toFixed(1)} MB)`);
  return { kept: list.length, bytes: total, removed, freed };
}
