import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DevelopmentStack } from '../lib/development-stack';
const t = Template.fromStack(
  new DevelopmentStack(new App(), 'PaymentsTest', {
    environment: 'dev',
    env: { account: '111111111111', region: 'us-east-2' },
  }),
);
const r = t.toJSON().Resources;
const find = (prefix: string, type?: string) =>
  Object.keys(r).find(
    (id) => id.startsWith(prefix) && (!type || r[id].Type === type),
  )!;
const fn = (prefix: string) =>
  r[find(prefix, 'AWS::Lambda::Function')].Properties;
const statements = (prefix: string) =>
  r[find(prefix, 'AWS::IAM::Policy')].Properties.PolicyDocument
    .Statement as any[];
const arn = (id: string) => ({ 'Fn::GetAtt': [id, 'Arn'] });
const parameter = (name: string) => ({
  'Fn::Join': [
    '',
    [
      'arn:',
      { Ref: 'AWS::Partition' },
      `:ssm:us-east-2:111111111111:parameter/batch-and-batter/dev/stripe/${name}`,
    ],
  ],
});

test('admission parameter defaults false; account bootstrap empty; app settings exact', () => {
  const a = fn('ApplicationApi');
  assert.equal(a.Timeout, 15);
  assert.equal(a.MemorySize, 256);
  assert.deepEqual(a.Environment.Variables.PAYMENT_START_ENABLED, {
    Ref: 'PaymentStartEnabled',
  });
  const parameter = t.toJSON().Parameters.PaymentStartEnabled;
  assert.equal(parameter.Type, 'String');
  assert.equal(parameter.Default, 'false');
  assert.deepEqual(parameter.AllowedValues, ['false', 'true']);
  assert.match(parameter.Description, /NEW payment admission/);
  for (const prefix of [
    'PaymentWorker',
    'CartExpiryWorker',
    'CartExpiryReconciler',
    'StripeWebhook',
  ]) {
    assert.equal(
      fn(prefix).Environment.Variables.PAYMENT_START_ENABLED,
      undefined,
    );
    assert.ok(!JSON.stringify(fn(prefix)).includes('PaymentStartEnabled'));
  }
  const refs = Object.entries(r).filter(([, resource]) =>
    JSON.stringify(resource).includes('PaymentStartEnabled'),
  );
  assert.deepEqual(
    refs.map(([id]) => id),
    [find('ApplicationApi', 'AWS::Lambda::Function')],
  );
  assert.equal(a.Environment.Variables.STRIPE_ENVIRONMENT, 'dev');
  assert.equal(t.toJSON().Parameters.StripeSandboxAccountId.Default, '');
});
test('payment queues have exact retention visibility SSE and redrive', () => {
  const q = r[find('PaymentQueue', 'AWS::SQS::Queue')].Properties;
  const d = r[find('PaymentDeadLetterQueue')].Properties;
  assert.equal(q.QueueName, 'batch-and-batter-dev-payment');
  assert.equal(q.VisibilityTimeout, 180);
  assert.equal(q.MessageRetentionPeriod, 345600);
  assert.equal(q.SqsManagedSseEnabled, true);
  assert.equal(q.FifoQueue, undefined);
  assert.deepEqual(q.RedrivePolicy, {
    deadLetterTargetArn: arn(find('PaymentDeadLetterQueue')),
    maxReceiveCount: 5,
  });
  assert.equal(d.MessageRetentionPeriod, 1209600);
  assert.equal(d.SqsManagedSseEnabled, true);
});
test('dedicated worker and webhook resource bounds and mapping are exact', () => {
  for (const [prefix, timeout, handler] of [
    ['PaymentWorker', 30, 'payment-worker-handler.handler'],
    ['StripeWebhook', 10, 'stripe-webhook-handler.handler'],
  ] as const) {
    const p = fn(prefix);
    assert.equal(p.Timeout, timeout);
    assert.equal(p.MemorySize, 256);
    assert.equal(p.ReservedConcurrentExecutions, 2);
    assert.equal(p.Runtime, 'nodejs24.x');
    assert.equal(p.Handler, handler);
    assert.notDeepEqual(p.Role, fn('CartExpiryWorker').Role);
    assert.equal(r[find(`${prefix}LogGroup`)].Properties.RetentionInDays, 14);
  }
  const { Tags: _tags, ...mapping } = r.PaymentQueueMapping.Properties;
  assert.deepEqual(mapping, {
    BatchSize: 1,
    Enabled: true,
    EventSourceArn: arn(find('PaymentQueue', 'AWS::SQS::Queue')),
    FunctionName: { Ref: find('PaymentWorker', 'AWS::Lambda::Function') },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    MaximumBatchingWindowInSeconds: 0,
    ScalingConfig: { MaximumConcurrency: 2 },
  });
});
test('each payment principal has only its exact parameter and constrained decrypt', () => {
  for (const [prefix, suffix, envName] of [
    [
      'ApplicationRoleDefaultPolicy',
      'payment-read-key',
      'STRIPE_READ_KEY_PARAMETER',
    ],
    [
      'PaymentWorkerRoleDefaultPolicy',
      'payment-worker-key',
      'STRIPE_WORKER_KEY_PARAMETER',
    ],
    [
      'StripeWebhookRoleDefaultPolicy',
      'webhook-signing-secret',
      'STRIPE_WEBHOOK_SECRET_PARAMETER',
    ],
  ] as const) {
    const s = statements(prefix);
    assert.deepEqual(
      s.filter((x) => String(x.Action).startsWith('ssm:')),
      [
        {
          Action: 'ssm:GetParameter',
          Effect: 'Allow',
          Resource: parameter(suffix),
        },
      ],
    );
    assert.deepEqual(
      s.filter((x) => String(x.Action).startsWith('kms:')),
      [
        {
          Action: 'kms:Decrypt',
          Effect: 'Allow',
          Resource: arn(find('StripeParameterKey', 'AWS::KMS::Key')),
          Condition: {
            StringEquals: {
              'kms:ViaService': 'ssm.us-east-2.amazonaws.com',
              'kms:EncryptionContext:PARAMETER_ARN': parameter(suffix),
            },
          },
        },
      ],
    );
    const f = fn(
      prefix.startsWith('Application')
        ? 'ApplicationApi'
        : prefix.split('Role')[0],
    );
    assert.equal(
      f.Environment.Variables[envName],
      `/batch-and-batter/dev/stripe/${suffix}`,
    );
    assert.equal(
      Object.keys(f.Environment.Variables).filter((k) => /PARAMETER$/.test(k))
        .length,
      1,
    );
  }
});
test('financial worker and webhook business IAM exactly match approved authority', () => {
  const expected = (table: string, Action: string[]) => ({
    Effect: 'Allow',
    Action,
    Resource: arn(find(table, 'AWS::DynamoDB::Table')),
  });
  assert.deepEqual(
    statements('PaymentWorkerRoleDefaultPolicy').filter((s) =>
      String(s.Action).includes('dynamodb:'),
    ),
    [
      expected('CatalogTable', ['dynamodb:GetItem', 'dynamodb:PutItem']),
      expected('CommerceTable', [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:ConditionCheckItem',
      ]),
      expected('OperationsTable', [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        'dynamodb:ConditionCheckItem',
      ]),
    ],
  );
  assert.deepEqual(
    statements('StripeWebhookRoleDefaultPolicy').filter((s) =>
      String(s.Action).includes('dynamodb:'),
    ),
    [expected('OperationsTable', ['dynamodb:GetItem', 'dynamodb:PutItem'])],
  );
  assert.deepEqual(
    statements('PaymentWorkerRoleDefaultPolicy').filter((s) =>
      String(s.Action).includes('sqs:'),
    ),
    [
      {
        Action: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:SendMessage',
        ],
        Effect: 'Allow',
        Resource: arn(find('PaymentQueue', 'AWS::SQS::Queue')),
      },
    ],
  );
});
test('shopping worker is isolated; reconciler financial authority is queue-send only', () => {
  for (const prefix of ['CartExpiryWorker', 'CartExpiryReconciler']) {
    assert.doesNotMatch(
      JSON.stringify(statements(`${prefix}RoleDefaultPolicy`)),
      /ssm:|kms:/,
    );
    assert.doesNotMatch(JSON.stringify(fn(prefix).Environment), /STRIPE/);
  }
  assert.doesNotMatch(
    JSON.stringify(statements('CartExpiryWorkerRoleDefaultPolicy')),
    /PaymentQueue/,
  );
  const financial = statements('CartExpiryReconcilerRoleDefaultPolicy').filter(
    (s) => JSON.stringify(s).includes('PaymentQueue'),
  );
  assert.deepEqual(financial, [
    {
      Effect: 'Allow',
      Action: 'sqs:SendMessage',
      Resource: arn(find('PaymentQueue', 'AWS::SQS::Queue')),
    },
  ]);
});
test('payment routes have NONE auth and webhook targets only the dedicated Lambda', () => {
  for (const route of [
    'POST /webhooks/stripe',
    'POST /carts/{cartId}/payment/start',
    'POST /carts/{cartId}/payment/confirm',
    'GET /carts/{cartId}/payment',
  ]) {
    const entry: any = Object.values(r).find(
      (x: any) =>
        x.Type === 'AWS::ApiGatewayV2::Route' &&
        x.Properties.RouteKey === route,
    );
    assert.equal(entry.Properties.AuthorizationType, 'NONE');
    assert.equal(entry.Properties.AuthorizerId, undefined);
    const integration = entry.Properties.Target['Fn::Join'][1][1].Ref;
    assert.deepEqual(
      r[integration].Properties.IntegrationUri,
      arn(
        find(
          route.includes('webhooks') ? 'StripeWebhook' : 'ApplicationApi',
          'AWS::Lambda::Function',
        ),
      ),
    );
  }
});
test('CMK retained with rotation; no parameters or subscriptions; runtime Scan restricted to approved Catalog policy', () => {
  const key = r[find('StripeParameterKey', 'AWS::KMS::Key')];
  assert.equal(key.DeletionPolicy, 'Retain');
  assert.equal(key.UpdateReplacePolicy, 'Retain');
  assert.equal(key.Properties.EnableKeyRotation, true);
  assert.equal(
    r[find('StripeParameterKeyAlias')].Properties.AliasName,
    'alias/batch-and-batter-dev-stripe',
  );
  t.resourceCountIs('AWS::SSM::Parameter', 0);
  t.resourceCountIs('AWS::SNS::Subscription', 0);
  let catalogScanStatements = 0;
  for (const [id, p] of Object.entries(t.findResources('AWS::IAM::Policy'))) {
    const statements = p.Properties.PolicyDocument.Statement;
    for (const statement of statements) {
      if (JSON.stringify(statement.Action).includes('dynamodb:Scan')) {
        assert.equal(id, 'ApplicationRoleDefaultPolicy2A2BCE7E');
        assert.deepEqual(p.Properties.Roles, [
          { Ref: 'ApplicationRole90C00724' },
        ]);
        assert.deepEqual(statement, {
          Action: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:Scan',
            'dynamodb:PutItem',
            'dynamodb:DeleteItem',
            'dynamodb:ConditionCheckItem',
          ],
          Effect: 'Allow',
          Resource: { 'Fn::GetAtt': ['CatalogTableF8EA09BD', 'Arn'] },
        });
        catalogScanStatements++;
      } else if (
        JSON.stringify(statement.Action).includes('dynamodb:UpdateItem')
      ) {
        assert.ok(id.startsWith('ApplicationRoleDefaultPolicy'));
        assert.deepEqual(statement, {
          Action: 'dynamodb:UpdateItem',
          Effect: 'Allow',
          Resource: { 'Fn::GetAtt': ['OperationsTable90528792', 'Arn'] },
          Condition: {
            'ForAllValues:StringLike': {
              'dynamodb:LeadingKeys': ['GUEST_RATE#*'],
            },
          },
        });
      } else
        assert.doesNotMatch(
          JSON.stringify(statement),
          /dynamodb:(Scan|UpdateItem|BatchWriteItem|\*)|ssm:GetParametersByPath|kms:\*/,
        );
    }
  }
  assert.equal(catalogScanStatements, 1);
  assert.doesNotMatch(
    JSON.stringify(t.toJSON()),
    /rk_test_|sk_live_|whsec_|client_secret/,
  );
});
test('all 17 financial alarms publish to unsubscribed topic with bounded dimensions and heartbeat semantics', () => {
  const alarms = Object.entries(r).filter(
    ([id, x]: any) =>
      id.startsWith('Payment') && x.Type === 'AWS::CloudWatch::Alarm',
  );
  assert.equal(alarms.length, 17);
  for (const [, entry] of alarms as any[]) {
    const p = entry.Properties;
    assert.deepEqual(p.AlarmActions, [
      { Ref: find('PaymentAlerts', 'AWS::SNS::Topic') },
    ]);
    assert.doesNotMatch(
      JSON.stringify(p.Dimensions ?? p.Metrics),
      /cartId|orderId|attemptId/,
    );
    assert.equal(
      p.TreatMissingData,
      p.AlarmName.endsWith('-Heartbeat') ? 'breaching' : 'notBreaching',
    );
  }
  assert.equal(
    r[find('PaymentHeartbeatAlarm')].Properties.EvaluationPeriods,
    3,
  );
  assert.equal(
    r[find('PaymentWorkflowOverdueAlarm')].Properties.Threshold,
    60000,
  );
  assert.equal(
    r[find('PaymentWorkflowOverdueAlarm')].Properties.EvaluationPeriods,
    2,
  );
});

test('SNS delivery policy limits CloudWatch to the account and payment alarm prefix', () => {
  const policy: any = Object.values(
    t.findResources('AWS::SNS::TopicPolicy'),
  )[0];
  const statement = policy.Properties.PolicyDocument.Statement.find(
    (s: any) => s.Principal.Service === 'cloudwatch.amazonaws.com',
  );
  assert.equal(statement.Action, 'sns:Publish');
  assert.equal(
    statement.Condition.StringEquals['aws:SourceAccount'],
    '111111111111',
  );
  assert.match(
    JSON.stringify(statement.Condition.ArnLike['aws:SourceArn']),
    /:alarm:batch-and-batter-dev-payment-\*/,
  );
});

test('recovery infrastructure envelopes have a separate unconsumed encrypted DLQ and immediate SNS alarm', () => {
  const id = find('RecoveryInfrastructureDlq', 'AWS::SQS::Queue');
  const { Tags: _tags, ...queue } = r[id].Properties;
  assert.deepEqual(queue, {
    QueueName: 'batch-and-batter-dev-recovery-infrastructure-dlq',
    MessageRetentionPeriod: 1209600,
    SqsManagedSseEnabled: true,
  });
  for (const mapping of Object.values(
    t.findResources('AWS::Lambda::EventSourceMapping'),
  ))
    assert.notDeepEqual(mapping.Properties.EventSourceArn, arn(id));
  for (const q of Object.values(t.findResources('AWS::SQS::Queue')))
    assert.notDeepEqual(
      q.Properties.RedrivePolicy?.deadLetterTargetArn,
      arn(id),
    );
  assert.deepEqual(r.CartExpiryReconcilerAsync.Properties.DestinationConfig, {
    OnFailure: { Destination: arn(id) },
  });
  const schedule = r.CartExpiryRecoverySchedule.Properties;
  assert.deepEqual(schedule.Target.DeadLetterConfig, { Arn: arn(id) });
  assert.equal(schedule.GroupName.Ref, 'CartExpiryRecoveryGroup');
  assert.equal(
    schedule.Target.Input,
    JSON.stringify({
      source: 'batch-and-batter.cart-expiry',
      operation: 'reconcileCartExpiry',
      schemaVersion: 1,
    }),
  );
  for (const prefix of ['CartExpiryWorker', 'PaymentWorker'])
    assert.ok(
      !JSON.stringify(statements(`${prefix}RoleDefaultPolicy`)).includes(id),
    );
  const alarm = r[find('RecoveryInfrastructureDlqNonEmpty')].Properties;
  assert.equal(
    alarm.AlarmName,
    'batch-and-batter-dev-payment-RecoveryInfrastructureDlqNonEmpty',
  );
  assert.equal(alarm.Namespace, 'AWS/SQS');
  assert.equal(alarm.MetricName, 'ApproximateNumberOfMessagesVisible');
  assert.equal(alarm.Statistic, 'Maximum');
  assert.equal(alarm.Period, 60);
  assert.equal(alarm.Threshold, 1);
  assert.equal(alarm.EvaluationPeriods, 1);
  assert.equal(alarm.DatapointsToAlarm, 1);
  assert.equal(alarm.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
  assert.equal(alarm.TreatMissingData, 'notBreaching');
  assert.deepEqual(alarm.Dimensions, [
    { Name: 'QueueName', Value: { 'Fn::GetAtt': [id, 'QueueName'] } },
  ]);
  assert.deepEqual(alarm.AlarmActions, [
    { Ref: find('PaymentAlerts', 'AWS::SNS::Topic') },
  ]);
  const oldAlarm = r[find('CartExpiryDlqAlarm')].Properties;
  assert.equal(oldAlarm.AlarmName, 'batch-and-batter-dev-cart-expiry-Dlq');
  assert.deepEqual(oldAlarm.Dimensions, [
    {
      Name: 'QueueName',
      Value: {
        'Fn::GetAtt': [find('ReservationDeadLetterQueue'), 'QueueName'],
      },
    },
  ]);
  assert.equal(oldAlarm.AlarmActions, undefined);
});

test('resolving false versus true changes only the application admission environment', () => {
  const resolveAdmission = (value: string) =>
    JSON.parse(
      JSON.stringify(r, (_key, node) =>
        node &&
        typeof node === 'object' &&
        Object.keys(node).length === 1 &&
        node.Ref === 'PaymentStartEnabled'
          ? value
          : node,
      ),
    );
  const disabled = resolveAdmission(
    t.toJSON().Parameters.PaymentStartEnabled.Default,
  );
  const enabled = resolveAdmission('true');
  const id = find('ApplicationApi', 'AWS::Lambda::Function');
  assert.equal(
    disabled[id].Properties.Environment.Variables.PAYMENT_START_ENABLED,
    'false',
  );
  assert.equal(
    enabled[id].Properties.Environment.Variables.PAYMENT_START_ENABLED,
    'true',
  );
  enabled[id].Properties.Environment.Variables.PAYMENT_START_ENABLED = 'false';
  assert.deepEqual(enabled, disabled);
});

test('API worker and webhook receive the same independently bound DEV ledger configuration', () => {
  for (const prefix of ['ApplicationApi', 'PaymentWorker', 'StripeWebhook']) {
    const env = fn(prefix).Environment.Variables;
    assert.deepEqual(env.STRIPE_ACCOUNT_ID, { Ref: 'StripeSandboxAccountId' });
    assert.deepEqual(env.STRIPE_LEDGER_NAMESPACE, {
      Ref: 'DevPaymentLedgerNamespace',
    });
    assert.deepEqual(env.STRIPE_LEDGER_ACCOUNT_ID, {
      Ref: 'DevPaymentLedgerAccountId',
    });
    assert.equal(env.STRIPE_ENVIRONMENT, 'dev');
  }
  for (const name of ['DevPaymentLedgerNamespace', 'DevPaymentLedgerAccountId'])
    assert.equal(t.toJSON().Parameters[name].Default, '');
  for (const prefix of ['CartExpiryWorker', 'CartExpiryReconciler']) {
    assert.equal(
      fn(prefix).Environment.Variables.STRIPE_LEDGER_NAMESPACE,
      undefined,
    );
    assert.equal(
      fn(prefix).Environment.Variables.STRIPE_LEDGER_ACCOUNT_ID,
      undefined,
    );
  }
});
