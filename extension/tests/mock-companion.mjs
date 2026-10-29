// Mock of the YouTube to Sonos companion API (see ../../SPEC.md).
// Implements the whole contract with two fake groups and never touches a real speaker.
//
//   node tests/mock-companion.mjs            port 8788, 2 s delay on /api/play
//   PORT=8790 PLAY_DELAY_MS=40000 node tests/mock-companion.mjs
//
// Test-only endpoints (not part of the contract):
//   GET  /__requests   every /api, /stream and /art request received, oldest first
//   POST /__reset      clear the log and put both groups back to their starting state
//   POST /__config     { playDelayMs?, failPlay?: "message" | null }

import http from 'node:http';

const PORT = Number(process.env.PORT || 8788);
if (PORT === 8787) {
  console.error('Refusing to run the mock on 8787, that port belongs to the real companion.');
  process.exit(1);
}

const config = {
  playDelayMs: Number(process.env.PLAY_DELAY_MS || 2000),
  failPlay: null,
};

const THUMB_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAASACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBaKKK+VPvwooooAKKKKACiiigD/9k=',
  'base64'
);
const FAKE_MP3 = Buffer.alloc(64 * 1024, 0x55);

function freshGroups() {
  return {
    RINCON_MOCKDINING01400: {
      id: 'RINCON_MOCKDINING01400',
      name: 'Dining Room',
      coordinatorIp: '10.0.0.37',
      members: [{ uuid: 'RINCON_MOCKDINING01400', name: 'Dining Room', ip: '10.0.0.37', model: 'Play:5' }],
      volume: 8,
      state: 'STOPPED',
      track: null,
    },
    RINCON_MOCKBEDROOM01400: {
      id: 'RINCON_MOCKBEDROOM01400',
      name: 'Bedroom + Shower',
      coordinatorIp: '10.0.0.34',
      members: [
        { uuid: 'RINCON_MOCKBEDROOM01400', name: 'Bedroom', ip: '10.0.0.34', model: 'Play:1' },
        { uuid: 'RINCON_MOCKSHOWER01400', name: 'Shower', ip: '10.0.0.38', model: 'Play:1' },
      ],
      volume: 12,
      state: 'PAUSED_PLAYBACK',
      // Something that is not ours, like a Sonos app queue.
      track: { videoId: null, title: 'Radio 6 Music', channel: 'BBC', thumbnail: null, duration: 0, basePos: 1312, baseAt: Date.now(), isOurs: false },
    },
  };
}

let groups = freshGroups();
let log = [];

function position(g) {
  if (!g.track) return 0;
  const t = g.track;
  let pos = t.basePos;
  if (g.state === 'PLAYING') pos += (Date.now() - t.baseAt) / 1000;
  if (t.duration) pos = Math.min(pos, t.duration);
  return Math.round(pos * 10) / 10;
}

function freezePosition(g) {
  if (!g.track) return;
  g.track.basePos = position(g);
  g.track.baseAt = Date.now();
}

function status(g) {
  const t = g.track;
  return {
    groupId: g.id,
    state: g.state,
    videoId: t ? t.videoId : null,
    title: t ? t.title : null,
    channel: t ? t.channel : null,
    thumbnail: t ? t.thumbnail : null,
    position: position(g),
    duration: t ? t.duration : 0,
    volume: g.volume,
    isOurs: t ? t.isOurs : false,
  };
}

function publicGroup(g) {
  const { track, ...rest } = g;
  return rest;
}

function send(res, code, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': Buffer.isBuffer(body) ? headers['Content-Type'] : 'application/json',
    'Content-Length': data.length,
    ...cors(),
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : data);
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const err = (res, code, message) => send(res, code, { error: message });

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ __invalid: raw });
      }
    });
  });
}

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function groupFrom(res, id) {
  const g = groups[id];
  if (!g) {
    err(res, 404, `No speaker group with id ${id || '(missing)'}.`);
    return null;
  }
  return g;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors());
    return res.end();
  }

  // Test-only endpoints.
  if (path === '/__requests') return send(res, 200, { requests: log });
  if (path === '/__reset' && req.method === 'POST') {
    groups = freshGroups();
    log = [];
    config.failPlay = null;
    config.playDelayMs = Number(process.env.PLAY_DELAY_MS || 2000);
    return send(res, 200, { ok: true });
  }
  if (path === '/__config' && req.method === 'POST') {
    const b = await readBody(req);
    if ('playDelayMs' in b) config.playDelayMs = Number(b.playDelayMs);
    if ('failPlay' in b) config.failPlay = b.failPlay;
    return send(res, 200, { ok: true, config });
  }

  const body = req.method === 'POST' ? await readBody(req) : null;
  const entry = { at: new Date().toISOString(), method: req.method, path, query: Object.fromEntries(url.searchParams), body };
  if (path.startsWith('/api/') || path.startsWith('/stream/') || path.startsWith('/art/')) {
    log.push(entry);
    // Record callers that hang up before the answer (for the worker-restart test).
    res.on('close', () => {
      if (!res.writableFinished) entry.aborted = true;
    });
  }

  if (path.startsWith('/api/')) {
    if (!isLocal(req)) return err(res, 403, 'The companion API only answers this Mac.');
    if (body && body.__invalid) return err(res, 400, 'The request body was not valid JSON.');

    if (path === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, version: '0.0.0-mock', lanIp: '10.0.0.41' });
    }

    if (path === '/api/speakers' && req.method === 'GET') {
      return send(res, 200, { groups: Object.values(groups).map(publicGroup) });
    }

    if (path === '/api/play' && req.method === 'POST') {
      const { videoId, groupId, startSeconds, title, channel, thumbnail } = body;
      if (!videoId || !/^[\w-]{11}$/.test(videoId)) return err(res, 400, 'That is not a YouTube video id.');
      const g = groupFrom(res, groupId);
      if (!g) return;
      g.state = 'TRANSITIONING';
      await sleep(config.playDelayMs);
      if (config.failPlay) {
        g.state = 'STOPPED';
        return err(res, 502, config.failPlay);
      }
      const start = Number(startSeconds) > 3 ? Number(startSeconds) : 0;
      g.track = {
        videoId,
        title: title || `Mock title for ${videoId}`,
        channel: channel || 'Mock channel',
        thumbnail: `http://10.0.0.41:${PORT}/art/${videoId}.jpg`,
        duration: 245,
        basePos: start,
        baseAt: Date.now(),
        isOurs: true,
      };
      g.state = 'PLAYING';
      return send(res, 200, status(g));
    }

    if (path === '/api/status' && req.method === 'GET') {
      const g = groupFrom(res, url.searchParams.get('groupId'));
      if (!g) return;
      return send(res, 200, status(g));
    }

    if (path === '/api/control' && req.method === 'POST') {
      const g = groupFrom(res, body.groupId);
      if (!g) return;
      const a = body.action;
      if (a === 'pause') {
        freezePosition(g);
        g.state = 'PAUSED_PLAYBACK';
      } else if (a === 'resume') {
        if (!g.track) return err(res, 409, 'There is nothing to resume on this speaker.');
        freezePosition(g);
        g.state = 'PLAYING';
      } else if (a === 'stop') {
        freezePosition(g);
        g.state = 'STOPPED';
      } else {
        return err(res, 400, `Unknown action ${a}. Use pause, resume or stop.`);
      }
      return send(res, 200, status(g));
    }

    if (path === '/api/seek' && req.method === 'POST') {
      const g = groupFrom(res, body.groupId);
      if (!g) return;
      if (!g.track) return err(res, 409, 'There is nothing playing to seek.');
      g.track.basePos = Math.max(0, Number(body.seconds) || 0);
      g.track.baseAt = Date.now();
      return send(res, 200, status(g));
    }

    if (path === '/api/volume' && req.method === 'POST') {
      const g = groupFrom(res, body.groupId);
      if (!g) return;
      const v = Number(body.volume);
      if (!Number.isFinite(v) || v < 0 || v > 100) return err(res, 400, 'Volume must be a number from 0 to 100.');
      g.volume = Math.round(v);
      return send(res, 200, status(g));
    }

    return err(res, 404, `No such endpoint: ${req.method} ${path}`);
  }

  const streamMatch = path.match(/^\/stream\/([\w-]{11})\.mp3$/);
  if (streamMatch) {
    const total = FAKE_MP3.length;
    const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start >= total || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, ...cors() });
        return res.end();
      }
      const chunk = FAKE_MP3.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': chunk.length,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        ...cors(),
      });
      return res.end(req.method === 'HEAD' ? undefined : chunk);
    }
    return send(res, 200, FAKE_MP3, { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
  }

  if (/^\/art\/[\w-]{11}\.jpg$/.test(path)) return send(res, 200, THUMB_JPEG, { 'Content-Type': 'image/jpeg' });

  return err(res, 404, 'Not found.');
});

server.listen(PORT, '::', () => {
  console.log(`mock companion listening on ${PORT} (play delay ${config.playDelayMs} ms)`);
});
