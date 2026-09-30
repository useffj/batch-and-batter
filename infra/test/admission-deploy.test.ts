import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const { deployArgs } = require(
  resolve(process.cwd(), 'scripts/deploy-dev.cjs'),
) as {
  deployArgs: (args: string[]) => string[];
};
test('normal dev deployment explicitly relocks false while preserving all other parameters', () => {
  const expected = [
    'cdk',
    'deploy',
    'batch-and-batter-dev',
    '--profile',
    'batch-and-batter-dev',
    '--previous-parameters',
    'true',
    '--parameters',
    'batch-and-batter-dev:PaymentStartEnabled=false',
  ];
  assert.deepEqual(deployArgs([]), expected);
  assert.deepEqual(deployArgs(['--payment-start-enabled=false']), expected);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts['deploy:dev'], 'node scripts/deploy-dev.cjs');
});
test('deliberate true override changes only the admission parameter; later default relocks false', () => {
  const normal = deployArgs([]);
  const enabled = deployArgs(['--payment-start-enabled=true']);
  assert.deepEqual(enabled.slice(0, -1), normal.slice(0, -1));
  assert.equal(enabled.at(-1), 'batch-and-batter-dev:PaymentStartEnabled=true');
  assert.equal(
    deployArgs([]).at(-1),
    'batch-and-batter-dev:PaymentStartEnabled=false',
  );
});
test('deployment helper rejects ambiguous values and parameter/profile bypasses without running CDK', () => {
  for (const args of [
    ['--payment-start-enabled=TRUE'],
    ['--payment-start-enabled=1'],
    ['--parameters', 'PaymentStartEnabled=true'],
    ['--previous-parameters=false'],
    ['--profile=other'],
    ['--payment-start-enabled=true', '--payment-start-enabled=false'],
  ]) {
    assert.throws(() => deployArgs(args));
  }
});
