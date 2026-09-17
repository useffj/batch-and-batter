import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './env';

describe('validateEnvironment', () => {
  it.each(['development', 'test', 'production'])(
    'accepts the supported %s environment',
    (NODE_ENV) => {
      expect(validateEnvironment({ NODE_ENV })).toEqual({ NODE_ENV });
    },
  );

  it.each([undefined, '', 'staging'])(
    'rejects a missing or unsupported environment (%s)',
    (NODE_ENV) => {
      expect(() => validateEnvironment({ NODE_ENV })).toThrow(
        'NODE_ENV must be development, test, or production.',
      );
    },
  );

  it('returns only allowlisted configuration without exposing unrelated values', () => {
    const source = {
      NODE_ENV: 'production',
      PRIVATE_SETTING: 'test-placeholder',
    };
    expect(validateEnvironment(source)).toEqual({ NODE_ENV: 'production' });
  });
});
