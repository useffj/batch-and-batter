import * as path from 'node:path';
import {
  Duration,
  RemovalPolicy,
  Stack,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_iam as iam,
  aws_sqs as sqs,
  aws_dynamodb as dynamodb,
  aws_scheduler as scheduler,
  aws_cloudwatch as cloudwatch,
} from 'aws-cdk-lib';
export function addCartExpiry(
  stack: Stack,
  prefix: string,
  catalog: dynamodb.Table,
  commerce: dynamodb.Table,
  operations: dynamodb.Table,
  queue: sqs.Queue,
  dlq: sqs.Queue,
) {
  const policy = (role: iam.Role, actions: string[], resource: string) =>
    role.addToPolicy(
      new iam.PolicyStatement({ actions, resources: [resource] }),
    );
  const create = (
    id: string,
    suffix: string,
    timeout: number,
    concurrency: number,
    environment: Record<string, string>,
  ) => {
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
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../../../../backend/dist/lambda'),
      ),
      role,
      logGroup,
      timeout: Duration.seconds(timeout),
      memorySize: 256,
      reservedConcurrentExecutions: concurrency,
      environment: {
        ...environment,
        OPERATIONS_TABLE_NAME: operations.tableName,
        RESERVATION_QUEUE_URL: queue.queueUrl,
        EXPIRY_METRIC_SERVICE: prefix,
      },
    });
    return { fn, role };
  };
  const worker = create('CartExpiryWorker', 'expiry-worker', 10, 5, {
    CATALOG_TABLE_NAME: catalog.tableName,
    COMMERCE_TABLE_NAME: commerce.tableName,
    RESERVATION_QUEUE_ARN: queue.queueArn,
  });
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
    ['dynamodb:GetItem', 'dynamodb:DeleteItem'],
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
    'CartExpiryQueueMapping',
    {
      functionName: worker.fn.functionName,
      eventSourceArn: queue.queueArn,
      batchSize: 1,
      maximumBatchingWindowInSeconds: 0,
      enabled: true,
      scalingConfig: { maximumConcurrency: 5 },
      functionResponseTypes: ['ReportBatchItemFailures'],
    },
  );
  mapping.node.addDependency(worker.role.node.findChild('DefaultPolicy'));
  const infrastructureDlq = new sqs.Queue(stack, 'RecoveryInfrastructureDlq', {
    queueName: `${prefix}-recovery-infrastructure-dlq`,
    fifo: false,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    retentionPeriod: Duration.days(14),
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const recovery = create(
    'CartExpiryReconciler',
    'expiry-reconciler',
    30,
    1,
    {},
  );
  policy(
    recovery.role,
    ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem'],
    operations.tableArn,
  );
  policy(recovery.role, ['sqs:SendMessage'], queue.queueArn);
  policy(recovery.role, ['sqs:SendMessage'], infrastructureDlq.queueArn);
  new lambda.CfnEventInvokeConfig(stack, 'CartExpiryReconcilerAsync', {
    functionName: recovery.fn.functionName,
    qualifier: '$LATEST',
    maximumRetryAttempts: 2,
    maximumEventAgeInSeconds: 120,
    destinationConfig: {
      onFailure: { destination: infrastructureDlq.queueArn },
    },
  });
  const group = new scheduler.CfnScheduleGroup(
    stack,
    'CartExpiryRecoveryGroup',
    { name: `${prefix}-cart-expiry-recovery` },
  );
  const scheduleRole = new iam.Role(stack, 'CartExpiryRecoveryRole', {
    assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
      conditions: {
        StringEquals: {
          'aws:SourceAccount': stack.account,
          'aws:SourceArn': group.attrArn,
        },
      },
    }),
  });
  policy(scheduleRole, ['lambda:InvokeFunction'], recovery.fn.functionArn);
  policy(scheduleRole, ['sqs:SendMessage'], infrastructureDlq.queueArn);
  const schedule = new scheduler.CfnSchedule(
    stack,
    'CartExpiryRecoverySchedule',
    {
      name: `${prefix}-cart-expiry-reconcile`,
      groupName: group.ref,
      scheduleExpression: 'rate(1 minute)',
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: recovery.fn.functionArn,
        roleArn: scheduleRole.roleArn,
        input: JSON.stringify({
          source: 'batch-and-batter.cart-expiry',
          operation: 'reconcileCartExpiry',
          schemaVersion: 1,
        }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 120 },
        deadLetterConfig: { arn: infrastructureDlq.queueArn },
      },
    },
  );
  schedule.node.addDependency(scheduleRole.node.findChild('DefaultPolicy'));
  const custom = (name: string, statistic = 'Sum') =>
    new cloudwatch.Metric({
      namespace: 'BatchAndBatter/CartExpiry',
      metricName: name,
      dimensionsMap: { Service: prefix },
      period: Duration.minutes(1),
      statistic,
    });
  const alarm = (
    id: string,
    metric: cloudwatch.IMetric,
    threshold = 1,
    periods = 1,
    missing = cloudwatch.TreatMissingData.NOT_BREACHING,
  ) =>
    new cloudwatch.Alarm(stack, `CartExpiry${id}Alarm`, {
      alarmName: `${prefix}-cart-expiry-${id}`,
      metric,
      threshold,
      evaluationPeriods: periods,
      datapointsToAlarm: periods,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: missing,
      alarmDescription:
        'Phase 5A2 dev operational alarm. External alarm notification destination is a production deployment gate.',
    });
  alarm(
    'WorkerErrors',
    worker.fn.metricErrors({ period: Duration.minutes(1) }),
  );
  alarm(
    'WorkerThrottles',
    worker.fn.metricThrottles({ period: Duration.minutes(1) }),
  );
  alarm('WorkerBatchFailures', custom('WorkerBatchFailure'));
  alarm(
    'Dlq',
    dlq.metricApproximateNumberOfMessagesVisible({
      period: Duration.minutes(1),
    }),
  );
  alarm('Overdue', custom('OldestOverdueMs', 'Maximum'), 300000, 3);
  alarm(
    'ReconcilerErrors',
    recovery.fn.metricErrors({ period: Duration.minutes(1) }),
  );
  alarm(
    'ReconcilerThrottles',
    recovery.fn.metricThrottles({ period: Duration.minutes(1) }),
  );
  new cloudwatch.Alarm(stack, 'CartExpiryHeartbeatAlarm', {
    alarmName: `${prefix}-cart-expiry-Heartbeat`,
    metric: custom('ReconcileHeartbeat'),
    threshold: 1,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    alarmDescription:
      'External alarm notification destination is a production deployment gate.',
  });
  alarm('Backlog', custom('DueWorkBacklogLowerBound', 'Maximum'), 400, 5);
  alarm('InvalidWork', custom('InvalidWork'));
  alarm(
    'QueueAge',
    queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
    900,
    3,
  );
  for (const metricName of ['TargetErrorCount', 'InvocationDroppedCount'])
    alarm(
      metricName,
      new cloudwatch.Metric({
        namespace: 'AWS/Scheduler',
        metricName,
        dimensionsMap: { ScheduleGroup: group.ref },
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
    );
  alarm(
    'DestinationFailures',
    new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'DestinationDeliveryFailures',
      dimensionsMap: { FunctionName: recovery.fn.functionName },
      statistic: 'Sum',
      period: Duration.minutes(1),
    }),
  );
  return { ...recovery, infrastructureDlq };
}
