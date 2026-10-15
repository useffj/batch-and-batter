import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { processImage, limits } from '../src/process-image.mjs';
const expected = (bytes) => ({
  contentType: 'image/png',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});
const fixture = (width = 640, height = 480) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 160, g: 90, b: 50, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
test('synthetic image produces bounded JPEG/WebP variants with no upscaling or duplicate dimensions', async () => {
  const source = await fixture();
  const result = await processImage(source, expected(source));
  assert.equal(result.variants.length, 4);
  assert.deepEqual(
    result.variants.map((v) => [v.width, v.height]),
    [
      [480, 360],
      [480, 360],
      [640, 480],
      [640, 480],
    ],
  );
  for (const variant of result.variants) {
    const m = await sharp(variant.data).metadata();
    assert.equal(m.format, variant.format);
    assert.equal(m.hasAlpha, variant.format === 'webp');
    assert.equal(m.exif, undefined);
    assert.equal(m.icc, undefined);
    assert.ok(variant.bytes <= limits.variantBytes);
    assert.equal(
      variant.sha256,
      createHash('sha256').update(variant.data).digest('hex'),
    );
  }
});
test('orientation is applied before dimensions and source EXIF is stripped', async () => {
  const source = await sharp(await fixture(960, 480))
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const result = await processImage(source, {
    ...expected(source),
    contentType: 'image/jpeg',
  });
  assert.equal(result.width, 480);
  assert.equal(result.height, 960);
  for (const v of result.variants) {
    const m = await sharp(v.data).metadata();
    assert.equal(m.exif, undefined);
    assert.equal(m.orientation, undefined);
    assert.equal(m.width < m.height, true);
  }
});
test('all three accepted static input formats decode', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const source = await sharp(await fixture())
      .toFormat(format)
      .toBuffer();
    assert.ok(
      (
        await processImage(source, {
          ...expected(source),
          contentType: `image/${format}`,
        })
      ).variants.length,
    );
  }
});
test('byte limits, declared length and checksum fail before decoding', async () => {
  const source = await fixture();
  await assert.rejects(
    processImage(source, { ...expected(source), bytes: 1 }),
    /IMAGE_SIZE_INVALID/,
  );
  await assert.rejects(
    processImage(source, { ...expected(source), sha256: '0'.repeat(64) }),
    /IMAGE_CHECKSUM_INVALID/,
  );
  const huge = Buffer.alloc(limits.inputBytes + 1);
  await assert.rejects(
    processImage(huge, expected(huge)),
    /IMAGE_SIZE_INVALID/,
  );
});
test('SVG, GIF, video, random data and MIME mismatch are rejected', async () => {
  for (const value of ['<svg/>', 'GIF89a', 'ftypmp42', 'not an image']) {
    const source = Buffer.from(value);
    await assert.rejects(
      processImage(source, expected(source)),
      /IMAGE_SIGNATURE_INVALID/,
    );
  }
  const source = await fixture();
  await assert.rejects(
    processImage(source, { ...expected(source), contentType: 'image/jpeg' }),
    /IMAGE_MIME_MISMATCH/,
  );
});
test('minimum applies to both axes; maximum axis and pixel bounds reject large decoded images', async () => {
  for (const [width, height] of [
    [640, 479],
    [479, 640],
    [8001, 480],
    [5000, 4001],
  ]) {
    const source = await fixture(width, height);
    await assert.rejects(
      processImage(source, expected(source)),
      /IMAGE_DIMENSIONS_INVALID|IMAGE_DECODE_FAILED/,
    );
  }
});
test('APNG animation control and WebP animation flag are rejected independently of decoder behavior', async () => {
  const png = await fixture();
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write('acTL', 4);
  const apng = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
  await assert.rejects(processImage(apng, expected(apng)), /IMAGE_ANIMATED/);
  const webp = await sharp(png).webp().toBuffer();
  assert.equal(webp.toString('ascii', 12, 16), 'VP8X');
  webp[20] |= 2;
  await assert.rejects(
    processImage(webp, { ...expected(webp), contentType: 'image/webp' }),
    /IMAGE_ANIMATED/,
  );
});
test('malformed/truncated image failures are sanitized', async () => {
  const png = (await fixture()).subarray(0, 50);
  await assert.rejects(processImage(png, expected(png)), {
    name: 'InvalidImage',
    message: 'IMAGE_MALFORMED',
  });
  const jpeg = Buffer.from([255, 216, 255, 0, 0, 0]);
  await assert.rejects(
    processImage(jpeg, { ...expected(jpeg), contentType: 'image/jpeg' }),
    { name: 'InvalidImage', message: 'IMAGE_DECODE_FAILED' },
  );
});
test('large input generates all six bounded variants in order', async () => {
  const source = await fixture(2000, 1800);
  const result = await processImage(source, expected(source));
  assert.deepEqual(
    result.variants.map((v) => v.size),
    [480, 480, 960, 960, 1600, 1600],
  );
  assert.ok(
    result.variants.reduce((n, v) => n + v.bytes, 0) <= limits.totalBytes,
  );
});
test('high entropy image is rejected when a generated variant exceeds the byte ceiling', async () => {
  // Deterministic synthetic noise; no photographs or customer data.
  const data = Buffer.alloc(1600 * 1600 * 3);
  let state = 123456789;
  for (let i = 0; i < data.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 255;
  }
  const source = await sharp(data, {
    raw: { width: 1600, height: 1600, channels: 3 },
  })
    .png()
    .toBuffer();
  assert.ok(source.length <= limits.inputBytes);
  await assert.rejects(
    processImage(source, expected(source)),
    /IMAGE_OUTPUT_TOO_LARGE/,
  );
});
