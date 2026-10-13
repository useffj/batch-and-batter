import 'server-only';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { AdminConfig } from './server';

export const SESSION_PARAMETER = '/batch-and-batter/dev/admin/session-key';
export const SESSION_PARAMETER_ARN =
  'arn:aws:ssm:us-east-2:302154194958:parameter/batch-and-batter/dev/admin/session-key';
export const KEY_CACHE_MS = 60_000;
export interface RuntimeConfig extends AdminConfig {
  ADMIN_SESSION_KEY_PARAMETER?: string;
}
const validKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

// One entry per server process. No disk persistence, stale-on-error fallback,
// or failed-result caching. Concurrent callers share a single pending read.
export function createSessionKeyLoader(
  client: Pick<SSMClient, 'send'>,
  now: () => number = Date.now,
) {
  let cached: { key: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  return async (config: RuntimeConfig): Promise<string> => {
    try {
      if (
        !config.ADMIN_SESSION_KEY_PARAMETER &&
        ['development', 'test'].includes(config.NODE_ENV ?? '') &&
        validKey(config.ADMIN_SESSION_KEY)
      )
        return config.ADMIN_SESSION_KEY;
      if (config.ADMIN_SESSION_KEY_PARAMETER !== SESSION_PARAMETER)
        throw new Error();
      if (cached && now() < cached.until) return cached.key;
      cached = undefined;
      if (!pending) {
        pending = (async () => {
          const result = await client.send(
            new GetParameterCommand({
              Name: SESSION_PARAMETER,
              WithDecryption: true,
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
          const parameter = result.Parameter;
          if (
            parameter?.Name !== SESSION_PARAMETER ||
            parameter.ARN !== SESSION_PARAMETER_ARN ||
            parameter.Type !== 'SecureString' ||
            !validKey(parameter.Value)
          )
            throw new Error();
          cached = { key: parameter.Value, until: now() + KEY_CACHE_MS };
          return parameter.Value;
        })().finally(() => {
          pending = undefined;
        });
      }
      return await pending;
    } catch {
      // Discard SDK errors, parameter values and identities from error surfaces.
      throw new Error('Administrator session configuration is unavailable.');
    }
  };
}
// Default credential provider uses the Amplify compute role's temporary
// credentials. No network request occurs until a request needs a session key.
export const loadSessionKey = createSessionKeyLoader(
  new SSMClient({ region: 'us-east-2', maxAttempts: 2 }),
);
