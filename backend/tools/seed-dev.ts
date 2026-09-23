import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  type TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';
import { ZodError } from 'zod';
import {
  buildSeedPlan,
  parseSeedOptions,
  seedTransaction,
  DEV_REGION,
  type SeedOptions,
} from './seed-plan';

interface SeedClient {
  send(command: TransactWriteCommand): Promise<unknown>;
  destroy(): void;
}
interface SeedDependencies {
  createClient(options: SeedOptions): SeedClient;
  log(message: string): void;
  error(message: string): void;
  environment: NodeJS.ProcessEnv;
  now(): Date;
}
function createClient(options: SeedOptions): SeedClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: DEV_REGION,
      // Explicit named-profile provider does not use ambient access-key credentials.
      credentials: fromIni({ profile: options.profile, ignoreCache: true }),
      endpoint: `https://dynamodb.${DEV_REGION}.amazonaws.com`,
      maxAttempts: 1,
    }),
  );
}
function validationMessage(error: unknown): string {
  const message =
    error instanceof ZodError
      ? error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`,
          )
          .join('; ')
      : error instanceof Error
        ? error.message
        : 'Unknown validation error';
  return message.endsWith('.') ? message : `${message}.`;
}
function awsErrorMessage(
  error: unknown,
  transactionAttempted: boolean,
): string {
  const detail = error as {
    name?: string;
    code?: string;
    cause?: { name?: string; code?: string };
    CancellationReasons?: { Code?: string }[];
  } | null;
  const name = detail?.name ?? 'UnknownError';
  const codes = [name, detail?.code, detail?.cause?.name, detail?.cause?.code];
  const providerCode = codes.find(
    (code) =>
      code === 'CredentialsProviderError' || code === 'TokenProviderError',
  );
  if (providerCode) {
    // SDK send() can fail resolving a profile/SSO token before sending to DynamoDB.
    return `Development seed credential resolution failed (${providerCode}). No DynamoDB request was attempted.`;
  }
  const authentication = [
    'UnrecognizedClientException',
    'InvalidClientTokenId',
    'ExpiredToken',
    'ExpiredTokenException',
    'AccessDenied',
    'AccessDeniedException',
    'UnauthorizedException',
    'InvalidSignatureException',
    'SignatureDoesNotMatch',
  ];
  const connectivity = [
    'TimeoutError',
    'NetworkingError',
    'RequestTimeout',
    'RequestTimeoutException',
    'AbortError',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
  ];
  const reasons =
    detail?.CancellationReasons?.map((reason) => reason.Code).filter(
      (code): code is string => !!code && code !== 'None',
    ) ?? [];
  if (
    transactionAttempted &&
    name === 'TransactionCanceledException' &&
    reasons.includes('ConditionalCheckFailed')
  ) {
    return 'Development seed existing-record conflict (TransactionCanceledException / ConditionalCheckFailed): the confirmed transaction was canceled because at least one target record already exists. No items were written by this transaction.';
  }
  const authCode = codes.find((code) => code && authentication.includes(code));
  const networkCode = codes.find((code) => code && connectivity.includes(code));
  if (authCode) {
    return `Development seed AWS authentication/authorization failed (${authCode}). ${transactionAttempted ? 'An AWS request was attempted; this error does not establish that any transaction writes occurred.' : 'No DynamoDB request was attempted.'}`;
  }
  const category = networkCode
    ? `Development seed AWS connectivity/timeout failed (${networkCode}).`
    : `Development seed ${transactionAttempted ? 'transaction' : 'AWS setup'} failed (${name}${reasons.length ? `; cancellation reasons: ${reasons.join(', ')}` : ''}).`;
  // Report categories, not raw SDK objects that may contain request/record data.
  return `${category} ${transactionAttempted ? 'A confirmed transaction was attempted; if the outcome is uncertain, inspect the table before retrying.' : 'No DynamoDB transaction was attempted.'}`;
}

export async function runSeed(
  args: string[],
  overrides: Partial<SeedDependencies> = {},
): Promise<number> {
  const dependencies: SeedDependencies = {
    createClient,
    log: console.log,
    error: console.error,
    environment: process.env,
    now: () => new Date(),
    ...overrides,
  };
  let options: SeedOptions;
  let plan: ReturnType<typeof buildSeedPlan>;
  try {
    options = parseSeedOptions(args, dependencies.environment);
    plan = buildSeedPlan(options, dependencies.now());
    dependencies.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    dependencies.error(
      `Development seed preview/validation failed: ${validationMessage(error)} No AWS request was attempted.`,
    );
    return 1;
  }
  if (!options.confirmDev) {
    dependencies.log(
      'Preview only; no AWS calls. Review the plan and add --confirm-dev only after approval.',
    );
    return 0;
  }
  // Construct/validate the unchanged transaction before creating any AWS client.
  let command: TransactWriteCommand;
  try {
    command = seedTransaction(plan);
  } catch (error) {
    dependencies.error(
      `Development seed validation failed: ${validationMessage(error)} No AWS request was attempted.`,
    );
    return 1;
  }
  let client: SeedClient | undefined;
  let transactionAttempted = false;
  try {
    client = dependencies.createClient(options);
    transactionAttempted = true;
    await client.send(command);
    dependencies.log(
      `Created ${plan.items.length} items atomically in ${plan.table}.`,
    );
    return 0;
  } catch (error) {
    dependencies.error(awsErrorMessage(error, transactionAttempted));
    return 1;
  } finally {
    client?.destroy();
  }
}

// Importing the runner for offline tests must never execute the CLI.
if (require.main === module) {
  runSeed(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(
        `Development seed failed unexpectedly (${error instanceof Error ? error.name : 'UnknownError'}); the outcome is unknown. Inspect the failure before retrying.`,
      );
      process.exitCode = 1;
    });
}
