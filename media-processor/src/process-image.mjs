import { createHash } from 'node:crypto';
import sharp from 'sharp';

sharp.concurrency(1);
sharp.cache(false);
export const limits = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  minAxis: 480,
  maxAxis: 8000,
  pixels: 20_000_000,
  variantBytes: 1024 * 1024,
  totalBytes: 6 * 1024 * 1024,
});
export const cream = '#f4efe6'; // Existing media-panel cream, not a new UI color.
export class InvalidImage extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'InvalidImage';
  }
}
/** @param {Buffer} bytes */
function signature(bytes) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  throw new InvalidImage('IMAGE_SIGNATURE_INVALID');
}
/** Reject animation containers even when a decoder reports only a default frame.
 * @param {Buffer} bytes @param {string} mime */
function rejectAnimation(bytes, mime) {
  if (mime === 'image/png') {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12)
        throw new InvalidImage('IMAGE_MALFORMED');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (['acTL', 'fcTL', 'fdAT'].includes(type))
        throw new InvalidImage('IMAGE_ANIMATED');
      offset += length + 12;
      if (type === 'IEND') {
        if (offset !== bytes.length) throw new InvalidImage('IMAGE_MALFORMED');
        return;
      }
    }
    throw new InvalidImage('IMAGE_MALFORMED');
  }
  if (mime === 'image/webp') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length)
      throw new InvalidImage('IMAGE_MALFORMED');
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      if (size > bytes.length - offset - 8)
        throw new InvalidImage('IMAGE_MALFORMED');
      if (
        type === 'ANIM' ||
        type === 'ANMF' ||
        (type === 'VP8X' && size > 0 && bytes[offset + 8] & 2)
      )
        throw new InvalidImage('IMAGE_ANIMATED');
      offset += 8 + size + (size % 2);
    }
    if (offset !== bytes.length) throw new InvalidImage('IMAGE_MALFORMED');
  }
}
/** No network, logging, storage writes or publication. Caller supplies ONE bounded
 * storage read and must commit the resulting metadata under its processing lease.
 * @param {Buffer} bytes
 * @param {{contentType: string, bytes: number, sha256: string}} expected */
export async function processImage(bytes, expected) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > limits.inputBytes ||
    bytes.length !== expected.bytes
  )
    throw new InvalidImage('IMAGE_SIZE_INVALID');
  if (
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  )
    throw new InvalidImage('IMAGE_CHECKSUM_INVALID');
  const mime = signature(bytes);
  if (mime !== expected.contentType)
    throw new InvalidImage('IMAGE_MIME_MISMATCH');
  rejectAnimation(bytes, mime);
  try {
    const options = {
      limitInputPixels: limits.pixels,
      failOn: /** @type {const} */ ('warning'),
      sequentialRead: true,
    };
    const metadata = await sharp(bytes, options).metadata();
    const expectedFormat = mime.slice(6);
    if (metadata.format !== expectedFormat || (metadata.pages ?? 1) !== 1)
      throw new InvalidImage('IMAGE_FORMAT_INVALID');
    const { width, height } = metadata;
    if (
      !width ||
      !height ||
      Math.min(width, height) < limits.minAxis ||
      Math.max(width, height) > limits.maxAxis ||
      width * height > limits.pixels
    )
      throw new InvalidImage('IMAGE_DIMENSIONS_INVALID');
    // Decode once, apply orientation and discard all source metadata before encoding.
    const decoded = await sharp(bytes, options)
      .autoOrient()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = {
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    };
    const dimensions = new Set();
    const variants = [];
    let total = 0;
    for (const size of [480, 960, 1600]) {
      const ratio = Math.min(1, size / Math.max(raw.width, raw.height));
      const width = Math.round(raw.width * ratio),
        height = Math.round(raw.height * ratio);
      const dimension = `${width}x${height}`;
      if (dimensions.has(dimension)) continue;
      dimensions.add(dimension);
      for (const format of /** @type {const} */ (['webp', 'jpeg'])) {
        let pipeline = sharp(decoded.data, { raw }).resize({
          width,
          height,
          fit: 'fill',
          withoutEnlargement: true,
        });
        if (format === 'jpeg')
          pipeline = pipeline
            .flatten({ background: cream })
            .jpeg({ quality: 82 });
        else pipeline = pipeline.webp({ quality: 80 });
        const output = await pipeline.toBuffer({ resolveWithObject: true });
        total += output.data.length;
        if (
          output.data.length > limits.variantBytes ||
          total > limits.totalBytes
        )
          throw new InvalidImage('IMAGE_OUTPUT_TOO_LARGE');
        variants.push({
          size,
          format,
          width: output.info.width,
          height: output.info.height,
          bytes: output.data.length,
          sha256: createHash('sha256').update(output.data).digest('hex'),
          data: output.data,
        });
      }
    }
    return {
      processingVersion: /** @type {const} */ (1),
      width: raw.width,
      height: raw.height,
      variants,
    };
  } catch (error) {
    if (error instanceof InvalidImage) throw error;
    // Do not leak native decoder messages or source metadata to API/log consumers.
    throw new InvalidImage('IMAGE_DECODE_FAILED');
  }
}
