import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { Notifications } from './notifications';
import { GuestOrders } from './guest-orders';
import { SesEmailProvider } from './notification-providers';

const configSchema = z.strictObject({
  mode: z.literal('confirmation-email'),
  commerce: z.string().trim().min(1),
  operations: z.string().trim().min(1),
  catalog: z.string().trim().min(1),
  sender: z.email(),
  origin: z.string().refine((s) => {
    try {
      return new URL(s).protocol === 'https:' && new URL(s).origin === s;
    } catch {
      return false;
    }
  }),
  pickupLocation: z.string().trim().min(1).max(2000),
  policies: z.string().trim().min(1).max(4000),
});
export type ConfirmationConfig = z.infer<typeof configSchema>;
/** Existing durable event/due records are polled directly; no new queue or scheduler.
 * This source-only entrypoint is deliberately absent from accepted artifact builds.
 */
export function createConfirmationRuntime(
  input: ConfirmationConfig,
  db: Pick<DynamoDBDocumentClient, 'send'>,
  ses: Pick<SESv2Client, 'send'>,
  now = Date.now,
) {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw Error('CONFIRMATION_CONFIGURATION_REQUIRED');
  const c = parsed.data;
  const guest = new GuestOrders(
    db,
    c.commerce,
    c.operations,
    c.catalog,
    c.origin,
    now,
  );
  const email = new SesEmailProvider(ses, c.sender);
  const disabled = async (): Promise<never> => {
    throw Error('NOTIFICATION_KIND_DISABLED');
  };
  const service: Notifications = new Notifications(
    db,
    c.commerce,
    c.operations,
    {
      enqueue: async (m) => {
        if (
          m.type !== 'DELIVERY' ||
          (m.key !== 'CONFIRMATION#email' &&
            !/^ACCESS#[a-f0-9-]{36}#email$/.test(m.key))
        )
          return disabled();
        await service.deliver(m.orderId, m.key);
      },
      schedule: disabled,
    },
    { email, sms: { send: disabled } },
    {
      policies: c.policies,
      approvedPickupLocation: c.pickupLocation,
      confirmationOnly: true,
      issueManagementLink: (o) => guest.issue(o),
      now,
    },
  );
  return async (event: unknown) => {
    if (!z.strictObject({ poll: z.literal(true) }).safeParse(event).success)
      throw Error('CONFIRMATION_EVENT_INVALID');
    try {
      await service.poll();
      return { polled: true };
    } catch {
      // Never emit addresses, message bodies, capabilities or raw SDK errors.
      throw Error('CONFIRMATION_POLL_FAILED');
    }
  };
}

// No SDK clients or credentials are loaded until a separately deployed invocation.
export async function handler(event: unknown) {
  const parsed = configSchema.safeParse({
    mode: process.env.CUSTOMER_CONFIRMATION_MODE,
    commerce: process.env.COMMERCE_TABLE_NAME,
    operations: process.env.OPERATIONS_TABLE_NAME,
    catalog: process.env.CATALOG_TABLE_NAME,
    sender: process.env.CONFIRMATION_FROM_EMAIL,
    origin: process.env.CUSTOMER_ORDER_ORIGIN,
    pickupLocation: process.env.CONFIRMATION_APPROVED_PICKUP_LOCATION,
    policies: process.env.CONFIRMATION_CUSTOMER_POLICY_TEXT,
  });
  if (!parsed.success) throw Error('CONFIRMATION_CONFIGURATION_REQUIRED');
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 1 }),
  );
  const ses = new SESv2Client({ maxAttempts: 1 });
  return createConfirmationRuntime(parsed.data, db, ses)(event);
}
