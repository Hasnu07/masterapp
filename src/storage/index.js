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

  const sideways = meta.orientation >= 5;
  return {
    storage_key: key,
    thumb_key: thumbKey,
    content_type: type,
    bytes: buffer.length,
    width: (sideways ? meta.height : meta.width) || null,
    height: (sideways ? meta.width : meta.height) || null,
  };
}
