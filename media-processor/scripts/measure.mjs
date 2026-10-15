import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(
  new URL('../out/host/package.json', import.meta.url),
);
if (!process.argv.includes('--child')) {
  for (const dimensions of ['640x480', '1600x1200', '5000x4000', '8001x480'])
    console.log(
      execFileSync(
        process.execPath,
        [new URL(import.meta.url).pathname, '--child', dimensions],
        { encoding: 'utf8' },
      ).trim(),
    );
} else {
  const sharp = require('sharp');
  const { createProcessor } = require('./index.cjs');
  const [width, height] = process.argv.at(-1).split('x').map(Number);
  const bytes = await sharp({
    create: { width, height, channels: 3, background: '#9b643c' },
  })
    .png()
    .toBuffer();
  const variants = [];
  let failed = false;
  const worker = createProcessor(
    {
      claim: async () => ({
        state: 'PROCESSING',
        request: {
          bytes: bytes.length,
          contentType: 'image/png',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      }),
      complete: async () => {},
      failProcessing: async () => {
        failed = true;
      },
    },
    {
      source: async () => bytes,
      output: async (i, a, v) => {
        variants.push({
          format: v.format,
          bytes: v.data.length,
          width: v.width,
          height: v.height,
        });
        return 'synthetic-measurement-only';
      },
    },
  );
  const start = performance.now();
  const result = await worker({
    version: 1,
    productId: '01K00000000000000000000001',
    subject: 'synthetic-resource-test',
    uploadId: 'a'.repeat(64),
  });
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      width,
      height,
      inputBytes: bytes.length,
      durationMs: Math.round(performance.now() - start),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
      variants,
      result,
      failed,
      limitation:
        'Whole-process peak includes fixture generation; local host, not AWS Lambda',
    }),
  );
}
