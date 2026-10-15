const fs = require('node:fs');
const assert = require('node:assert/strict');
const API = 'ApplicationApi5D63FF39';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function compareTemplates(baseline, candidate, approvedApiCode) {
  if (
    !baseline?.Resources ||
    !candidate?.Resources ||
    !baseline.Resources[API] ||
    !candidate.Resources[API]
  )
    throw Error('INVALID_TEMPLATE');
  const expected = structuredClone(baseline);
  if (approvedApiCode !== undefined) {
    if (
      !approvedApiCode ||
      !Object.hasOwn(approvedApiCode, 'S3Bucket') ||
      !Object.hasOwn(approvedApiCode, 'S3Key') ||
      Object.keys(approvedApiCode).some(
        (k) => !['S3Bucket', 'S3Key', 'S3ObjectVersion'].includes(k),
      )
    )
      throw Error('INVALID_APPROVED_API_CODE');
    expected.Resources[API].Properties.Code = approvedApiCode;
  }
  assert.deepStrictEqual(
    canonical(candidate),
    canonical(expected),
    'UNAPPROVED_TEMPLATE_CHANGE',
  );
  return true;
}
module.exports = { compareTemplates };
if (require.main === module) {
  try {
    if (![4, 5].includes(process.argv.length))
      throw Error(
        'Usage: compare-templates baseline.json candidate.json [approved-api-code.json]',
      );
    const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
    compareTemplates(
      read(process.argv[2]),
      read(process.argv[3]),
      process.argv[4] ? read(process.argv[4]) : undefined,
    );
    console.log(
      'Exact allowed template comparison passed; not deployment authorization or proof of baseline freshness.',
    );
  } catch {
    console.error('TEMPLATE_COMPARISON_FAILED');
    process.exitCode = 1;
  }
}
