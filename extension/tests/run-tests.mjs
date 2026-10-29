// End-to-end tests for the extension, against tests/mock-companion.mjs on port 8788.
// Uses Playwright's bundled Chromium with a throwaway profile. Never your own Chrome, never port 8787.
//
//   node tests/run-tests.mjs            headless (new headless mode)
//   HEADED=1 node tests/run-tests.mjs   watch it run
//   SKIP_LONG=1 node tests/run-tests.mjs   skip the slow worker-restart test

import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const SHOTS = path.join(here, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const MOCK_PORT = 8788;
const MOCK = `http://localhost:${MOCK_PORT}`;
const DEAD_PORT = 59999;
const WATCH_ID = 'dQw4w9WgXcQ';
const LINK_ID = 'jNQXAC9IVRw';

// Playwright: local install if there is one, else the global one.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const req = createRequire(path.join(execSync('npm root -g').toString().trim(), 'noop.js'));
  ({ chromium } = req('playwright'));
}

// ---- Tiny test harness -----------------------------------------------------

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
async function step(name, fn) {
  console.log(`\n== ${name}`);
  try {
    await fn();
  } catch (e) {
    check(`${name}: ran without throwing`, false, String(e && e.message ? e.message.split('\n')[0] : e));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

// ---- Mock companion --------------------------------------------------------

async function startMock() {
  if (await portOpen(MOCK_PORT)) throw new Error(`Port ${MOCK_PORT} is already in use`);
  const child = spawn(process.execPath, [path.join(here, 'mock-companion.mjs')], { env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => d.toString().includes('listening') && resolve());
    child.once('exit', (c) => reject(new Error(`mock exited ${c}`)));
  });
  return child;
}
const mock = {
  reset: () => fetch(`${MOCK}/__reset`, { method: 'POST' }),
  config: (c) => fetch(`${MOCK}/__config`, { method: 'POST', body: JSON.stringify(c) }),
  requests: async () => (await (await fetch(`${MOCK}/__requests`)).json()).requests,
  status: async (groupId) => (await fetch(`${MOCK}/api/status?groupId=${groupId}`)).json(),
};
const DINING = 'RINCON_MOCKDINING01400';
const BEDROOM = 'RINCON_MOCKBEDROOM01400';
const posts = async (p) => (await mock.requests()).filter((r) => r.method === 'POST' && r.path === p);

// ---- YouTube helpers -------------------------------------------------------

async function dismissConsent(page) {
  const btn = page.locator('button:visible', { hasText: /^(Reject all|Accept all)$/ }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

async function readyVideo(page, kind = 'watch') {
  const playerSel = kind === 'shorts' ? '#shorts-player' : '#movie_player';
  await page.waitForSelector(`${playerSel} video`, { timeout: 30000 });
  // Wait out any pre-roll ad so currentTime belongs to the real video.
  for (let i = 0; i < 40; i++) {
    const ad = await page.evaluate((s) => document.querySelector(s)?.classList.contains('ad-showing'), playerSel);
    if (!ad) break;
    const skip = page.locator('.ytp-skip-ad-button:visible, .ytp-ad-skip-button-modern:visible').first();
    if (await skip.count()) await skip.click().catch(() => {});
    await sleep(1000);
  }
  await page.evaluate((s) => {
    const v = document.querySelector(`${s} video`);
    v.muted = true;
    return v.play().catch(() => {});
  }, playerSel);
}

const setTime = (page, t, kind = 'watch') =>
  page.evaluate(
    ([s, t]) => {
      const v = document.querySelector(`${s} video`);
      v.currentTime = t;
      return v.play().catch(() => {});
    },
    [kind === 'shorts' ? '#shorts-player' : '#movie_player', t]
  );

const isPaused = (page, kind = 'watch') => page.evaluate((s) => document.querySelector(`${s} video`).paused, kind === 'shorts' ? '#shorts-player' : '#movie_player');
const buttonCount = (page) => page.evaluate(() => document.querySelectorAll('.yts-sonos-button').length);

async function showControls(page) {
  const box = await page.locator('#movie_player').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10);
  await sleep(300);
}

async function popupShot(page, name) {
  await page.waitForTimeout(150);
  await page.locator('body').screenshot({ path: path.join(SHOTS, name) });
}

// ---- Run -------------------------------------------------------------------

const mockProc = await startMock();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yts-test-profile-'));
const args = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'];
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  args,
  viewport: { width: 1280, height: 800 },
  locale: 'en-GB',
});
// Pre-answer YouTube's EU/UK consent wall ("Reject all"); dismissConsent handles it if it still shows.
await context.addCookies([{ name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/', secure: true }]);

let sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const extId = sw.url().split('/')[2];
const getSw = async () => {
  const live = context.serviceWorkers().find((w) => w.url().includes(extId));
  if (live) sw = live;
  return sw;
};
const swEval = async (fn, arg) => {
  // The worker can be replaced (stopped and restarted). Retry on the newest one.
  for (let i = 0; ; i++) {
    const all = context.serviceWorkers().filter((w) => w.url().includes(extId));
    const w = all.at(-1) || sw;
    try {
      return await w.evaluate(fn, arg);
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(500);
    }
  }
};
const popupUrl = (q = '') => `chrome-extension://${extId}/popup.html${q}`;

let yt;
let ytTabId;

try {
  await step('Extension loads and points at the mock', async () => {
    check('service worker running', !!extId, `extension id ${extId}`);
    await swEval((u) => chrome.storage.local.set({ companionUrl: u }), MOCK);
    const url = await swEval(() => self.__yts.companionUrl());
    check('companionUrl set to the mock (never 8787)', url === MOCK, url);
    if (url !== MOCK) throw new Error('Refusing to continue: companion URL is not the mock');
    check('context menu registered without error', (await swEval(() => self.__ytsMenuError)) == null);
    await mock.reset();
  });

  await step('Popup, no YouTube video in the tab', async () => {
    const p = await context.newPage();
    await p.setViewportSize({ width: 344, height: 640 });
    await p.goto(popupUrl());
    await p.waitForSelector('.key');
    const names = await p.$$eval('.k-name', (els) => els.map((e) => e.textContent));
    check('speaker list shows both mock groups', names.join('|') === 'Dining Room|Bedroom + Shower', names.join('|'));
    check('header lamp lit and says Connected', (await p.textContent('#companion-state')) === 'Connected' && (await p.$('#companion-lamp.on')) != null);
    check('"open a YouTube video" note shown', (await p.textContent('#tab-sec')).includes('Open a YouTube video'));
    check('play key disabled without a video', await p.isDisabled('#play'));
    check('first group preselected when no last speaker', (await p.getAttribute('.key[aria-checked=true]', 'data-id')) === DINING);
    await popupShot(p, 'popup-no-video.png');
    await p.emulateMedia({ colorScheme: 'dark' });
    await popupShot(p, 'popup-no-video-dark.png');
    await p.close();
  });

  await step('YouTube watch page: speaker key in the player', async () => {
    yt = await context.newPage();
    await yt.goto(`https://www.youtube.com/watch?v=${WATCH_ID}`, { waitUntil: 'domcontentloaded' });
    const hadConsent = await dismissConsent(yt);
    console.log(`   consent wall ${hadConsent ? 'shown and dismissed' : 'not shown (SOCS cookie)'}`);
    await readyVideo(yt);
    await yt.waitForSelector('#movie_player .ytp-right-controls .yts-sonos-button', { timeout: 20000 });
    check('exactly one speaker key on the page', (await buttonCount(yt)) === 1);
    const where = await yt.evaluate(() => {
      const b = document.querySelector('.yts-sonos-button');
      const r = b.getBoundingClientRect();
      return { parent: b.parentElement.className, next: b.nextElementSibling && b.nextElementSibling.className, w: r.width, h: r.height };
    });
    check('key sits in the right-hand controls', /ytp-right-controls/.test(where.parent), `${where.parent}, before ${where.next}, ${where.w}x${where.h}`);
    await showControls(yt);
    const pb = await yt.locator('#movie_player').boundingBox();
    await yt.screenshot({ path: path.join(SHOTS, 'yt-button-in-controls.png'), clip: { x: pb.x + pb.width - 420, y: pb.y + pb.height - 70, width: 420, height: 70 } });
    ytTabId = await swEval(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
  });

  await step('In-page panel: pick a speaker', async () => {
    await mock.reset();
    await setTime(yt, 42);
    await sleep(500);
    await yt.click('.yts-sonos-button');
    await yt.waitForSelector('.yts-panel-host .key');
    const names = await yt.$$eval('.yts-panel-host', (hosts) => Array.from(hosts[0].shadowRoot.querySelectorAll('.name')).map((e) => e.textContent));
    check('panel lists both groups', names.join('|') === 'Dining Room|Bedroom + Shower', names.join('|'));
    check('only one panel open', (await yt.$$('.yts-panel-host')).length === 1);
    await yt.screenshot({ path: path.join(SHOTS, 'panel-open.png'), clip: await yt.locator('#movie_player').boundingBox() });

    await yt.locator('.yts-panel-host .key', { hasText: 'Dining Room' }).click();
    await sleep(700);
    check('panel shows Preparing state', (await yt.locator('.yts-panel-host .note').first().textContent()).includes('Preparing audio on Dining Room'));
    await yt.screenshot({ path: path.join(SHOTS, 'panel-preparing.png'), clip: await yt.locator('#movie_player').boundingBox() });
    await yt.locator('.yts-panel-host .note', { hasText: 'YouTube is paused' }).waitFor({ timeout: 15000 });
    await yt.screenshot({ path: path.join(SHOTS, 'panel-playing.png'), clip: await yt.locator('#movie_player').boundingBox() });

    const plays = await posts('/api/play');
    const b = plays.at(-1) && plays.at(-1).body;
    check('mock got exactly one /api/play', plays.length === 1, `${plays.length}`);
    check('play has the right videoId', b && b.videoId === WATCH_ID, b && b.videoId);
    check('play has the right groupId', b && b.groupId === DINING, b && b.groupId);
    check('play has startSeconds near 42', b && typeof b.startSeconds === 'number' && b.startSeconds >= 41 && b.startSeconds <= 46, b && String(b.startSeconds));
    check('play carries title and channel', b && /Rick Astley/i.test(b.title || '') && !!b.channel, b && `${b.title} / ${b.channel}`);
    check('play carries thumbnail', b && b.thumbnail === `https://i.ytimg.com/vi/${WATCH_ID}/hqdefault.jpg`);
    check('YouTube video paused after success', await isPaused(yt));
    console.log('   play body:', JSON.stringify(b));
    await yt.waitForSelector('.yts-panel-host', { state: 'detached', timeout: 6000 });
    check('panel closes itself after success', (await yt.$$('.yts-panel-host')).length === 0);
  });

  await step('Popup on the YouTube tab: now playing, pause, resume, volume, stop', async () => {
    const p = await context.newPage();
    await p.setViewportSize({ width: 344, height: 700 });
    await p.goto(popupUrl(`?tabId=${ytTabId}`));
    await p.waitForSelector('#np-sec');
    check('video card shows the tab title', /Rick Astley/i.test(await p.textContent('#v-title')), await p.textContent('#v-title'));
    check('last speaker (Dining Room) remembered from the panel', (await p.getAttribute('.key[aria-checked=true]', 'data-id')) === DINING);
    check('play key names the speaker', (await p.textContent('#play')) === 'Play on Dining Room');
    check('now playing shows the title', /Rick Astley/i.test(await p.textContent('#np-title')));
    const pos1 = await p.textContent('#np-pos');
    await sleep(4300);
    const pos2 = await p.textContent('#np-pos');
    check('progress readout advances while open (2 s poll)', pos1 !== pos2, `${pos1} -> ${pos2}`);
    const statusPolls = (await mock.requests()).filter((r) => r.path === '/api/status').length;
    check('popup polls /api/status', statusPolls >= 2, `${statusPolls} calls`);
    await popupShot(p, 'popup-now-playing.png');
    await p.emulateMedia({ colorScheme: 'dark' });
    await popupShot(p, 'popup-now-playing-dark.png');
    await p.emulateMedia({ colorScheme: 'light' });

    await p.click('#pause');
    await p.waitForSelector('#resume');
    let c = (await posts('/api/control')).at(-1);
    check('Pause sends control pause', c && c.body.action === 'pause' && c.body.groupId === DINING);
    check('mock group is paused', (await mock.status(DINING)).state === 'PAUSED_PLAYBACK');
    await popupShot(p, 'popup-paused.png');

    await p.click('#resume');
    await p.waitForSelector('#pause');
    c = (await posts('/api/control')).at(-1);
    check('Resume sends control resume', c && c.body.action === 'resume');

    const before = (await posts('/api/volume')).length;
    await p.evaluate(async () => {
      const r = document.querySelector('#vol');
      for (const v of [10, 13, 16, 19, 22]) {
        r.value = v;
        r.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 60));
      }
    });
    check('volume readout follows the fader at once', (await p.textContent('#vol-out')) === '22');
    await sleep(1200);
    const vols = (await posts('/api/volume')).slice(before);
    check('volume is debounced to one call', vols.length === 1, `${vols.length} calls`);
    check('volume call carries the final value', vols[0] && vols[0].body.volume === 22 && vols[0].body.groupId === DINING, vols[0] && JSON.stringify(vols[0].body));
    check('mock volume is now 22', (await mock.status(DINING)).volume === 22);

    await p.click('#stop');
    await p.waitForSelector('#np-sec', { state: 'detached' });
    c = (await posts('/api/control')).at(-1);
    check('Stop sends control stop and the card goes', c && c.body.action === 'stop');
    await p.close();
  });

  await step('Popup: play from the popup on another speaker, remembered next time', async () => {
    await mock.reset();
    await setTime(yt, 75);
    await sleep(600);
    check('YouTube playing before the popup play', !(await isPaused(yt)));
    const p = await context.newPage();
    await p.setViewportSize({ width: 344, height: 700 });
    await p.goto(popupUrl(`?tabId=${ytTabId}`));
    await p.waitForSelector('.key');
    await p.locator('.key', { hasText: 'Bedroom + Shower' }).click();
    check('play key relabels', (await p.textContent('#play')) === 'Play on Bedroom + Shower');
    await popupShot(p, 'popup-with-video.png');
    await p.click('#play');
    await sleep(700);
    check('popup shows Preparing state', (await p.textContent('#wait')).includes('Preparing audio on Bedroom + Shower'));
    await popupShot(p, 'popup-preparing.png');
    // Bedroom + Shower already shows a paused radio track, so wait for our title, not just the card.
    await p.locator('#np-title', { hasText: 'Rick Astley' }).waitFor({ timeout: 15000 });
    const b = (await posts('/api/play')).at(-1)?.body;
    check('popup play: right videoId and group', b && b.videoId === WATCH_ID && b.groupId === BEDROOM, b && JSON.stringify(b));
    check('popup play: startSeconds near 75', b && b.startSeconds >= 74 && b.startSeconds <= 80, b && String(b.startSeconds));
    await sleep(500);
    check('YouTube tab paused by the popup play', await isPaused(yt));
    await p.reload();
    await p.waitForSelector('.key');
    check('last speaker remembered after reopening', (await p.getAttribute('.key[aria-checked=true]', 'data-id')) === BEDROOM);

    await mock.config({ failPlay: "Couldn't get the audio for this video. It may be age restricted or private." });
    await p.click('#play');
    await p.waitForSelector('#problem', { timeout: 15000 });
    check('error from the companion shown plainly', (await p.textContent('#problem')).includes('age restricted'), (await p.textContent('#problem')).trim());
    await popupShot(p, 'popup-error.png');
    const badge = await swEval(() => chrome.action.getBadgeText({}));
    check('badge shows ERR after a failure', badge === 'ERR', badge);
    await p.click('#dismiss');
    await mock.config({ failPlay: null });
    await p.close();
  });

  await step('Context menu "Play on Sonos" on a YouTube link', async () => {
    await mock.reset();
    const r = await swEval(
      (id) => self.__yts.handleContextClick({ menuItemId: 'yts-play-on-sonos', linkUrl: `https://www.youtube.com/watch?v=${id}&t=1m5s` }),
      LINK_ID
    );
    check('handler resolved ok', r && r.ok, JSON.stringify(r && (r.error || r.data && r.data.state)));
    const b = (await posts('/api/play')).at(-1)?.body;
    check('context play uses the link videoId and t=', b && b.videoId === LINK_ID && b.startSeconds === 65, b && JSON.stringify(b));
    check('context play uses the last speaker', b && b.groupId === BEDROOM);
    const badge = await swEval(() => chrome.action.getBadgeText({}));
    check('badge says ON after the context play', badge === 'ON', badge);
    const short = await swEval(() => self.__yts.handleContextClick({ menuItemId: 'yts-play-on-sonos', linkUrl: 'https://youtu.be/jNQXAC9IVRw' }));
    check('youtu.be links work too', short && short.ok);
    const saved = await swEval(() => chrome.storage.local.get(['lastGroupId', 'lastGroupName']));
    await swEval(() => chrome.storage.local.remove('lastGroupId'));
    const none = await swEval(() => self.__yts.handleContextClick({ menuItemId: 'yts-play-on-sonos', linkUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }));
    const badge2 = await swEval(() => chrome.action.getBadgeText({}));
    check('no last speaker: refuses and badges SET', none && !none.ok && badge2 === 'SET', badge2);
    await swEval((s) => chrome.storage.local.set(s), saved);
    await swEval(() => chrome.action.setBadgeText({ text: '' }));
  });

  await step('SPA navigation keeps exactly one key', async () => {
    await yt.evaluate(() => (window.__ytsSameDocument = true));
    for (let hop = 1; hop <= 2; hop++) {
      const from = new URL(yt.url()).searchParams.get('v');
      const href = await yt.evaluate((cur) => {
        const a = Array.from(document.querySelectorAll('a[href^="/watch?v="]')).find((x) => {
          const v = new URL(x.href).searchParams.get('v');
          const r = x.getBoundingClientRect();
          return v && v !== cur && r.width > 0 && r.height > 0;
        });
        if (!a) return null;
        a.scrollIntoView({ block: 'center' });
        a.click();
        return a.getAttribute('href');
      }, from);
      if (!href) throw new Error('no related video link found');
      await yt.waitForURL((u) => new URL(u).searchParams.get('v') !== from, { timeout: 20000 });
      const to = new URL(yt.url()).searchParams.get('v');
      await sleep(4000);
      check(`hop ${hop}: ${from} -> ${to}, one key`, (await buttonCount(yt)) === 1, `${await buttonCount(yt)} keys`);
    }
    const spa = await yt.evaluate(() => window.__ytsSameDocument === true);
    check('navigation stayed in the SPA (same document, no reload)', spa);
    await readyVideo(yt);
    await mock.reset();
    await setTime(yt, 20);
    await sleep(500);
    await yt.click('.yts-sonos-button');
    await yt.waitForSelector('.yts-panel-host .key');
    await yt.locator('.yts-panel-host .key', { hasText: 'Dining Room' }).click();
    await yt.locator('.yts-panel-host .note', { hasText: 'YouTube is paused' }).waitFor({ timeout: 15000 });
    const b = (await posts('/api/play')).at(-1)?.body;
    const cur = new URL(yt.url()).searchParams.get('v');
    check('after SPA nav the panel sends the new videoId', b && b.videoId === cur, `${b && b.videoId} vs ${cur}`);
    check('after SPA nav the title is the new video', b && b.title && !/Rick Astley - Never Gonna/.test(b.title), b && b.title);
  });

  await step('Companion down', async () => {
    check(`port ${DEAD_PORT} is closed`, !(await portOpen(DEAD_PORT)));
    await swEval((u) => chrome.storage.local.set({ companionUrl: u }), `http://localhost:${DEAD_PORT}`);
    const p = await context.newPage();
    await p.setViewportSize({ width: 344, height: 640 });
    await p.goto(popupUrl(`?tabId=${ytTabId}`));
    await p.waitForSelector('#cmd');
    check('popup says the companion is not running', (await p.textContent('#main')).includes("The companion isn't running."));
    check('popup shows the start command', (await p.textContent('#cmd')) === 'launchctl kickstart -k gui/$(id -u)/com.youtube-to-sonos.companion');
    check('header lamp unlit, says Not running', (await p.textContent('#companion-state')) === 'Not running' && (await p.$('#companion-lamp.on')) == null);
    await popupShot(p, 'popup-offline.png');
    await p.emulateMedia({ colorScheme: 'dark' });
    await popupShot(p, 'popup-offline-dark.png');
    await p.emulateMedia({ colorScheme: 'light' });

    // The panel from the last step closes itself after success; wait so this click opens, not closes.
    await yt.waitForSelector('.yts-panel-host', { state: 'detached', timeout: 8000 });
    await yt.click('.yts-sonos-button');
    await yt.waitForSelector('.yts-panel-host .cmd');
    check('panel says the companion is not running', (await yt.locator('.yts-panel-host .note').first().textContent()).includes("The companion isn't running."));
    await yt.screenshot({ path: path.join(SHOTS, 'panel-offline.png'), clip: await yt.locator('#movie_player').boundingBox() });
    await yt.keyboard.press('Escape');

    await swEval((u) => chrome.storage.local.set({ companionUrl: u }), MOCK);
    await p.click('#retry');
    await p.waitForSelector('.key');
    check('Try again recovers once the companion is back', (await p.$$('.key')).length === 2);
    await p.close();
    await yt.mouse.click(5, 5);
  });

  await step('Shorts', async () => {
    await mock.reset();
    await yt.goto('https://www.youtube.com/shorts', { waitUntil: 'domcontentloaded' });
    await dismissConsent(yt);
    try {
      await yt.waitForURL(/\/shorts\/[\w-]{11}/, { timeout: 15000 });
    } catch {
      // /shorts didn't redirect to a Short this time. Take one from the home page instead.
      await yt.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
      const href = await yt.waitForFunction(() => document.querySelector('a[href^="/shorts/"]')?.getAttribute('href'), null, { timeout: 20000 });
      await yt.goto('https://www.youtube.com' + (await href.jsonValue()), { waitUntil: 'domcontentloaded' });
    }
    console.log('   short:', yt.url());
    await readyVideo(yt, 'shorts');
    await yt.waitForSelector('ytd-shorts-player-controls .yts-sonos-button', { timeout: 20000 });
    check('Shorts: exactly one key', (await buttonCount(yt)) === 1);
    const shortId = yt.url().match(/\/shorts\/([\w-]{11})/)[1];
    const box = await yt.locator('#shorts-player').boundingBox();
    await yt.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(300);
    await yt.screenshot({ path: path.join(SHOTS, 'shorts-button.png'), clip: { x: box.x, y: box.y, width: box.width, height: 140 } });
    await yt.click('.yts-sonos-button');
    await yt.waitForSelector('.yts-panel-host .key');
    await yt.screenshot({ path: path.join(SHOTS, 'panel-shorts.png'), clip: { x: box.x - 40, y: box.y, width: box.width + 80, height: box.height } });
    await yt.locator('.yts-panel-host .key', { hasText: 'Dining Room' }).click();
    await yt.locator('.yts-panel-host .note', { hasText: 'YouTube is paused' }).waitFor({ timeout: 15000 });
    const b = (await posts('/api/play')).at(-1)?.body;
    check('Shorts: mock got the Shorts videoId', b && b.videoId === shortId, `${b && b.videoId} vs ${shortId}`);
    check('Shorts: startSeconds is a number', b && typeof b.startSeconds === 'number', b && String(b.startSeconds));
    check('Shorts: video paused', await isPaused(yt, 'shorts'));
    console.log('   shorts play body:', JSON.stringify(b));

    const p = await context.newPage();
    await p.setViewportSize({ width: 344, height: 700 });
    await p.goto(popupUrl(`?tabId=${ytTabId}`));
    await p.waitForSelector('.key');
    check('popup recognises the Shorts tab', (await p.$('#v-title')) != null, (await p.$('#v-title')) ? await p.textContent('#v-title') : 'no video card');
    await popupShot(p, 'popup-shorts.png');
    await p.close();
  });

  if (!process.env.SKIP_LONG) {
    await step('Long play (25 s) survives the worker being stopped mid-call', async () => {
      await mock.reset();
      await mock.config({ playDelayMs: 25000 });
      await yt.goto(`https://www.youtube.com/watch?v=${WATCH_ID}`, { waitUntil: 'domcontentloaded' });
      await readyVideo(yt);
      await yt.waitForSelector('.yts-sonos-button');
      await setTime(yt, 30);
      await sleep(400);
      await yt.click('.yts-sonos-button');
      await yt.waitForSelector('.yts-panel-host .key');
      await yt.locator('.yts-panel-host .key', { hasText: 'Dining Room' }).click();
      await sleep(3000);
      // Stop the extension's worker from chrome://serviceworker-internals, as Chrome would when idle.
      const internals = await context.newPage();
      await internals.goto('chrome://serviceworker-internals/');
      await internals.waitForSelector('cr-button[data-command=stop]');
      const clicked = await internals.evaluate((id) => {
        const btn = Array.from(document.querySelectorAll('cr-button[data-command=stop]')).find((b) => (b.closest('.serviceworker-version') || b.parentElement.parentElement).textContent.includes(id));
        if (!btn) return false;
        btn.click();
        return true;
      }, extId);
      await internals.close();
      // Proof the worker really died: the mock sees the in-flight /api/play hang up.
      let aborted = false;
      for (let i = 0; i < 20 && !aborted; i++) {
        await sleep(250);
        aborted = !!(await posts('/api/play')).at(-1)?.aborted;
      }
      check('worker stopped mid-call: mock saw /api/play hang up', clicked && aborted, clicked ? 'Stop clicked' : 'Stop button not found');
      await yt.locator('.yts-panel-host .note', { hasText: 'YouTube is paused' }).waitFor({ timeout: 45000 });
      check('panel still reached "Playing" after the worker restart', true);
      const polls = (await mock.requests()).filter((r) => r.path === '/api/status').length;
      check('content script fell back to polling /api/status', polls >= 2, `${polls} status calls`);
      check('video paused after the long play', await isPaused(yt));
      // Read session storage from an extension page: Playwright doesn't always attach to a restarted worker.
      const ext = await context.newPage();
      await ext.goto(popupUrl());
      const pend = await ext.evaluate(() => chrome.storage.session.get('pending'));
      await ext.close();
      check('no stale pending job left behind', !pend.pending, JSON.stringify(pend));
      await mock.config({ playDelayMs: 2000 });
    });
  }
} finally {
  await context.close().catch(() => {});
  mockProc.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed:` : '.'}`);
failed.forEach((f) => console.log(`  FAIL ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
console.log(`Screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
