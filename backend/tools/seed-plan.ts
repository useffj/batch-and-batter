import { parseArgs } from 'node:util';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  dateSchema,
  productSchema,
  dropSchema,
  dropProductSchema,
  inventorySchema,
  pickupSchema,
  storefrontSchema,
} from '../src/domain';
import { catalogKeys } from '../src/keys';

export const DEV_TABLE = 'batch-and-batter-dev-catalog';
export const DEV_REGION = 'us-east-2';
export const DEV_PROFILE = 'batch-and-batter-dev';
// Stable internal ULIDs make reruns conflict, even when dates or names change.
export const SEED_DROP_ID = '01K5J100000000000000000001';
export const SEED_PRODUCT_IDS = [
  '01K5J100000000000000000002',
  '01K5J100000000000000000003',
] as const;
export interface SeedOptions {
  table: string;
  region: string;
  profile: string;
  opensAt: string;
  pickupDates: string[];
  confirmDev: boolean;
}
export function parseSeedOptions(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): SeedOptions {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      table: { type: 'string' },
      region: { type: 'string', default: DEV_REGION },
      profile: { type: 'string', default: DEV_PROFILE },
      'opens-at': { type: 'string' },
      'pickup-dates': { type: 'string' },
      'confirm-dev': { type: 'boolean', default: false },
    },
  });
  if (
    values.table !== DEV_TABLE ||
    values.region !== DEV_REGION ||
    values.profile !== DEV_PROFILE
  ) {
    throw new Error(
      `Seed requires --table ${DEV_TABLE}, region ${DEV_REGION}, and profile ${DEV_PROFILE}; overrides are not supported.`,
    );
  }
  // Block inherited custom endpoints: no redirect to another account/service.
  if (
    Object.keys(environment).some(
      (key) => key.startsWith('AWS_ENDPOINT_URL') && environment[key],
    )
  )
    throw new Error('Custom AWS endpoints are not allowed.');
  if (environment.AWS_PROFILE && environment.AWS_PROFILE !== DEV_PROFILE)
    throw new Error('Conflicting AWS_PROFILE.');
  if (environment.AWS_REGION && environment.AWS_REGION !== DEV_REGION)
    throw new Error('Conflicting AWS_REGION.');
  if (
    environment.AWS_DEFAULT_REGION &&
    environment.AWS_DEFAULT_REGION !== DEV_REGION
  )
    throw new Error('Conflicting AWS_DEFAULT_REGION.');
  if (!values['opens-at'] || !values['pickup-dates'])
    throw new Error(
      'Provide --opens-at (UTC ISO timestamp) and --pickup-dates (three comma-separated YYYY-MM-DD dates).',
    );
  return {
    table: values.table,
    region: values.region,
    profile: values.profile,
    opensAt: values['opens-at'],
    pickupDates: values['pickup-dates'].split(','),
    confirmDev: values['confirm-dev'],
  };
}
export function buildSeedPlan(options: SeedOptions, now = new Date()) {
  // Revalidate even when invoked without the CLI parser.
  if (
    options.table !== DEV_TABLE ||
    options.region !== DEV_REGION ||
    options.profile !== DEV_PROFILE
  )
    throw new Error('Invalid development seed target.');
  const dates = options.pickupDates.map((date) => dateSchema.parse(date));
  if (dates.length !== 3 || new Set(dates).size !== 3)
    throw new Error('Exactly three distinct pickup dates are required.');
  if (!(Date.parse(options.opensAt) > now.getTime()))
    throw new Error('Opening must be in the future.');
  const openingDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(options.opensAt));
  if (dates.some((date) => date <= openingDate))
    throw new Error(
      'Pickup dates must follow the opening date in America/Denver.',
    );
  const timestamp = now.toISOString();
  const products = [
    {
      productId: SEED_PRODUCT_IDS[0],
      name: 'Brown Butter Chocolate Chip',
      slug: 'brown-butter-chocolate-chip',
      description: 'Fake development cookie: brown butter and chocolate chips.',
      ingredients: ['Flour', 'Butter', 'Sugar', 'Eggs', 'Chocolate'],
      allergens: ['Wheat', 'Milk', 'Eggs', 'Soy'],
    },
    {
      productId: SEED_PRODUCT_IDS[1],
      name: 'Snickerdoodle',
      slug: 'snickerdoodle',
      description: 'Fake development cookie: cinnamon and sugar.',
      ingredients: ['Flour', 'Butter', 'Sugar', 'Eggs', 'Cinnamon'],
      allergens: ['Wheat', 'Milk', 'Eggs'],
    },
  ].map((product) =>
    productSchema.parse({
      ...product,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  const drop = dropSchema.parse({
    dropId: SEED_DROP_ID,
    name: 'Development Cookie Drop',
    description: 'Fake data for local development review. Not a real sale.',
    status: 'SCHEDULED',
    opensAt: options.opensAt,
    pickupLocation: 'Development pickup location — not a real address',
    pickupInstructions: 'Development example only.',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const items: Record<string, unknown>[] = products.map((product) => ({
    ...catalogKeys.product(product.productId),
    ...product,
  }));
  items.push({ ...catalogKeys.drop(drop.dropId), ...drop });
  products.forEach((product, index) => {
    items.push({
      ...catalogKeys.dropProduct(drop.dropId, product.productId),
      ...dropProductSchema.parse({
        dropId: drop.dropId,
        productId: product.productId,
        priceCents: index === 0 ? 450 : 400,
        cookieUnits: 1,
        displayOrder: index,
        active: true,
      }),
    });
    items.push({
      ...catalogKeys.inventory(drop.dropId, product.productId),
      ...inventorySchema.parse({
        dropId: drop.dropId,
        productId: product.productId,
        total: 100,
        updatedAt: timestamp,
      }),
    });
  });
  for (const [index, date] of dates.sort().entries())
    items.push({
      ...catalogKeys.pickup(drop.dropId, date),
      ...pickupSchema.parse({
        dropId: drop.dropId,
        date,
        startTime: index === 2 ? '12:00' : '16:00',
        endTime: index === 2 ? '15:00' : '19:00',
        active: true,
      }),
    });
  items.push({
    ...catalogKeys.storefront,
    ...storefrontSchema.parse({
      storefrontDropId: drop.dropId,
      updatedAt: timestamp,
    }),
  });
  return {
    table: options.table,
    region: options.region,
    profile: options.profile,
    items,
  };
}
export type SeedPlan = ReturnType<typeof buildSeedPlan>;
export function seedTransaction(plan: SeedPlan) {
  if (
    plan.table !== DEV_TABLE ||
    plan.region !== DEV_REGION ||
    plan.profile !== DEV_PROFILE
  )
    throw new Error('Invalid development seed target.');
  return new TransactWriteCommand({
    TransactItems: plan.items.map((Item) => ({
      Put: {
        TableName: plan.table,
        Item,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    })),
  });
}
