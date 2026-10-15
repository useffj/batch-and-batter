// DEV deployment entrypoint is blocked pending a separately authorized release contract.
// Retain the pure legacy argument helper for contract tests; it cannot execute.
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
function assertReleaseAuthorized() {
  const { deploymentBlockers } = require('./build-api-release.cjs');
  throw new Error('DEPLOYMENT_BLOCKED: ' + deploymentBlockers().join('; '));
}
module.exports.assertReleaseAuthorized = assertReleaseAuthorized;
if (require.main === module) {
  try {
    assertReleaseAuthorized();
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
