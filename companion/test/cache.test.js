import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yts-cache-test-'));
process.env.YTS_CACHE_DIR = dir;
const { cleanupCache } = await import('../youtube.js');

function make(id, ageDays, bytes) {
  const t = new Date(Date.now() - ageDays * 86400_000);
  for (const [ext, size] of [['mp3', bytes], ['jpg', 10], ['json', 10]]) {
    const f = path.join(dir, `${id}.${ext}`);
    fs.writeFileSync(f, Buffer.alloc(size));
    fs.utimesSync(f, t, t);
  }
}

test('cleanup drops files over 30 days old, temp leftovers and orphans', async () => {
  make('oldoldold01', 40, 100);
  make('newnewnew01', 1, 100);
  fs.mkdirSync(path.join(dir, '.tmp-abc-123'));
  fs.writeFileSync(path.join(dir, 'orphanxxx01.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'leave me');
  const r = await cleanupCache();
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['newnewnew01.jpg', 'newnewnew01.json', 'newnewnew01.mp3', 'notes.txt']);
  assert.equal(r.kept, 1);
  assert.equal(r.removed, 2);
});

test('cleanup trims to 2 GB, oldest first (sparse files)', async () => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true });
  const GB = 1024 ** 3;
  // Sparse files: big apparent size, no real disk use.
  const sparse = (id, ageDays, size) => {
    make(id, ageDays, 1);
    const f = path.join(dir, `${id}.mp3`);
    fs.truncateSync(f, Math.round(size));
    const t = new Date(Date.now() - ageDays * 86400_000);
    fs.utimesSync(f, t, t);
  };
  sparse('aaaaaaaaaa1', 10, 0.9 * GB);
  sparse('bbbbbbbbbb2', 5, 0.9 * GB);
  sparse('cccccccccc3', 1, 0.9 * GB);
  const r = await cleanupCache();
  const mp3s = fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort();
  assert.deepEqual(mp3s, ['bbbbbbbbbb2.mp3', 'cccccccccc3.mp3']);
  assert.ok(r.bytes <= 2 * GB);
  fs.rmSync(dir, { recursive: true, force: true });
});
