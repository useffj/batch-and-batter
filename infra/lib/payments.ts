import { artifactCode } from './artifacts';
import {
  ArnFormat,
  Duration,
  RemovalPolicy,
  Stack,
  CfnParameter,
  aws_iam as iam,
  aws_kms as kms,
  aws_sqs as sqs,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_dynamodb as dynamodb,
  aws_apigatewayv2 as api,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as actions,
  aws_sns as sns,
} from 'aws-cdk-lib';

export function addPayments(
  stack: Stack,
  prefix: string,
  application: lambda.Function,
  appRole: iam.Role,
  http: api.HttpApi,
  catalog: dynamodb.Table,
  commerce: dynamodb.Table,
  operations: dynamodb.Table,
  reconciler: {
    fn: lambda.Function;
    role: iam.Role;
    infrastructureDlq: sqs.Queue;
  },
) {
  const policy = (
    role: iam.Role,
    actions: string[],
    resource: string,
    conditions?: Record<string, unknown>,
  ) =>
    role.addToPolicy(
      new iam.PolicyStatement({ actions, resources: [resource], conditions }),
    );
  // No account is invented. Empty account is a fail-closed bootstrap configuration.
  const account = new CfnParameter(stack, 'StripeSandboxAccountId', {
    type: 'String',
    default: '',
    allowedPattern: '^$|^acct_[A-Za-z0-9]+$',
    description:
      'Nonsecret sandbox account ID; required before payment enablement.',
  });
  const ledgerNamespace = new CfnParameter(stack, 'DevPaymentLedgerNamespace', {
    type: 'String',
    default: '',
    allowedPattern: '^$|^dev:acct_[A-Za-z0-9]+$',
    description:
      'Immutable DEV payment ledger namespace; not a Stripe account identity.',
  });
  const ledgerAccount = new CfnParameter(stack, 'DevPaymentLedgerAccountId', {
    type: 'String',
    default: '',
    allowedPattern: '^$|^acct_[A-Za-z0-9]+$',
    description:
      'Actual Stripe account bound to the DEV ledger namespace; must equal StripeSandboxAccountId.',
  });
  const key = new kms.Key(stack, 'StripeParameterKey', {
    enableKeyRotation: true,
    removalPolicy: RemovalPolicy.RETAIN,
    description:
      'Dev Stripe SecureString encryption; runtime grants are parameter-specific.',
  });
  key.addAlias(`alias/${prefix}-stripe`);
  const parameter = (suffix: string) =>
    `/batch-and-batter/dev/stripe/${suffix}`;
  const secret = (role: iam.Role, suffix: string) => {
    const name = parameter(suffix);
    const arn = stack.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: name.slice(1),
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    policy(role, ['ssm:GetParameter'], arn);
    policy(role, ['kms:Decrypt'], key.keyArn, {
      StringEquals: {
        'kms:ViaService': `ssm.${stack.region}.amazonaws.com`,
        'kms:EncryptionContext:PARAMETER_ARN': arn,
      },
    });
    return name;
  };
  const dlq = new sqs.Queue(stack, 'PaymentDeadLetterQueue', {
    queueName: `${prefix}-payment-dlq`,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    retentionPeriod: Duration.days(14),
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const queue = new sqs.Queue(stack, 'PaymentQueue', {
    queueName: `${prefix}-payment`,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    retentionPeriod: Duration.days(4),
    visibilityTimeout: Duration.seconds(180),
    deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const create = (id: string, suffix: string, timeout: number) => {
    const logGroup = new logs.LogGroup(stack, `${id}LogGroup`, {
      logGroupName: `/aws/lambda/${prefix}-${suffix}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(stack, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    policy(
      role,
      ['logs:CreateLogStream', 'logs:PutLogEvents'],
      logGroup.logGroupArn,
    );
    const fn = new lambda.Function(stack, id, {
      functionName: `${prefix}-${suffix}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: `${suffix}-handler.handler`,
      code: artifactCode(
        stack,
        id === 'PaymentWorker'
          ? 'PaymentWorkerA754B793'
          : 'StripeWebhook04C354F4',
        `${suffix}-handler.handler`,
      ),
      memorySize: 256,
      timeout: Duration.seconds(timeout),
      reservedConcurrentExecutions: 2,
      role,
      logGroup,
      environment: {
        OPERATIONS_TABLE_NAME: operations.tableName,
        PAYMENT_QUEUE_URL: queue.queueUrl,
        PAYMENT_QUEUE_ARN: queue.queueArn,
        STRIPE_ENVIRONMENT: 'dev',
        STRIPE_ACCOUNT_ID: account.valueAsString,
        STRIPE_LEDGER_NAMESPACE: ledgerNamespace.valueAsString,
        STRIPE_LEDGER_ACCOUNT_ID: ledgerAccount.valueAsString,
      },
    });
    return { fn, role };
  };
  const worker = create('PaymentWorker', 'payment-worker', 30);
  worker.fn.addEnvironment('CATALOG_TABLE_NAME', catalog.tableName);
  worker.fn.addEnvironment('COMMERCE_TABLE_NAME', commerce.tableName);
  worker.fn.addEnvironment(
    'STRIPE_WORKER_KEY_PARAMETER',
    secret(worker.role, 'payment-worker-key'),
  );
  policy(
    worker.role,
    ['dynamodb:GetItem', 'dynamodb:PutItem'],
    catalog.tableArn,
  );
  policy(
    worker.role,
    ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:ConditionCheckItem'],
    commerce.tableArn,
  );
  policy(
    worker.role,
    [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:DeleteItem',
      'dynamodb:ConditionCheckItem',
    ],
    operations.tableArn,
  );
  policy(
    worker.role,
    [
      'sqs:ReceiveMessage',
      'sqs:DeleteMessage',
      'sqs:GetQueueAttributes',
      'sqs:SendMessage',
    ],
    queue.queueArn,
  );
  const mapping = new lambda.CfnEventSourceMapping(
    stack,
    'PaymentQueueMapping',
    {
      functionName: worker.fn.functionName,
      eventSourceArn: queue.queueArn,
      enabled: true,
      batchSize: 1,
      maximumBatchingWindowInSeconds: 0,
      scalingConfig: { maximumConcurrency: 2 },
      functionResponseTypes: ['ReportBatchItemFailures'],
    },
  );
  mapping.node.addDependency(worker.role.node.findChild('DefaultPolicy'));
  const webhook = create('StripeWebhook', 'stripe-webhook', 10);
  webhook.fn.addEnvironment(
    'STRIPE_WEBHOOK_SECRET_PARAMETER',
    secret(webhook.role, 'webhook-signing-secret'),
  );
  policy(
    webhook.role,
    ['dynamodb:GetItem', 'dynamodb:PutItem'],
    operations.tableArn,
  );
  policy(webhook.role, ['sqs:SendMessage'], queue.queueArn);
  http.addRoutes({
    path: '/webhooks/stripe',
    methods: [api.HttpMethod.POST],
    integration: new integrations.HttpLambdaIntegration(
      'StripeWebhookIntegration',
      webhook.fn,
    ),
  });
  for (const [route, method, id] of [
    [
      '/carts/{cartId}/payment/start',
      api.HttpMethod.POST,
      'StartPaymentIntegration',
    ],
    [
      '/carts/{cartId}/payment/confirm',
      api.HttpMethod.POST,
      'ConfirmPaymentIntegration',
    ],
    ['/carts/{cartId}/payment', api.HttpMethod.GET, 'GetPaymentIntegration'],
  ] as const)
    http.addRoutes({
      path: route,
      methods: [method],
      integration: new integrations.HttpLambdaIntegration(id, application),
    });
  const admission = new CfnParameter(stack, 'PaymentStartEnabled', {
    type: 'String',
    default: 'false',
    allowedValues: ['false', 'true'],
    description:
      'Nonsecret NEW payment admission only; true requires a reviewed acceptance window. Existing payment recovery remains enabled.',
  });
  application.addEnvironment('PAYMENT_START_ENABLED', admission.valueAsString);
  application.addEnvironment('STRIPE_ENVIRONMENT', 'dev');
  application.addEnvironment('STRIPE_ACCOUNT_ID', account.valueAsString);
  application.addEnvironment(
    'STRIPE_LEDGER_NAMESPACE',
    ledgerNamespace.valueAsString,
  );
  application.addEnvironment(
    'STRIPE_LEDGER_ACCOUNT_ID',
    ledgerAccount.valueAsString,
  );
  application.addEnvironment(
    'STRIPE_READ_KEY_PARAMETER',
    secret(appRole, 'payment-read-key'),
  );
  application.addEnvironment('PAYMENT_QUEUE_URL', queue.queueUrl);
  policy(appRole, ['sqs:SendMessage'], queue.queueArn);
  policy(appRole, ['dynamodb:ConditionCheckItem'], commerce.tableArn);
  reconciler.fn.addEnvironment('PAYMENT_QUEUE_URL', queue.queueUrl);
  policy(reconciler.role, ['sqs:SendMessage'], queue.queueArn);
  const topic = new sns.Topic(stack, 'PaymentAlerts', {
    topicName: `${prefix}-payment-alerts`,
  });
  topic.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [topic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': stack.account },
        ArnLike: {
          'aws:SourceArn': stack.formatArn({
            service: 'cloudwatch',
            resource: 'alarm',
            resourceName: `${prefix}-payment-*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        },
      },
    }),
  );
  const infrastructureAlarm = new cw.Alarm(
    stack,
    'RecoveryInfrastructureDlqNonEmpty',
    {
      // Reuse the existing topic's account-scoped payment alarm ARN restriction.
      alarmName: `${prefix}-payment-RecoveryInfrastructureDlqNonEmpty`,
      metric:
        reconciler.infrastructureDlq.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator:
        cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Recovery infrastructure failure envelope; see PAYMENT_RECOVERY_RUNBOOK. Do not purge.',
    },
  );
  infrastructureAlarm.addAlarmAction(new actions.SnsAction(topic));
  const custom = (
    name: string,
    component = 'reconciler',
    statistic = 'Maximum',
  ) =>
    new cw.Metric({
      namespace: 'BatchAndBatter/Payments',
      metricName: name,
      dimensionsMap: { Environment: 'dev', Component: component },
      period: Duration.minutes(1),
      statistic,
    });
  const alarm = (
    id: string,
    metric: cw.IMetric,
    threshold = 1,
    periods = 1,
    comparisonOperator = cw.ComparisonOperator
      .GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData = cw.TreatMissingData.NOT_BREACHING,
  ) => {
    const a = new cw.Alarm(stack, `Payment${id}Alarm`, {
      alarmName: `${prefix}-payment-${id}`,
      metric,
      threshold,
      evaluationPeriods: periods,
      datapointsToAlarm: periods,
      comparisonOperator,
      treatMissingData,
      alarmDescription:
        'See PAYMENT_RECOVERY_RUNBOOK. Admission blocked until human SNS subscription confirmed.',
    });
    a.addAlarmAction(new actions.SnsAction(topic));
  };
  const minute = { period: Duration.minutes(1), statistic: 'Sum' };
  alarm('WorkerErrors', worker.fn.metricErrors(minute));
  alarm('WorkerThrottles', worker.fn.metricThrottles(minute));
  alarm('WorkerBatchFailures', custom('WorkerBatchFailure', 'worker', 'Sum'));
  alarm(
    'QueueAge',
    queue.metricApproximateAgeOfOldestMessage({
      period: Duration.minutes(1),
      statistic: 'Maximum',
    }),
    60,
  );
  alarm(
    'Backlog',
    new cw.MathExpression({
      expression: 'visible + inflight',
      period: Duration.minutes(1),
      usingMetrics: {
        visible: queue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        inflight: queue.metricApproximateNumberOfMessagesNotVisible({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
      },
    }),
    20,
    3,
  );
  alarm(
    'Dlq',
    dlq.metricApproximateNumberOfMessagesVisible({
      period: Duration.minutes(1),
      statistic: 'Maximum',
    }),
  );
  alarm('WebhookErrors', webhook.fn.metricErrors(minute));
  alarm(
    'WebhookDurableAcceptance',
    custom('WebhookDurableAcceptanceFailure', 'webhook', 'Sum'),
  );
  alarm('WorkflowOverdue', custom('WorkflowOverdueMs'), 60000, 2);
  alarm('UnknownOutcome', custom('UnknownOutcome'));
  alarm('CommittingOverdue', custom('CommittingOverdue'));
  alarm(
    'CapturedUnfinalized',
    custom('CapturedUnfinalizedMs'),
    60000,
    1,
    cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
  );
  alarm('ReadFailures', custom('ConsecutiveReadFailures'), 3);
  alarm(
    'RecoveryAge',
    custom('RecoveryAgeMs'),
    900000,
    1,
    cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
  );
  alarm(
    'SettlementInvariant',
    custom('SettlementInvariantConflict', 'worker', 'Sum'),
  );
  alarm(
    'RoutingFailure',
    custom('FinancialRoutingFailure', 'reconciler', 'Sum'),
  );
  alarm(
    'Heartbeat',
    custom('RecoveryHeartbeat', 'reconciler', 'Sum'),
    1,
    3,
    cw.ComparisonOperator.LESS_THAN_THRESHOLD,
    cw.TreatMissingData.BREACHING,
  );
}
