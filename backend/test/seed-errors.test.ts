import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { runSeed } from '../tools/seed-dev';
import {
  buildSeedPlan,
  parseSeedOptions,
  seedTransaction,
  DEV_TABLE,
} from '../tools/seed-plan';

const args = [
  '--table',
  DEV_TABLE,
  '--opens-at',
  '2099-10-05T18:00:00.000Z',
  '--pickup-dates',
  '2099-10-08,2099-10-09,2099-10-10',
];
const now = new Date('2099-10-01T00:00:00.000Z');
function harness(failure?: unknown, setupFailure = false) {
  const logs: string[] = [],
    errors: string[] = [];
  let clients = 0,
    sends = 0,
    destroys = 0;
  return {
    logs,
    errors,
    counts: () => ({ clients, sends, destroys }),
    run: (input: string[]) =>
      runSeed(input, {
        environment: {},
        now: () => now,
        log: (message) => {
          logs.push(message);
        },
        error: (message) => {
          errors.push(message);
        },
        createClient: () => {
          clients++;
          if (setupFailure) throw failure;
          return {
            send: async (command) => {
              sends++;
              assert.deepEqual(
                command.input,
                seedTransaction(buildSeedPlan(parseSeedOptions(args, {}), now))
                  .input,
              );
              if (failure) throw failure;
            },
            destroy: () => {
              destroys++;
            },
          };
        },
      }),
  };
}
const missingMessage =
  'Development seed preview/validation failed: Provide --opens-at (UTC ISO timestamp) and --pickup-dates (three comma-separated YYYY-MM-DD dates). No AWS request was attempted.';
for (const flag of ['--opens-at', '--pickup-dates']) {
  test(`missing ${flag} exposes the cause with zero AWS calls`, async () => {
    const h = harness();
    const input = [...args];
    input.splice(input.indexOf(flag), 2);
    assert.equal(await h.run(input), 1);
    assert.deepEqual(h.errors, [missingMessage]);
    assert.deepEqual(h.logs, []);
    assert.deepEqual(h.counts(), { clients: 0, sends: 0, destroys: 0 });
  });
}
test('invalid pickup date reports the Zod cause before any AWS activity', async () => {
  const h = harness();
  const input = [...args];
  input[5] = '2099-02-30,2099-10-09,2099-10-10';
  assert.equal(await h.run(input), 1);
  assert.deepEqual(h.errors, [
    'Development seed preview/validation failed: value: Invalid ISO date. No AWS request was attempted.',
  ]);
  assert.deepEqual(h.counts(), { clients: 0, sends: 0, destroys: 0 });
});
test('invalid opening date fails validation even when confirmation is supplied to the fake runner', async () => {
  const h = harness();
  const input = [...args, '--confirm-dev'];
  input[3] = '2020-01-01T00:00:00Z';
  assert.equal(await h.run(input), 1);
  assert.deepEqual(h.errors, [
    'Development seed preview/validation failed: Opening must be in the future. No AWS request was attempted.',
  ]);
  assert.deepEqual(h.counts(), { clients: 0, sends: 0, destroys: 0 });
});
test('valid preview never creates a client or sends a request', async () => {
  const h = harness();
  assert.equal(await h.run(args), 0);
  assert.equal(JSON.parse(h.logs[0]).items.length, 11);
  assert.match(h.logs[1], /Preview only; no AWS calls/);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.counts(), { clients: 0, sends: 0, destroys: 0 });
});
for (const name of ['CredentialsProviderError', 'TokenProviderError']) {
  for (const setupFailure of [false, true]) {
    test(`${name} during ${setupFailure ? 'setup' : 'send credential resolution'} reports no DynamoDB request`, async () => {
      const h = harness(
        Object.assign(new Error('profile or SSO resolution failed'), { name }),
        setupFailure,
      );
      assert.equal(await h.run([...args, '--confirm-dev']), 1);
      assert.equal(
        h.errors[0],
        `Development seed credential resolution failed (${name}). No DynamoDB request was attempted.`,
      );
      assert.doesNotMatch(
        h.errors[0],
        /confirmed transaction was attempted|An AWS request was attempted/,
      );
      assert.deepEqual(h.counts(), {
        clients: 1,
        sends: setupFailure ? 0 : 1,
        destroys: setupFailure ? 0 : 1,
      });
    });
  }
}
for (const name of [
  'UnrecognizedClientException',
  'ExpiredTokenException',
  'AccessDeniedException',
]) {
  test(`${name} is identified separately after a fake send`, async () => {
    const h = harness(
      Object.assign(new Error('do not print SDK internals'), { name }),
    );
    assert.equal(await h.run([...args, '--confirm-dev']), 1);
    assert.equal(
      h.errors[0],
      `Development seed AWS authentication/authorization failed (${name}). An AWS request was attempted; this error does not establish that any transaction writes occurred.`,
    );
    assert.deepEqual(h.counts(), { clients: 1, sends: 1, destroys: 1 });
  });
}
for (const failure of [
  { name: 'TimeoutError' },
  { name: 'Error', cause: { code: 'ENOTFOUND' } },
]) {
  test(`connectivity failure ${failure.name} is distinct and preserves outcome uncertainty`, async () => {
    const h = harness(failure);
    assert.equal(await h.run([...args, '--confirm-dev']), 1);
    assert.match(h.errors[0], /AWS connectivity\/timeout failed/);
    assert.match(h.errors[0], /if the outcome is uncertain, inspect the table/);
    assert.doesNotMatch(h.errors[0], /No items were written|existing-record/);
  });
}
test('conditional cancellation reports readiness, ownership or record conflict after a confirmed fake send', async () => {
  const h = harness({
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
  });
  assert.equal(await h.run([...args, '--confirm-dev']), 1);
  assert.equal(
    h.errors[0],
    'Development seed prerequisite conflict (TransactionCanceledException / ConditionalCheckFailed): catalog readiness, slug ownership, or an existing target record prevented the transaction. No items were written by this transaction.',
  );
  assert.deepEqual(h.counts(), { clients: 1, sends: 1, destroys: 1 });
});
for (const failure of [
  {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'TransactionConflict' }],
  },
  { name: 'TransactionCanceledException' },
  { name: 'ValidationException' },
  { name: 'ProvisionedThroughputExceededException' },
]) {
  test(`non-conditional failure retains ${JSON.stringify(failure)}`, async () => {
    const h = harness(failure);
    assert.equal(await h.run([...args, '--confirm-dev']), 1);
    assert.ok(h.errors[0].includes(`transaction failed (${failure.name}`));
    if ('CancellationReasons' in failure)
      assert.match(h.errors[0], /cancellation reasons: TransactionConflict/);
    assert.doesNotMatch(
      h.errors[0],
      /existing-record conflict|No items were written/,
    );
  });
}
test('setup errors cannot be labeled existing-record conflicts before send', async () => {
  const h = harness(
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    },
    true,
  );
  assert.equal(await h.run([...args, '--confirm-dev']), 1);
  assert.match(h.errors[0], /AWS setup failed/);
  assert.match(h.errors[0], /No DynamoDB transaction was attempted/);
  assert.doesNotMatch(h.errors[0], /existing-record conflict/);
  assert.equal(h.counts().sends, 0);
});
test('successful fake execution preserves the exact transaction and cleans up', async () => {
  const h = harness();
  assert.equal(await h.run([...args, '--confirm-dev']), 0);
  assert.equal(h.logs[1], `Created 11 items atomically in ${DEV_TABLE}.`);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.counts(), { clients: 1, sends: 1, destroys: 1 });
});
test('CLI missing dates exits nonzero with the actual cause, without confirmation or credentials', () => {
  const result = spawnSync(
    process.execPath,
    [
      'dist/tools/seed-dev.js',
      '--table',
      DEV_TABLE,
      '--region',
      'us-east-2',
      '--profile',
      'batch-and-batter-dev',
    ],
    {
      env: { PATH: process.env.PATH, AWS_EC2_METADATA_DISABLED: 'true' },
      timeout: 5000,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), missingMessage);
});
