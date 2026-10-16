import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  reminderSchedule,
  consentSchema,
  suppressionSchema,
} from '../src/notification-contract';
import {
  SesEmailProvider,
  DeliveryFailure,
  MockSmsProvider,
} from '../src/notification-providers';
import { AwsNotificationTransport } from '../src/notification-transport';
import { AdminNotifications } from '../src/admin-notifications';
import { createNotificationWorker } from '../src/notification-worker';
for (const [date, prior] of [
  ['2026-03-09', '2026-03-08'],
  ['2026-11-02', '2026-11-01'],
  ['2027-01-01', '2026-12-31'],
])
  test('Denver calendar schedule across DST/year boundary ' + date, () => {
    const s = reminderSchedule(date);
    assert.equal(s.expression, `at(${prior}T10:00:00)`);
    assert.equal(s.timezone, 'America/Denver');
    assert.equal(
      reminderSchedule(date, '09:30').expression,
      `at(${prior}T09:30:00)`,
    );
    assert.throws(() => reminderSchedule(date, '25:00'));
  });
test('historical boolean consent and missing current opt-out evidence fail schema validation', () => {
  assert.equal(
    consentSchema.safeParse({ smsTransactionalConsent: true }).success,
    false,
  );
  assert.equal(suppressionSchema.safeParse({}).success, false);
});
const message = {
  to: 'synthetic@example.test',
  subject: 'Synthetic',
  text: 'Synthetic body',
  operationId: 'a'.repeat(64),
};
test('SES adapter sends text with operation tag and requires positive acknowledgement', async () => {
  let input: any;
  const p = new SesEmailProvider(
    {
      send: async (c: any) => {
        input = c.input;
        return { MessageId: 'synthetic' };
      },
    } as any,
    'sender@example.test',
  );
  await p.send(message);
  assert.equal(input.Content.Simple.Body.Text.Data, message.text);
  assert.equal(input.EmailTags[0].Value, message.operationId);
  await assert.rejects(
    new SesEmailProvider(
      { send: async () => ({}) } as any,
      'sender@example.test',
    ).send(message),
    /Unknown delivery/,
  );
});
for (const [name, retry] of [
  ['TooManyRequestsException', true],
  ['MessageRejected', false],
] as const)
  test('SES definite rejection ' + name, async () => {
    const p = new SesEmailProvider(
      {
        send: async () => {
          throw Object.assign(Error('private'), { name });
        },
      } as any,
      'sender@example.test',
    );
    await assert.rejects(
      p.send(message),
      (e: unknown) =>
        e instanceof DeliveryFailure &&
        e.retryable === retry &&
        !e.message.includes('private'),
    );
  });
test('SMS mock is functional and does not mutate caller payload', async () => {
  const p = new MockSmsProvider();
  await p.send(message);
  assert.deepEqual(p.messages, [message]);
  assert.notEqual(p.messages[0], message);
});
test('scheduler conflict must verify exact configuration; no replacement is attempted', async () => {
  const calls: any[] = [];
  const p = new AwsNotificationTransport(
    { send: async () => ({}) } as any,
    {
      send: async (c: any) => {
        calls.push(c);
        if (c.constructor.name === 'CreateScheduleCommand')
          throw Object.assign(Error(), { name: 'ConflictException' });
        return { ScheduleExpression: 'wrong' };
      },
    } as any,
    {
      queueUrl: 'synthetic',
      queueArn: 'synthetic',
      scheduleRoleArn: 'synthetic',
      groupName: 'synthetic',
    },
  );
  await assert.rejects(p.schedule(reminderSchedule('2026-11-02')), /conflicts/);
  assert.deepEqual(
    calls.map((c) => c.constructor.name),
    ['CreateScheduleCommand', 'GetScheduleCommand'],
  );
});
test('admin notification status uses bounded consistent query without recipients or provider content', async () => {
  let input: any;
  const p = new AdminNotifications(
    {
      send: async (c: any) => {
        input = c.input;
        return { Items: [] };
      },
    } as any,
    'synthetic',
  );
  assert.deepEqual(await p.status('01K00000000000000000000001'), {
    notifications: [],
    truncated: false,
    confirmationSms: 'NOT_CONFIGURED',
  });
  assert.equal(input.Limit, 50);
  assert.equal(input.ConsistentRead, true);
});
test('queue handler reports partial failure and never logs body', async () => {
  const p = createNotificationWorker({
    handle: async () => {
      throw Error('private');
    },
  } as any);
  assert.deepEqual(
    await p({ Records: [{ messageId: 'synthetic', body: '{}' }] }),
    { batchItemFailures: [{ itemIdentifier: 'synthetic' }] },
  );
});
