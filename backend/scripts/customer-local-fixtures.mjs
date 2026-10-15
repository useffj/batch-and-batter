import { fixtures } from './orders-local-fixtures.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { customerLookupRecords } = require('../dist/src/customer-lookup');
const { AdminCustomers } = require('../dist/src/admin-customers');
const { orderKey } = require('../dist/src/payment-domain');
export async function customerFixtures() {
  const f = await fixtures();
  for (let n = 0; n < f.orders.length; n++) {
    const o = f.orders[n];
    o.customer = {
      ...o.customer,
      name: n === 2 ? 'Élodie O’Neil-Smith' : 'Michael Johnson',
      email:
        n === 2
          ? 'elodie@example.test'
          : n === 3
            ? 'mjohnson@example.test'
            : 'michael@example.test',
    };
    await f.client.send(
      new PutCommand({
        TableName: f.table,
        Item: { ...o, ...orderKey(o.orderId) },
      }),
    );
    for (const row of customerLookupRecords(o))
      await f.client.send(new PutCommand({ TableName: f.table, Item: row }));
  }
  return {
    ...f,
    customers: new AdminCustomers(
      f.client,
      f.table,
      async (id) => f.drops.find((d) => d.dropId === id)?.name ?? null,
    ),
  };
}
