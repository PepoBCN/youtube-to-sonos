// Shared helpers for the background worker, the popup and the YouTube content script.
// Plain script (no modules) so it can be loaded by importScripts, a <script> tag and content_scripts.

(function (root) {
  const YTS = {};

  YTS.DEFAULT_COMPANION_URL = 'http://localhost:8787';
  YTS.INSTALL_COMMAND = 'launchctl kickstart -k gui/$(id -u)/com.youtube-to-sonos.companion';
  YTS.PLAY_TIMEOUT_MS = 200000;

  const ID_RE = /^[\w-]{11}$/;

  // "1h2m3s", "90", "90s", "2m" -> seconds. Returns 0 when there is nothing usable.
  function parseT(t) {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = String(t).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m) return 0;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  // Works for watch, Shorts, youtu.be, embed and live URLs. Returns null if it isn't a single video.
  YTS.parseYouTubeUrl = function (href) {
    let u;
    try {
      u = new URL(href);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let videoId = null;
    let kind = 'watch';
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') videoId = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
        if (m) {
          videoId = m[2];
          kind = m[1] === 'shorts' ? 'shorts' : 'watch';
        }
      }
    } else if (host === 'youtu.be') {
      videoId = u.pathname.slice(1, 12);
    }
    if (!videoId || !ID_RE.test(videoId)) return null;
    return { videoId, kind, startSeconds: parseT(u.searchParams.get('t') || u.searchParams.get('start')) };
  };

  YTS.thumbnailFor = (videoId) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  YTS.formatTime = function (sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };

  YTS.stateLabel = function (state) {
    switch (state) {
      case 'PLAYING':
        return 'Playing';
      case 'PAUSED_PLAYBACK':
        return 'Paused';
      case 'TRANSITIONING':
        return 'Starting';
      case 'STOPPED':
        return 'Idle';
      default:
        return state ? String(state).toLowerCase() : '';
    }
  };

  // Message the background worker. Always resolves to { ok, data?, error?, code? }.
  YTS.send = function (msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const le = chrome.runtime.lastError;
          if (le) return resolve({ ok: false, code: 'channel', error: le.message || 'The extension worker did not answer.' });
          resolve(res || { ok: false, code: 'channel', error: 'The extension worker did not answer.' });
        });
      } catch (e) {
        // "Extension context invalidated" after the extension reloads under an open tab.
        resolve({ ok: false, code: 'invalidated', error: 'The extension was reloaded. Refresh this page to use it again.' });
      }
    });
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Send a play request and wait for the result. If the message channel drops while the
  // companion is still preparing (the worker was restarted), fall back to polling status.
  YTS.playAndWait = async function (payload) {
    const res = await YTS.send({ type: 'play', ...payload });
    if (res.ok || res.code !== 'channel') return res;
    const until = Date.now() + YTS.PLAY_TIMEOUT_MS;
    while (Date.now() < until) {
      await sleep(2000);
      const s = await YTS.send({ type: 'status', groupId: payload.groupId });
      if (s.ok && s.data.videoId === payload.videoId && s.data.state === 'PLAYING') return s;
      if (!s.ok && s.code === 'offline') return s;
      const p = await YTS.send({ type: 'pending' });
      if (p.ok && p.data && p.data.lastError && p.data.lastError.videoId === payload.videoId) {
        return { ok: false, code: 'http', error: p.data.lastError.error };
      }
    }
    return { ok: false, code: 'timeout', error: 'The speaker did not start within three minutes.' };
  };

  root.YTS = YTS;
})(typeof self !== 'undefined' ? self : this);
