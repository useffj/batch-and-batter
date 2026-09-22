import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';
import {
  buildSeedPlan,
  parseSeedOptions,
  seedTransaction,
  DEV_REGION,
} from './seed-plan';

async function main() {
  const options = parseSeedOptions(process.argv.slice(2));
  const plan = buildSeedPlan(options);
  console.log(JSON.stringify(plan, null, 2));
  if (!options.confirmDev) {
    console.log(
      'Preview only; no AWS calls. Review the plan and add --confirm-dev only after approval.',
    );
    return;
  }
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: DEV_REGION,
      // Explicit named-profile provider does not use ambient access-key credentials.
      credentials: fromIni({ profile: options.profile, ignoreCache: true }),
      endpoint: `https://dynamodb.${DEV_REGION}.amazonaws.com`,
      maxAttempts: 1,
    }),
  );
  try {
    await client.send(seedTransaction(plan));
    console.log(
      `Created ${plan.items.length} items atomically in ${plan.table}.`,
    );
  } finally {
    client.destroy();
  }
}
main().catch(() => {
  console.error(
    'Development seed failed. No existing items are overwritten; a transaction conflict requires human inspection.',
  );
  process.exitCode = 1;
});
