// Normal dev deployment entrypoint. Never inherit prior payment admission.
const { spawnSync } = require('node:child_process');
const paymentConfig = require('../config/dev-payment.json');
const parameterKeys = [
  'StripeSandboxAccountId',
  'DevPaymentLedgerNamespace',
  'DevPaymentLedgerAccountId',
];
function validatePaymentConfig(config) {
  const allowed = ['Environment', ...parameterKeys];
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).length !== allowed.length ||
    Object.keys(config).some((key) => !allowed.includes(key)) ||
    allowed.some(
      (key) => !Object.hasOwn(config, key) || typeof config[key] !== 'string',
    ) ||
    config.Environment !== 'dev' ||
    !/^acct_[A-Za-z0-9]+$/.test(config.StripeSandboxAccountId) ||
    !/^dev:acct_[A-Za-z0-9]+$/.test(config.DevPaymentLedgerNamespace) ||
    config.DevPaymentLedgerNamespace.length > 100 ||
    config.DevPaymentLedgerAccountId !== config.StripeSandboxAccountId
  ) {
    throw new Error('INVALID_DEV_PAYMENT_CONFIG');
  }
}
function deployArgs(args, config = paymentConfig) {
  validatePaymentConfig(config);
  if (
    !Array.isArray(args) ||
    args.length > 1 ||
    (args.length === 1 &&
      ![
        '--payment-start-enabled=false',
        '--payment-start-enabled=true',
      ].includes(args[0]))
  ) {
    throw new Error(
      'Usage: npm run deploy:dev -- [--payment-start-enabled=false|true]',
    );
  }
  const value = args.length ? args[0].split('=')[1] : 'false';
  return [
    'cdk',
    'deploy',
    'batch-and-batter-dev',
    '--profile',
    'batch-and-batter-dev',
    '--previous-parameters',
    'true',
    '--context',
    'environment=dev',
    ...parameterKeys.flatMap((key) => [
      '--parameters',
      `batch-and-batter-dev:${key}=${config[key]}`,
    ]),
    '--parameters',
    `batch-and-batter-dev:PaymentStartEnabled=${value}`,
  ];
}
module.exports = { deployArgs };
if (require.main === module) {
  try {
    const args = deployArgs(process.argv.slice(2));
    const env = {
      ...process.env,
      AWS_REGION: 'us-east-2',
      AWS_DEFAULT_REGION: 'us-east-2',
      CDK_DEFAULT_REGION: 'us-east-2',
    };
    // Resolve the account from the selected profile, not inherited synthesis state.
    delete env.CDK_DEFAULT_ACCOUNT;
    const result = spawnSync('npx', args, {
      cwd: require('node:path').resolve(__dirname, '..'),
      env,
      stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
