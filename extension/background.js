// Service worker. Every call to the companion goes through here, so the popup and the
// YouTube content script never need their own network access.

importScripts('lib/shared.js');

const ACCENT = '#f05a24';
const INK = '#0f0e12';
const MENU_ID = 'yts-play-on-sonos';

// A fresh worker can't have a play call in flight (fetches die with the old worker), so any
// pending job left in session storage is stale. Clear it and its badge.
const BOOT = Date.now();
chrome.storage.session.get('pending').then(async ({ pending }) => {
  if (!pending || pending.startedAt >= BOOT) return;
  const again = await chrome.storage.session.get('pending');
  if (again.pending && again.pending.startedAt === pending.startedAt) {
    await chrome.storage.session.remove('pending');
    await chrome.action.setBadgeText({ text: '' });
  }
});

// ---- Companion calls -------------------------------------------------------

async function companionUrl() {
  const { companionUrl } = await chrome.storage.local.get('companionUrl');
  return String(companionUrl || YTS.DEFAULT_COMPANION_URL).replace(/\/+$/, '');
}

async function api(method, path, body, timeoutMs = 10000) {
  const base = await companionUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { ok: false, code: 'timeout', error: 'The companion took too long to answer.' };
    }
    return { ok: false, code: 'offline', error: "The companion isn't running." };
  }
  clearTimeout(timer);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON. Handled below.
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error : `The companion answered with an error (${res.status}).`;
    return { ok: false, code: 'http', status: res.status, error: msg };
  }
  if (!data) return { ok: false, code: 'http', status: res.status, error: 'The companion sent back something unexpected.' };
  return { ok: true, data };
}

// ---- Keep the worker alive while a long play call is in flight -------------
// The companion can block for up to three minutes while it prepares audio. Calling an
// extension API resets the worker's idle timer, so ping one every 20 s until it's done.

let inFlight = 0;
let keepAliveTimer = null;

function holdOpen() {
  inFlight += 1;
  if (!keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}

function release() {
  inFlight = Math.max(0, inFlight - 1);
  if (!inFlight && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ---- Badge -----------------------------------------------------------------

let badgeClearTimer = null;

async function badge(text, colour, title, clearAfterMs) {
  clearTimeout(badgeClearTimer);
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: colour || ACCENT });
  if (chrome.action.setBadgeTextColor && text) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: title || 'YouTube to Sonos' });
  if (clearAfterMs) badgeClearTimer = setTimeout(() => badge(''), clearAfterMs);
}

// ---- Play ------------------------------------------------------------------

async function play(p, tabId) {
  const job = {
    videoId: p.videoId,
    groupId: p.groupId,
    groupName: p.groupName || '',
    title: p.title || '',
    channel: p.channel || '',
    thumbnail: p.thumbnail || YTS.thumbnailFor(p.videoId),
    startSeconds: Math.max(0, Math.floor(Number(p.startSeconds) || 0)),
    startedAt: Date.now(),
  };
  await chrome.storage.local.set({ lastGroupId: job.groupId, lastGroupName: job.groupName });
  await chrome.storage.session.set({ pending: job, lastError: null });
  await badge('...', ACCENT, `Preparing audio on ${job.groupName || 'Sonos'}`);

  const body = { videoId: job.videoId, groupId: job.groupId, startSeconds: job.startSeconds };
  if (job.title) body.title = job.title;
  if (job.channel) body.channel = job.channel;
  if (job.thumbnail) body.thumbnail = job.thumbnail;

  holdOpen();
  let res;
  try {
    res = await api('POST', '/api/play', body, YTS.PLAY_TIMEOUT_MS);
  } finally {
    release();
  }

  const { pending } = await chrome.storage.session.get('pending');
  if (pending && pending.startedAt === job.startedAt) await chrome.storage.session.remove('pending');

  if (res.ok) {
    await badge('ON', ACCENT, `Playing on ${job.groupName || 'Sonos'}`, 4000);
    if (tabId != null && p.pauseTab !== false) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'pauseVideo', videoId: job.videoId });
      } catch {
        // The tab was closed or navigated away. Nothing to pause.
      }
    }
  } else {
    await chrome.storage.session.set({ lastError: { videoId: job.videoId, groupId: job.groupId, error: res.error, at: Date.now() } });
    await badge('ERR', INK, res.error);
  }
  return res;
}

// ---- Context menu ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: 'Play on Sonos',
        contexts: ['link'],
        targetUrlPatterns: [
          '*://www.youtube.com/watch*',
          '*://youtube.com/watch*',
          '*://m.youtube.com/watch*',
          '*://music.youtube.com/watch*',
          '*://www.youtube.com/shorts/*',
          '*://youtube.com/shorts/*',
          '*://m.youtube.com/shorts/*',
          '*://youtu.be/*',
        ],
      },
      () => {
        self.__ytsMenuError = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      }
    );
  });
});

async function handleContextClick(info) {
  if (info.menuItemId !== MENU_ID) return null;
  const parsed = YTS.parseYouTubeUrl(info.linkUrl || '');
  if (!parsed) {
    await badge('ERR', INK, 'That link is not a single YouTube video.');
    return { ok: false, error: 'That link is not a single YouTube video.' };
  }
  const { lastGroupId, lastGroupName } = await chrome.storage.local.get(['lastGroupId', 'lastGroupName']);
  if (!lastGroupId) {
    await badge('SET', INK, 'Pick a speaker in the YouTube to Sonos popup first.');
    return { ok: false, error: 'No speaker chosen yet.' };
  }
  return play({ videoId: parsed.videoId, groupId: lastGroupId, groupName: lastGroupName, startSeconds: parsed.startSeconds, pauseTab: false }, null);
}

chrome.contextMenus.onClicked.addListener((info) => {
  handleContextClick(info);
});

// Exposed for the Playwright tests, which can't click a native context menu.
self.__yts = { handleContextClick, companionUrl };

// ---- Messages from the popup and the content script ------------------------

async function handle(msg, sender) {
  switch (msg && msg.type) {
    case 'health':
      return api('GET', '/api/health', null, 4000);
    case 'speakers':
      return api('GET', '/api/speakers' + (msg.refresh ? '?refresh=1' : ''), null, 15000);
    case 'status':
      return api('GET', '/api/status?groupId=' + encodeURIComponent(msg.groupId), null, 8000);
    case 'control':
      return api('POST', '/api/control', { groupId: msg.groupId, action: msg.action }, 15000);
    case 'volume':
      return api('POST', '/api/volume', { groupId: msg.groupId, volume: Math.round(Number(msg.volume)) }, 8000);
    case 'seek':
      return api('POST', '/api/seek', { groupId: msg.groupId, seconds: Number(msg.seconds) }, 15000);
    case 'play': {
      const tabId = msg.tabId != null ? msg.tabId : sender.tab ? sender.tab.id : null;
      return play(msg, tabId);
    }
    case 'pending': {
      const s = await chrome.storage.session.get(['pending', 'lastError']);
      return { ok: true, data: { pending: s.pending || null, lastError: s.lastError || null } };
    }
    case 'clearError':
      await chrome.storage.session.remove('lastError');
      await badge('');
      return { ok: true, data: null };
    case 'config': {
      const s = await chrome.storage.local.get(['lastGroupId', 'lastGroupName']);
      return { ok: true, data: { companionUrl: await companionUrl(), lastGroupId: s.lastGroupId || null, lastGroupName: s.lastGroupName || null } };
    }
    case 'setLastGroup':
      await chrome.storage.local.set({ lastGroupId: msg.groupId, lastGroupName: msg.groupName || '' });
      return { ok: true, data: null };
    default:
      return { ok: false, code: 'bad-message', error: 'Unknown request.' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, code: 'internal', error: String((e && e.message) || e) }));
  return true;
});
