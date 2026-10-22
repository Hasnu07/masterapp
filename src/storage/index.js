import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from '../config.js';

/*
 * Where photos live: Cloudflare R2 when it is configured, otherwise the disk
 * under DATA_DIR (on Railway, the volume). Same three calls either way, so
 * nothing above this file knows or cares which.
 *
 * Keys are generated here, never taken from a request, and the disk driver
 * refuses anything that is not one of ours — a key is a path on the disk.
 */

const KEY = /^photos\/[0-9a-f]{2}\/[0-9a-f]{32}(-t)?\.(jpg|png|webp|gif)$/;

function diskDriver(dir) {
  const full = (key) => {
    if (!KEY.test(key)) throw new Error(`not a storage key: ${key}`);
    return path.join(dir, key);
  };
  return {
    name: 'disk',
    async put(key, buffer) {
      const file = full(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Temp name then rename: a half-written file served as a photo is a
      // broken picture that then sits there looking valid.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
    },
    async get(key) {
      try {
        return fs.readFileSync(full(key));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async remove(key) {
      fs.rmSync(full(key), { force: true });
    },
  };
}

async function r2Driver(r2) {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: r2.endpoint || `https://${r2.accountId}.r2.cloudflarestorage.com`,
    // R2 takes either addressing style; path style also works with any
    // S3-compatible stand-in, which is what the tests run against.
    forcePathStyle: true,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  });
  return {
    name: 'r2',
    async put(key, buffer, type) {
      await client.send(new PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: buffer, ContentType: type }));
    },
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
    },
  };
}

let driver = null;
export async function storage() {
  if (!driver) driver = config.r2.configured ? await r2Driver(config.r2) : diskDriver(config.dataDir);
  return driver;
}

/* For tests: point the store somewhere else. */
export function useDisk(dir) {
  driver = diskDriver(dir);
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const THUMB_EDGE = 480;

/** A picture's format and size, or a 415 for anything else. */
async function pictureMeta(buffer) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw Object.assign(new Error('That file is not a picture this app can read'), { status: 415 });
  }
  const type = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[meta.format];
  if (!type) {
    throw Object.assign(new Error(`Pictures must be JPEG, PNG, WebP or GIF (this one is ${meta.format})`), {
      status: 415,
    });
  }
  // Width and height as the picture is SHOWN: EXIF orientation 5-8 is sideways.
  const sideways = meta.orientation >= 5;
  return {
    meta,
    type,
    width: (sideways ? meta.height : meta.width) || null,
    height: (sideways ? meta.width : meta.height) || null,
  };
}

/*
 * Recognising the same picture under another address.
 *
 * Chrono Key's gallery and the vault both list the same picture more than
 * once under different file names, and the two often hold the same pictures
 * (first live copy, 22 Oct 2026: 177 byte-for-byte repeats on 273 watches).
 *
 * But "looks the same" is NOT the test. The vault keeps EDITED versions next
 * to the originals — the purchase date wiped off the papers, the serial on
 * the card hidden, a white box over the label — for sending to clients. Those
 * differ from the original in one small patch and are otherwise identical, so
 * an average difference cannot tell them from a re-save (stock 1650: average
 * 0.04, yet the date is gone). The test is the WORST patch: an 8x8 window is
 * slid over the whole picture (at 256x256) and must match everywhere.
 * Sliding, not fixed squares: an edit that straddles the corners of fixed
 * squares is split four ways and can pass (stock 1688's painted-over strip
 * did, at some positions). Measured on the vault's own pairs, a re-save of
 * the same picture reaches 1.83 at most and the smallest real edit never
 * drops below 3.48 wherever it falls; the line is drawn at 2.5. Same width and
 * height only: the same picture saved at another size differs everywhere
 * along its edges, too much like an edit to call, so both are kept.
 */
const SAME_GRID = 256;
const SAME_WINDOW = 8;
const SAME_LIMIT = 2.5;

/**
 * What a picture is recognised by: its exact bytes, a 64-bit difference hash
 * (to pick candidates cheaply), and its shown size.
 * @returns {{sha256, dhash, width, height, content_type, bytes}}
 */
export async function fingerprint(buffer) {
  const { type, width, height } = await pictureMeta(buffer);
  const px = await sharp(buffer).rotate().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  }
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    dhash: bits.toString(16).padStart(16, '0'),
    width,
    height,
    content_type: type,
    bytes: buffer.length,
  };
}

/** How many of the 64 bits two difference hashes disagree on. */
export function dhashDistance(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * The worst average difference of any 8x8 window, at every position, between
 * two 256x256 grey pictures (an integral image keeps every position cheap).
 */
export function worstPatch(x, y) {
  const N = SAME_GRID;
  const W = N + 1;
  const sum = new Float64Array(W * W);
  for (let j = 0; j < N; j += 1) {
    let row = 0;
    for (let i = 0; i < N; i += 1) {
      row += Math.abs(x[j * N + i] - y[j * N + i]);
      sum[(j + 1) * W + i + 1] = sum[j * W + i + 1] + row;
    }
  }
  const K = SAME_WINDOW;
  let worst = 0;
  for (let j = 0; j + K <= N; j += 1) {
    for (let i = 0; i + K <= N; i += 1) {
      const s = sum[(j + K) * W + i + K] - sum[j * W + i + K] - sum[(j + K) * W + i] + sum[j * W + i];
      if (s > worst) worst = s;
    }
  }
  return worst / (K * K);
}

/** The same picture, only saved again? Every patch must match (see above). */
export async function samePicture(a, b) {
  const [fa, fb] = await Promise.all([pictureMeta(a), pictureMeta(b)]);
  if (fa.width !== fb.width || fa.height !== fb.height) return false;
  const grey = (buf) =>
    sharp(buf).rotate().grayscale().resize(SAME_GRID, SAME_GRID, { fit: 'fill' }).raw().toBuffer();
  const [x, y] = await Promise.all([grey(a), grey(b)]);
  return worstPatch(x, y) <= SAME_LIMIT;
}

/**
 * Stores one photo and its thumbnail.
 *
 * The ORIGINAL is kept exactly as it came — this is the archive copy of a
 * watch's photographs, and re-encoding it would lose quality for nothing. The
 * thumbnail is what grids show: a page of 80 full photos is ~50 MB.
 *
 * @returns {{storage_key, thumb_key, content_type, bytes, width, height}}
 */
export async function savePhoto(buffer) {
  const { type, width, height } = await pictureMeta(buffer);

  const id = crypto.randomBytes(16).toString('hex');
  const base = `photos/${id.slice(0, 2)}/${id}`;
  const key = `${base}.${EXT[type]}`;
  const thumbKey = `${base}-t.jpg`;

  // .rotate() with no argument applies the EXIF orientation, so a phone photo
  // taken sideways is not shown sideways in the grid.
  const thumb = await sharp(buffer)
    .rotate()
    .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();

  const s = await storage();
  await s.put(key, buffer, type);
  await s.put(thumbKey, thumb, 'image/jpeg');

  return {
    storage_key: key,
    thumb_key: thumbKey,
    content_type: type,
    bytes: buffer.length,
    width,
    height,
  };
}
