type NodeEnvironment = 'development' | 'test' | 'production';

/** Validate only explicitly supported settings; never copy secrets into client config. */
export function validateEnvironment(source: {
  NODE_ENV?: string;
}): Readonly<{ NODE_ENV: NodeEnvironment }> {
  const nodeEnv = source.NODE_ENV;

  if (
    nodeEnv !== 'development' &&
    nodeEnv !== 'test' &&
    nodeEnv !== 'production'
  ) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }

  return { NODE_ENV: nodeEnv };
}
