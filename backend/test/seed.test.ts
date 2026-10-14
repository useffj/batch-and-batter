import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  buildSeedPlan,
  parseSeedOptions,
  seedTransaction,
  DEV_PROFILE,
  DEV_REGION,
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
const options = parseSeedOptions(args, {});
const now = new Date('2099-10-01T00:00:00.000Z');

test('seed is explicit dev-only and defaults to preview', () => {
  assert.deepEqual(options, {
    table: DEV_TABLE,
    profile: DEV_PROFILE,
    region: DEV_REGION,
    opensAt: args[3],
    pickupDates: args[5].split(','),
    confirmDev: false,
  });
  assert.equal(
    parseSeedOptions([...args, '--confirm-dev'], {}).confirmDev,
    true,
  );
  for (const invalid of [
    [],
    ['--table', 'batch-and-batter-prod-catalog'],
    [...args, '--region', 'us-west-2'],
    [...args, '--profile', 'default'],
    [...args, '--typo'],
    ['--table', `${DEV_TABLE}-copy`, ...args.slice(2)],
  ])
    assert.throws(() => parseSeedOptions(invalid, {}));
  for (const environment of [
    { AWS_ENDPOINT_URL: 'https://example.com' },
    { AWS_ENDPOINT_URL_DYNAMODB: 'https://example.com' },
    { AWS_PROFILE: 'prod' },
    { AWS_REGION: 'us-west-2' },
    { AWS_DEFAULT_REGION: 'us-west-2' },
  ])
    assert.throws(() => parseSeedOptions(args, environment));
});
test('seed validates future opening and three distinct future pickup dates', () => {
  for (const patch of [
    { opensAt: now.toISOString() },
    { opensAt: 'bad' },
    { pickupDates: ['2099-10-08'] },
    { pickupDates: ['2099-10-08', '2099-10-08', '2099-10-09'] },
    { pickupDates: ['2099-10-05', '2099-10-09', '2099-10-10'] },
    { pickupDates: ['2099-02-30', '2099-10-09', '2099-10-10'] },
    { table: 'prod' },
  ])
    assert.throws(() => buildSeedPlan({ ...options, ...patch }, now));
});
test('11 items form one conditional transaction, including storefront pointer and initial inventory', () => {
  const plan = buildSeedPlan(options, now);
  assert.equal(plan.items.length, 11);
  const transaction = seedTransaction(plan);
  assert.equal(transaction.input.TransactItems?.length, 14);
  assert.deepEqual(transaction.input.TransactItems?.[0].ConditionCheck?.Key, {
    PK: 'PRODUCT_INTEGRITY#V1',
    SK: 'STATE',
  });
  const keys = new Set();
  for (const operation of transaction.input.TransactItems?.slice(1) ?? []) {
    assert.deepEqual(Object.keys(operation), ['Put']);
    assert.equal(operation.Put?.TableName, DEV_TABLE);
    assert.equal(
      operation.Put?.ConditionExpression,
      'attribute_not_exists(PK)',
    );
    keys.add(`${operation.Put?.Item?.PK}/${operation.Put?.Item?.SK}`);
  }
  assert.equal(keys.size, 13);
  const stocks = plan.items.filter((item) =>
    String(item.SK).startsWith('INVENTORY#'),
  );
  assert.equal(stocks.length, 2);
  for (const stock of stocks) {
    assert.equal(stock.reserved, 0);
    assert.equal(stock.sold, 0);
  }
  assert.equal(
    plan.items.filter((item) => String(item.SK).startsWith('PICKUP#')).length,
    3,
  );
  assert.ok(keys.has('STORE#CONFIG/STOREFRONT'));
  assert.deepEqual(buildSeedPlan(options, now), plan);
  const rerun = buildSeedPlan(
    { ...options, opensAt: '2099-10-06T18:00:00Z' },
    new Date('2099-10-02T00:00:00Z'),
  );
  assert.deepEqual(
    rerun.items.map((item) => [item.PK, item.SK]),
    plan.items.map((item) => [item.PK, item.SK]),
  );
});
test('CLI preview works with no AWS credentials or network and does not confirm execution', () => {
  const output = execFileSync(
    process.execPath,
    ['dist/tools/seed-dev.js', ...args],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, AWS_EC2_METADATA_DISABLED: 'true' },
      timeout: 5000,
      encoding: 'utf8',
    },
  );
  assert.match(output, /Preview only; no AWS calls/);
  assert.match(output, /Brown Butter Chocolate Chip/);
  assert.match(output, /Snickerdoodle/);
  assert.doesNotMatch(output, /Created 11 items/);
});

test('development pickup dates retain Thursday/Friday evenings and Saturday afternoon', () => {
  const plan = buildSeedPlan(
    {
      ...options,
      opensAt: '2026-09-27T18:00:00.000Z',
      pickupDates: ['2026-10-01', '2026-10-02', '2026-10-03'],
    },
    new Date('2026-09-22T12:00:00.000Z'),
  );
  const pickups = plan.items.filter((item) =>
    String(item.SK).startsWith('PICKUP#'),
  );
  assert.deepEqual(
    pickups.map(({ date, startTime, endTime }) => ({
      date,
      startTime,
      endTime,
    })),
    [
      { date: '2026-10-01', startTime: '16:00', endTime: '19:00' },
      { date: '2026-10-02', startTime: '16:00', endTime: '19:00' },
      { date: '2026-10-03', startTime: '12:00', endTime: '15:00' },
    ],
  );
});
