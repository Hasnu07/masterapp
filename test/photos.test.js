import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, samePicture, dhashDistance, worstPatch } from '../src/storage/index.js';
import { picture } from './fakes.js';

/*
 * Recognising the same picture — no database. The line between "saved again"
 * and "edited" was measured on the vault's real pairs (storage/index.js).
 */

test('the same picture saved again is the same picture', async () => {
  const a = await picture(1);
  assert.ok(await samePicture(a, await picture(1, { quality: 70 })), 'another JPEG quality');
  assert.ok(await samePicture(a, await picture(1, { format: 'png' })), 'another format');
  assert.ok(await samePicture(a, Buffer.from(a)), 'the same bytes');
});

test('a copy with a patch hidden is a picture of its own', async () => {
  const a = await picture(1);
  const hidden = await picture(1, { box: true });
  const [fa, fh] = [await fingerprint(a), await fingerprint(hidden)];
  assert.ok(dhashDistance(fa.dhash, fh.dhash) <= 8, 'close enough to be a candidate…');
  assert.equal(await samePicture(a, hidden), false, '…but one block differs, so it is kept');
});

test('a small edit is caught wherever it falls — the window slides', () => {
  // A 4x4 patch 16 grey levels lighter. Placed across the corner where four
  // fixed 8x8 squares meet, each square would see a quarter of it (1.0, a
  // pass); every 8x8 window that covers it whole sees 4.0 — over the line.
  const N = 256;
  const plain = Buffer.alloc(N * N, 100);
  for (const [x0, y0] of [[6, 6], [14, 30], [100, 100], [250, 2]]) {
    const edited = Buffer.from(plain);
    for (let y = y0; y < y0 + 4; y += 1) for (let x = x0; x < x0 + 4; x += 1) edited[y * N + x] = 116;
    assert.equal(worstPatch(plain, edited), 4, `patch at ${x0},${y0}`);
  }
  assert.equal(worstPatch(plain, Buffer.from(plain)), 0);
});

test('another size or another picture is not the same', async () => {
  const a = await picture(1);
  assert.equal(await samePicture(a, await picture(1, { width: 450 })), false, 'too like an edit to call');
  assert.equal(await samePicture(a, await picture(2)), false);
});

test('a fingerprint: exact bytes, a 64-bit hash, the size as shown', async () => {
  const f = await fingerprint(await picture(1));
  assert.match(f.sha256, /^[0-9a-f]{64}$/);
  assert.match(f.dhash, /^[0-9a-f]{16}$/);
  assert.equal(f.width, 900);
  assert.equal(f.height, 700);
  assert.equal(f.content_type, 'image/jpeg');
  await assert.rejects(fingerprint(Buffer.from('not a picture')), { status: 415 });
});
