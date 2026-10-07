import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const { deployArgs } = require(
  resolve(process.cwd(), 'scripts/deploy-dev.cjs'),
) as {
  deployArgs: (args: unknown, config?: unknown) => string[];
};
test('normal dev deployment explicitly relocks false with explicit DEV account and ledger configuration', () => {
  const expected = [
    'cdk',
    'deploy',
    'batch-and-batter-dev',
    '--profile',
    'batch-and-batter-dev',
    '--previous-parameters',
    'true',
    '--context',
    'environment=dev',
    '--parameters',
    'batch-and-batter-dev:StripeSandboxAccountId=acct_1UL8LdDz3QSwRsAl',
    '--parameters',
    'batch-and-batter-dev:DevPaymentLedgerNamespace=dev:acct_1UL8xeDXKfaUH9bm',
    '--parameters',
    'batch-and-batter-dev:DevPaymentLedgerAccountId=acct_1UL8LdDz3QSwRsAl',
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

const validConfig = {
  Environment: 'dev',
  StripeSandboxAccountId: 'acct_actual',
  DevPaymentLedgerNamespace: 'dev:acct_historical',
  DevPaymentLedgerAccountId: 'acct_actual',
};
test('configuration validation rejects unexpected/missing keys, invalid types, environment and bindings', () => {
  const invalid: unknown[] = [
    null,
    [],
    'dev',
    1,
    { ...validConfig, Extra: 'bad' },
    { ...validConfig, PaymentStartEnabled: 'true' },
    { ...validConfig, Environment: 'production' },
    { ...validConfig, DevPaymentLedgerAccountId: 'acct_other' },
    { ...validConfig, DevPaymentLedgerNamespace: 'live:acct_historical' },
    {
      ...validConfig,
      DevPaymentLedgerNamespace: 'dev:acct_' + 'a'.repeat(100),
    },
  ];
  for (const key of Object.keys(validConfig)) {
    const missing = { ...validConfig } as Record<string, unknown>;
    delete missing[key];
    invalid.push(missing);
    for (const value of [
      undefined,
      null,
      1,
      true,
      {},
      [],
      '',
      'invalid',
      ' dev',
      'acct_bad\n',
    ])
      invalid.push({ ...validConfig, [key]: value });
  }
  for (const config of invalid)
    assert.throws(() => deployArgs([], config), /INVALID_DEV_PAYMENT_CONFIG/);
  assert.ok(
    deployArgs([], validConfig).includes(
      'batch-and-batter-dev:DevPaymentLedgerNamespace=dev:acct_historical',
    ),
  );
});
test('only explicit literal admission arguments are accepted', () => {
  for (const args of [
    null,
    {},
    'true',
    [true],
    [undefined],
    ['--payment-start-enabled=true\n'],
    ['--payment-start-enabled=true '],
  ])
    assert.throws(() => deployArgs(args, validConfig));
});
