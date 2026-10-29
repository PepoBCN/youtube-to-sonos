// Live end-to-end test: real YouTube page, real companion on 8787, one real speaker.
// Plays at volume 6 for a few seconds, then stops and puts the volume back.
// It replaces whatever that speaker was playing, so pick one that's idle.
//
//   SPEAKER="Kitchen" node tests/live-e2e.mjs

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const SHOTS = path.join(here, 'screenshots');
const API = 'http://localhost:8787/api';
const VIDEO = 'dQw4w9WgXcQ';
const START = 30;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const req = createRequire(path.join(execSync('npm root -g').toString().trim(), 'noop.js'));
  ({ chromium } = req('playwright'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, body) =>
  (await fetch(`${API}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const SPEAKER = process.env.SPEAKER;
if (!SPEAKER) {
  console.error('Set SPEAKER to the room name of an idle speaker, e.g. SPEAKER="Kitchen" node tests/live-e2e.mjs');
  process.exit(2);
}
const group = (await api('/speakers')).groups.find((g) => g.name === SPEAKER);
if (!group) {
  console.error(`No speaker group called "${SPEAKER}".`);
  process.exit(2);
}
const GROUP = group.id;
const before = await api(`/status?groupId=${GROUP}`);
const oldVolume = before.volume;
console.log(`${SPEAKER} before: ${before.state}, volume ${oldVolume}`);
await api('/volume', { groupId: GROUP, volume: 6 });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yts-live-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  viewport: { width: 1280, height: 800 },
  locale: 'en-GB',
});
await context.addCookies([{ name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/', secure: true }]);
const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const extId = sw.url().split('/')[2];

try {
  const yt = await context.newPage();
  await yt.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded' });
  const consent = yt.locator('button:visible', { hasText: /^(Reject all|Accept all)$/ }).first();
  if (await consent.count()) await consent.click();
  await yt.waitForSelector('#movie_player video', { timeout: 30000 });
  for (let i = 0; i < 40; i++) {
    if (!(await yt.evaluate(() => document.querySelector('#movie_player')?.classList.contains('ad-showing')))) break;
    const skip = yt.locator('.ytp-skip-ad-button:visible, .ytp-ad-skip-button-modern:visible').first();
    if (await skip.count()) await skip.click().catch(() => {});
    await sleep(1000);
  }
  await yt.evaluate((t) => {
    const v = document.querySelector('#movie_player video');
    v.muted = true;
    v.currentTime = t;
    return v.play().catch(() => {});
  }, START);
  await yt.waitForSelector('#movie_player .ytp-right-controls .yts-sonos-button', { timeout: 20000 });
  check('speaker button in the real YouTube player', true);

  const box = await yt.locator('#movie_player').boundingBox();
  await yt.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await yt.click('.yts-sonos-button');
  await yt.waitForSelector('.yts-panel-host .key', { timeout: 15000 });
  const names = await yt.$$eval('.yts-panel-host', (h) => Array.from(h[0].shadowRoot.querySelectorAll('.name')).map((e) => e.textContent));
  check('panel lists the real speakers', names.includes(SPEAKER), names.join(' | '));
  await yt.screenshot({ path: path.join(SHOTS, 'live-panel.png') });

  const t0 = Date.now();
  await yt.locator('.yts-panel-host .key', { hasText: SPEAKER }).click();
  await yt.locator('.yts-panel-host .note', { hasText: 'YouTube is paused' }).waitFor({ timeout: 90000 });
  check('panel reports playing and YouTube paused', true, `${((Date.now() - t0) / 1000).toFixed(1)} s from click`);
  check('YouTube tab video is paused', await yt.evaluate(() => document.querySelector('#movie_player video').paused));

  await sleep(4000);
  const s = await api(`/status?groupId=${GROUP}`);
  check(`${SPEAKER} is PLAYING our track`, s.state === 'PLAYING' && s.isOurs && s.videoId === VIDEO, `${s.state} ${s.videoId} "${s.title}"`);
  check('it started near the YouTube position', s.position >= START - 2 && s.position <= START + 15, `position ${s.position}s of ${s.duration}s`);
  check('volume left at the test level', s.volume === 6, `volume ${s.volume}`);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#stop', { timeout: 15000 });
  const text = await popup.locator('body').innerText();
  check('popup shows now playing', text.includes('Rick Astley'), text.split('\n').slice(0, 6).join(' / '));
  await popup.locator('body').screenshot({ path: path.join(SHOTS, 'live-popup-now-playing.png') });
  await popup.click('#pause');
  await sleep(2500);
  check('popup pause works on the speaker', (await api(`/status?groupId=${GROUP}`)).state === 'PAUSED_PLAYBACK');
  await popup.waitForSelector('#stop');
  await popup.click('#stop');
  await sleep(2500);
  check('popup stop works on the speaker', (await api(`/status?groupId=${GROUP}`)).state === 'STOPPED');
} catch (e) {
  check('ran without throwing', false, e.message.split('\n')[0]);
} finally {
  await api('/control', { groupId: GROUP, action: 'stop' }).catch(() => {});
  await api('/volume', { groupId: GROUP, volume: oldVolume });
  const after = await api(`/status?groupId=${GROUP}`);
  console.log(`${SPEAKER} after: ${after.state}, volume ${after.volume}`);
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
