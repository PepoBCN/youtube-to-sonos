// YouTube to Sonos companion server. See ../SPEC.md for the API contract.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { isVideoId, buildDidl, parseRange, ourVideoIdFromUri } from './util.js';
import * as sonos from './sonos.js';
import { SonosError } from './sonos.js';
import { ensureAudio, readMeta, mp3Path, artPath, cleanupCache, CACHE_DIR } from './youtube.js';

const PORT = Number(process.env.PORT) || 8787;
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const PLAY_TIMEOUT_MS = 180_000;

// Every line to stdout gets a timestamp (launchd writes stdout to the log file).
const rawLog = console.log.bind(console);
console.log = (...a) => rawLog(new Date().toISOString(), ...a);
const log = console.log;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Network helpers --------------------------------------------------------

function localIpv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

function lanIp() {
  const ips = localIpv4s();
  const pick =
    ips.find((x) => x.name === 'en0') ||
    ips.find((x) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(x.address)) ||
    ips[0];
  return pick ? pick.address : '127.0.0.1';
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// ---- Response helpers -------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'The request body is too large.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

// ---- Status -----------------------------------------------------------------

async function buildStatus(group) {
  const ip = group.coordinatorIp;
  const [state, pos, volume] = await Promise.all([
    sonos.getTransportState(ip),
    sonos.getPositionInfo(ip),
    sonos.getGroupVolume(ip),
  ]);
  const hosts = localIpv4s().map((x) => x.address).concat(['localhost', '127.0.0.1']);
  const videoId = ourVideoIdFromUri(pos.trackUri, hosts, PORT);
  let title = null;
  let channel = null;
  let thumbnail = null;
  let duration = pos.duration;
  if (videoId) {
    const meta = readMeta(videoId) || {};
    title = meta.title || null;
    channel = meta.channel || null;
    thumbnail = meta.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    if (!duration && meta.duration) duration = meta.duration;
  } else {
    ({ title, channel, thumbnail } = sonos.parseDidl(pos.metadata, ip));
  }
  return {
    groupId: group.id,
    state,
    videoId: videoId || null,
    title,
    channel,
    thumbnail,
    position: pos.position,
    duration,
    volume,
    isOurs: Boolean(videoId),
  };
}

// ---- API handlers -----------------------------------------------------------

async function handleSpeakers(url) {
  const refresh = url.searchParams.get('refresh') === '1';
  const groups = await sonos.getTopology({ refresh, localIp: lanIp() });
  const out = await Promise.all(
    groups.map(async (g) => {
      const [volume, state] = await Promise.all([
        sonos.getGroupVolume(g.coordinatorIp).catch(() => null),
        sonos.getTransportState(g.coordinatorIp).catch(() => null),
      ]);
      return {
        id: g.id,
        name: g.name,
        coordinatorIp: g.coordinatorIp,
        members: g.members.map(({ uuid, name, ip, model }) => ({ uuid, name, ip, model })),
        volume,
        state,
      };
    }),
  );
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { groups: out };
}

async function handlePlay(body) {
  const { videoId, groupId } = body;
  if (!isVideoId(videoId)) throw new HttpError(400, 'Please send a valid YouTube video ID.');
  const startSeconds = Math.max(0, Math.floor(Number(body.startSeconds) || 0));
  const group = await sonos.findGroup(groupId, { localIp: lanIp() });
  const deadline = Date.now() + PLAY_TIMEOUT_MS;
  log(`[play] ${videoId} on ${group.name} from ${startSeconds}s`);

  const hints = {
    title: typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '',
    channel: typeof body.channel === 'string' ? body.channel.trim().slice(0, 200) : '',
    thumbnail: typeof body.thumbnail === 'string' && /^https?:\/\//.test(body.thumbnail) ? body.thumbnail : '',
  };
  let timer;
  const meta = await Promise.race([
    ensureAudio(videoId, hints),
    new Promise((_, rej) => {
      timer = setTimeout(
        () => rej(new HttpError(504, 'The audio is still downloading. Please try again in a minute, it will carry on in the background.')),
        PLAY_TIMEOUT_MS,
      );
    }),
  ]).catch((err) => {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err.message);
  }).finally(() => clearTimeout(timer));

  const host = lanIp();
  const uri = `http://${host}:${PORT}/stream/${videoId}.mp3`;
  const didl = buildDidl({
    uri,
    title: meta.title,
    creator: meta.channel,
    albumArtUri: `http://${host}:${PORT}/art/${videoId}.jpg`,
    durationSeconds: meta.duration,
  });
  const ip = group.coordinatorIp;
  await sonos.setUri(ip, uri, didl);
  await sonos.play(ip);
  const state = await sonos.waitForState(ip, ['PLAYING'], Math.max(5_000, deadline - Date.now()));
  if (state !== 'PLAYING') {
    throw new HttpError(504, `The speaker didn't start playing (it reports ${state || 'nothing'}).`);
  }
  if (startSeconds > 3) {
    await sonos.seek(ip, startSeconds);
    await sonos.waitForState(ip, ['PLAYING'], 5000); // a seek passes through TRANSITIONING
  }
  return buildStatus(group);
}

async function handleControl(body) {
  const group = await sonos.findGroup(body.groupId, { localIp: lanIp() });
  const ip = group.coordinatorIp;
  const action = body.action;
  if (action === 'pause') await sonos.pause(ip);
  else if (action === 'resume') await sonos.play(ip);
  else if (action === 'stop') await sonos.stop(ip);
  else throw new HttpError(400, 'Action must be pause, resume or stop.');
  log(`[control] ${action} on ${group.name}`);
  if (action !== 'stop') {
    await sonos.waitForState(ip, action === 'pause' ? ['PAUSED_PLAYBACK', 'STOPPED'] : ['PLAYING'], 4000);
  }
  return buildStatus(group);
}

async function handleSeek(body) {
  const group = await sonos.findGroup(body.groupId, { localIp: lanIp() });
  const seconds = Number(body.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) throw new HttpError(400, 'Seconds must be a number of seconds, 0 or more.');
  await sonos.seek(group.coordinatorIp, Math.floor(seconds));
  await sonos.waitForState(group.coordinatorIp, ['PLAYING', 'PAUSED_PLAYBACK', 'STOPPED'], 5000);
  log(`[seek] ${group.name} to ${Math.floor(seconds)}s`);
  return buildStatus(group);
}

async function handleVolume(body) {
  const group = await sonos.findGroup(body.groupId, { localIp: lanIp() });
  const v = Number(body.volume);
  if (!Number.isFinite(v)) throw new HttpError(400, 'Volume must be a number from 0 to 100.');
  const volume = Math.round(Math.min(100, Math.max(0, v)));
  await sonos.setGroupVolume(group.coordinatorIp, volume);
  log(`[volume] ${group.name} to ${volume}`);
  return buildStatus(group);
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/health':
      return sendJson(res, 200, { ok: true, version: VERSION, lanIp: lanIp() });
    case 'GET /api/speakers':
      return sendJson(res, 200, await handleSpeakers(url));
    case 'GET /api/status': {
      const group = await sonos.findGroup(url.searchParams.get('groupId'), { localIp: lanIp() });
      return sendJson(res, 200, await buildStatus(group));
    }
    case 'POST /api/play':
      return sendJson(res, 200, await handlePlay(await readJson(req)));
    case 'POST /api/control':
      return sendJson(res, 200, await handleControl(await readJson(req)));
    case 'POST /api/seek':
      return sendJson(res, 200, await handleSeek(await readJson(req)));
    case 'POST /api/volume':
      return sendJson(res, 200, await handleVolume(await readJson(req)));
    default:
      throw new HttpError(404, 'There is no such API endpoint.');
  }
}

// ---- Files for the speakers ---------------------------------------------------

function serveFile(req, res, file, type) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: 'That file is not in the cache.' });
  }
  const size = st.size;
  const base = { ...CORS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  let status = 200;
  let start = 0;
  let end = size - 1;
  const headers = { ...base };
  if (range) {
    status = 206;
    ({ start, end } = range);
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function handleFiles(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Only GET and HEAD are allowed here.' });
  let m = /^\/stream\/([^/]+)\.mp3$/.exec(url.pathname);
  if (m) {
    if (!isVideoId(m[1])) return sendJson(res, 400, { error: 'That is not a valid YouTube video ID.' });
    if (req.headers.range) log(`[stream] ${m[1]} ${req.headers.range} from ${req.socket.remoteAddress}`);
    else log(`[stream] ${m[1]} ${req.method} from ${req.socket.remoteAddress}`);
    return serveFile(req, res, mp3Path(m[1]), 'audio/mpeg');
  }
  m = /^\/art\/([^/]+)\.jpg$/.exec(url.pathname);
  if (m) {
    if (!isVideoId(m[1])) return sendJson(res, 400, { error: 'That is not a valid YouTube video ID.' });
    if (!fs.existsSync(artPath(m[1]))) {
      res.writeHead(302, { ...CORS, Location: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` });
      return res.end();
    }
    return serveFile(req, res, artPath(m[1]), 'image/jpeg');
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

// ---- Server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'Bad URL.' });
  }
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  try {
    if (isApi && !isLoopback(req.socket.remoteAddress)) {
      log(`[guard] refused ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`);
      return sendJson(res, 403, { error: 'The companion API only answers requests from this Mac.' });
    }
    // Web pages always send an Origin on cross-site requests; only the extension (or curl, no Origin) gets in.
    const origin = req.headers.origin;
    if (isApi && origin && !origin.startsWith('chrome-extension://')) {
      log(`[guard] refused ${req.method} ${url.pathname} from origin ${origin}`);
      return sendJson(res, 403, { error: 'The companion API only answers the Chrome extension.' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (isApi) {
      await handleApi(req, res, url);
      if (!(req.method === 'GET' && /\/(status|health)$/.test(url.pathname))) {
        log(`[api] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0} ms`);
      }
      return;
    }
    if (url.pathname.startsWith('/stream/') || url.pathname.startsWith('/art/')) return handleFiles(req, res, url);
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    const status = err instanceof HttpError || err instanceof SonosError ? err.status : 500;
    const message = status === 500 ? `Something went wrong in the companion: ${err.message}` : err.message;
    log(`[error] ${req.method} ${url.pathname} ${status}: ${err.message}`);
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.destroy();
  }
});

server.requestTimeout = 0; // /api/play can legitimately take minutes
server.on('error', (err) => {
  log(`[server] ${err.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (err) => log('[unhandled]', err?.stack || err));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`[server] ${sig}, shutting down`);
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}

log(`[server] youtube-to-sonos companion ${VERSION}, node ${process.version}, cache ${CACHE_DIR}`);
cleanupCache().catch((err) => log(`[cache] cleanup failed: ${err.message}`));

// '::' with dual-stack accepts IPv4 (0.0.0.0) and IPv6, so "localhost" works whether it resolves to 127.0.0.1 or ::1.
server.listen({ port: PORT, host: '::', ipv6Only: false }, () => {
  log(`[server] listening on port ${PORT}, LAN address http://${lanIp()}:${PORT}`);
});
