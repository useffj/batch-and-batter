import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DevelopmentStack } from '../lib/development-stack';

const compositionRoutes = [
  'POST /admin/drops/{dropId}/pause',
  'POST /admin/drops/{dropId}/resume',
  'POST /admin/drops/{dropId}/close',
  'POST /admin/drops/{dropId}/reconcile-opening',
  'POST /admin/drops/{dropId}/open',
  'POST /admin/drops/{dropId}/publish',
  'GET /admin/drops/{dropId}/composition',
  'POST /admin/drops/{dropId}/products',
  'PUT /admin/drops/{dropId}/products/{productId}',
  'DELETE /admin/drops/{dropId}/products/{productId}',
  'PUT /admin/drops/{dropId}/pickups/{date}',
  'DELETE /admin/drops/{dropId}/pickups/{date}',
];

const stack = new DevelopmentStack(new App(), 'TestDev', {
  environment: 'dev',
});
const template = Template.fromStack(stack);

test('existing default stage emits only approved JSON access fields to a dedicated fourteen-day log group', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Stage', 1);
  const accessLogId = Object.keys(
    template.findResources('AWS::Logs::LogGroup', {
      Properties: {
        LogGroupName:
          '/aws/vendedlogs/apigateway/batch-and-batter-dev-http-api',
      },
    }),
  )[0];
  assert.ok(accessLogId);
  assert.equal(
    template.toJSON().Resources[accessLogId].Properties.RetentionInDays,
    14,
  );
  const stage = template.toJSON().Resources.HttpApiDefaultStage3EEB07D6;
  assert.equal(stage.Properties.StageName, '$default');
  assert.equal(stage.Properties.AutoDeploy, true);
  assert.deepEqual(stage.Properties.AccessLogSettings.DestinationArn, {
    'Fn::GetAtt': [accessLogId, 'Arn'],
  });
  const format = stage.Properties.AccessLogSettings.Format;
  assert.deepEqual(JSON.parse(format), {
    requestId: '$context.requestId',
    routeKey: '$context.routeKey',
    httpMethod: '$context.httpMethod',
    path: '$context.path',
    status: '$context.status',
    responseLength: '$context.responseLength',
    integrationStatus: '$context.integrationStatus',
    integrationErrorMessage: '$context.integrationErrorMessage',
    integrationLatency: '$context.integrationLatency',
    integrationRequestId: '$context.integration.requestId',
    requestTime: '$context.requestTime',
  });
  assert.doesNotMatch(
    format,
    /authorization|token|cookie|body|password|apiKey|query|claims|email|phone|payment|sourceIp/i,
  );
  template.resourceCountIs('AWS::Logs::ResourcePolicy', 0);
});

test('three on-demand tables have only the approved string PK/SK foundation', () => {
  template.resourceCountIs('AWS::DynamoDB::Table', 3);
  for (const name of ['catalog', 'commerce', 'operations']) {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `batch-and-batter-dev-${name}`,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.absent(),
      LocalSecondaryIndexes: Match.absent(),
      DeletionProtectionEnabled: false,
    });
  }
});

test('application Node 24 Lambda preserves its identity and serves exactly the twenty-four approved routes', () => {
  template.resourceCountIs('AWS::Lambda::Function', 3);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Handler: 'handler.handler',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 24);
  const functionId = Object.keys(
    template.findResources('AWS::Lambda::Function'),
  )[0];
  assert.equal(functionId, 'ApplicationApi5D63FF39');
  const routes = Object.values(
    template.findResources('AWS::ApiGatewayV2::Route'),
  );
  assert.deepEqual(
    routes.map((route) => route.Properties.RouteKey).sort(),
    [
      ...compositionRoutes,
      'POST /carts',
      'GET /carts/{cartId}',
      'PUT /carts/{cartId}/items',
      'DELETE /carts/{cartId}',
      'GET /admin/me',
      'GET /drops/current',
      'GET /drops/{dropId}',
      'GET /health',
      'POST /admin/products',
      'PUT /admin/products/{productId}',
      'POST /admin/drops',
      'PUT /admin/drops/{dropId}',
    ].sort(),
  );
  for (const route of routes.filter(
    (route) => !route.Properties.RouteKey.includes('/admin/'),
  )) {
    assert.equal(route.Properties.AuthorizationType, 'NONE');
    assert.equal(route.Properties.AuthorizerId, undefined);
  }
  const integrationId = Object.keys(
    template.findResources('AWS::ApiGatewayV2::Integration'),
  )[0];
  template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
    IntegrationType: 'AWS_PROXY',
    PayloadFormatVersion: '2.0',
    IntegrationUri: { 'Fn::GetAtt': [functionId, 'Arn'] },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'GET /health',
    AuthorizationType: 'NONE',
    Target: { 'Fn::Join': ['', ['integrations/', { Ref: integrationId }]] },
  });
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunction',
    Principal: 'apigateway.amazonaws.com',
    FunctionName: { 'Fn::GetAtt': [functionId, 'Arn'] },
    SourceArn: Match.anyValue(),
  });
});

for (const name of ['reservation', 'notification']) {
  test(`${name} standard queue redrives to its own longer-lived DLQ after five receives`, () => {
    const dlqId = Object.keys(
      template.findResources('AWS::SQS::Queue', {
        Properties: { QueueName: `batch-and-batter-dev-${name}-dlq` },
      }),
    )[0];
    assert.ok(dlqId);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: `batch-and-batter-dev-${name}-dlq`,
      FifoQueue: Match.absent(),
      MessageRetentionPeriod: 1209600,
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: `batch-and-batter-dev-${name}`,
      FifoQueue: Match.absent(),
      DelaySeconds: 0,
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 345600,
      VisibilityTimeout: name === 'reservation' ? 60 : 30,
      RedrivePolicy: {
        deadLetterTargetArn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
        maxReceiveCount: 5,
      },
    });
  });
}

test('existing admin pool disables signup and has no users or hosted domain', () => {
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.hasResourceProperties('AWS::Cognito::UserPool', {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  });
  for (const type of ['UserPoolUser', 'UserPoolDomain']) {
    template.resourceCountIs(`AWS::Cognito::${type}`, 0);
  }
});

test('media is private, encrypted, owner controlled and denies insecure transport', () => {
  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    WebsiteConfiguration: Match.absent(),
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Action: 's3:*',
          Principal: { AWS: '*' },
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
      ]),
    },
  });
});

test('Lambda has only scoped logging and the exact Catalog composition permissions', () => {
  template.resourceCountIs('AWS::Logs::LogGroup', 4);
  template.hasResourceProperties('AWS::Logs::LogGroup', {
    RetentionInDays: 14,
  });
  template.resourceCountIs('AWS::IAM::Role', 5);
  template.hasResourceProperties('AWS::IAM::Role', {
    ManagedPolicyArns: Match.absent(),
  });
  template.resourceCountIs('AWS::IAM::Policy', 5);
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies)
    .find((p) =>
      p.Properties.PolicyDocument.Statement.some((s: { Action: string[] }) =>
        s.Action.includes('dynamodb:GetItem'),
      ),
    )!
    .Properties.PolicyDocument.Statement.filter(
      (s: { Action: string | string[] }) =>
        typeof s.Action !== 'string' &&
        !s.Action.includes('scheduler:CreateSchedule'),
    );
  assert.equal(statements.length, 4);
  assert.deepEqual(statements[0].Action, [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
  ]);
  assert.equal(statements[0].Effect, 'Allow');
  const logId = Object.keys(
    template.findResources('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: '/aws/lambda/batch-and-batter-dev-api' },
    }),
  )[0];
  assert.deepEqual(statements[0].Resource, { 'Fn::GetAtt': [logId, 'Arn'] });
  const catalogId = Object.keys(
    template.findResources('AWS::DynamoDB::Table', {
      Properties: { TableName: 'batch-and-batter-dev-catalog' },
    }),
  )[0];
  assert.deepEqual(statements[1], {
    Effect: 'Allow',
    Action: [
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:PutItem',
      'dynamodb:DeleteItem',
      'dynamodb:ConditionCheckItem',
    ],
    Resource: { 'Fn::GetAtt': [catalogId, 'Arn'] },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { CATALOG_TABLE_NAME: { Ref: catalogId } } },
  });
  for (const [index, name] of ['Commerce', 'Operations'].entries()) {
    const id = Object.keys(template.findResources('AWS::DynamoDB::Table')).find(
      (id) => id.startsWith(name),
    )!;
    assert.deepEqual(statements[index + 2], {
      Effect: 'Allow',
      Action: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      Resource: { 'Fn::GetAtt': [id, 'Arn'] },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: { [`${name.toUpperCase()}_TABLE_NAME`]: { Ref: id } },
      },
    });
  }
  // Additional single-action statements are checked against the Phase 5A1 baseline below.
  template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
});

test('stateful development resources carry project/environment tags and removal policy', () => {
  for (const type of [
    'AWS::DynamoDB::Table',
    'AWS::SQS::Queue',
    'AWS::S3::Bucket',
    'AWS::Logs::LogGroup',
  ]) {
    for (const resource of Object.values(template.findResources(type))) {
      assert.equal(resource.DeletionPolicy, 'Delete');
      assert.ok(
        resource.Properties.Tags.some(
          (tag: { Key: string; Value: string }) =>
            tag.Key === 'Project' && tag.Value === 'batch-and-batter',
        ),
      );
      assert.ok(
        resource.Properties.Tags.some(
          (tag: { Key: string; Value: string }) =>
            tag.Key === 'Environment' && tag.Value === 'dev',
        ),
      );
    }
  }
  template.resourceCountIs('AWS::SQS::Queue', 4);
  template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  template.resourceCountIs('AWS::Scheduler::Schedule', 1);
});

test('development removal settings cannot be reused for production accidentally', () => {
  assert.throws(
    () => new DevelopmentStack(new App(), 'Prod', { environment: 'prod' }),
    /Only dev/,
  );
});

test('one secretless client enables only password, SRP and refresh with explicit lifetimes', () => {
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  const poolId = Object.keys(
    template.findResources('AWS::Cognito::UserPool'),
  )[0];
  const clientId = Object.keys(
    template.findResources('AWS::Cognito::UserPoolClient'),
  )[0];
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    UserPoolId: { Ref: poolId },
    GenerateSecret: false,
    AllowedOAuthFlowsUserPoolClient: false,
    AllowedOAuthFlows: Match.absent(),
    CallbackURLs: Match.absent(),
    AccessTokenValidity: 15,
    IdTokenValidity: 15,
    RefreshTokenValidity: 1440,
    TokenValidityUnits: {
      AccessToken: 'minutes',
      IdToken: 'minutes',
      RefreshToken: 'minutes',
    },
    EnableTokenRevocation: true,
    PreventUserExistenceErrors: 'ENABLED',
    SupportedIdentityProviders: ['COGNITO'],
  });
  const client = template.findResources('AWS::Cognito::UserPoolClient')[
    clientId
  ];
  assert.deepEqual(
    [...client.Properties.ExplicitAuthFlows].sort(),
    [
      'ALLOW_REFRESH_TOKEN_AUTH',
      'ALLOW_USER_PASSWORD_AUTH',
      'ALLOW_USER_SRP_AUTH',
    ].sort(),
  );
  template.hasOutput('AdminUserPoolId', { Value: { Ref: poolId } });
  template.hasOutput('AdminAppClientId', { Value: { Ref: clientId } });
});

test('all seventeen admin routes bind the JWT authorizer to the existing pool, client and HTTP API', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  const poolId = Object.keys(
    template.findResources('AWS::Cognito::UserPool'),
  )[0];
  const clientId = Object.keys(
    template.findResources('AWS::Cognito::UserPoolClient'),
  )[0];
  const apiId = Object.keys(
    template.findResources('AWS::ApiGatewayV2::Api'),
  )[0];
  const authorizerId = Object.keys(
    template.findResources('AWS::ApiGatewayV2::Authorizer'),
  )[0];
  template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    ApiId: { Ref: apiId },
    AuthorizerType: 'JWT',
    IdentitySource: ['$request.header.Authorization'],
    JwtConfiguration: {
      Audience: [{ Ref: clientId }],
      Issuer: { 'Fn::GetAtt': [poolId, 'ProviderURL'] },
    },
  });
  for (const route of [
    ...compositionRoutes,
    'GET /admin/me',
    'POST /admin/products',
    'PUT /admin/products/{productId}',
    'POST /admin/drops',
    'PUT /admin/drops/{dropId}',
  ]) {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      ApiId: { Ref: apiId },
      RouteKey: route,
      AuthorizationType: 'JWT',
      AuthorizerId: { Ref: authorizerId },
      AuthorizationScopes: Match.absent(),
    });
  }
  // Keep Lambda invocation behind API Gateway, with no public function URL.
  template.resourceCountIs('AWS::Lambda::Url', 0);
});

test('existing pool, API, Lambda and table logical identities remain unchanged', () => {
  const expected = {
    CatalogTableF8EA09BD: 'AWS::DynamoDB::Table',
    CommerceTable6CC80189: 'AWS::DynamoDB::Table',
    OperationsTable90528792: 'AWS::DynamoDB::Table',
    AdminUserPoolD0AF18CF: 'AWS::Cognito::UserPool',
    AdminUserPoolAdminAppClient43C1FAD5: 'AWS::Cognito::UserPoolClient',
    HttpApiAdminJwtAuthorizerA698361D: 'AWS::ApiGatewayV2::Authorizer',
    ApplicationApi5D63FF39: 'AWS::Lambda::Function',
    HttpApiF5A9A8A7: 'AWS::ApiGatewayV2::Api',
  };
  for (const [id, type] of Object.entries(expected))
    assert.ok(
      template.findResources(type)[id],
      `Missing original resource ${id}`,
    );
});

test('admin group uses the existing pool, has no IAM role and provisions no membership', () => {
  template.resourceCountIs('AWS::Cognito::UserPoolGroup', 1);
  template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
    GroupName: 'batch-and-batter-admins',
    UserPoolId: { Ref: 'AdminUserPoolD0AF18CF' },
    RoleArn: Match.absent(),
  });
  template.resourceCountIs('AWS::Cognito::UserPoolUserToGroupAttachment', 0);
  template.resourceCountIs('AWS::Cognito::UserPoolUser', 0);
  template.hasOutput('AdminGroupName', { Value: { Ref: 'AdminGroup' } });
});

test('tables, pool including MFA, client and JWT authorizer exactly preserve the Phase 4B1 template', () => {
  // Captured from the pre-change local synthesis; excludes stack-path metadata only.
  const baseline = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../test/fixtures/phase-4b1-protected-resources.json',
      ),
      'utf8',
    ),
  );
  for (const [id, expected] of Object.entries(baseline)) {
    const { Metadata: _metadata, ...actual } = template.toJSON().Resources[id];
    assert.deepEqual(actual, expected, `Protected resource changed: ${id}`);
  }
});

test('every route integration invokes only the existing Lambda through route-scoped API Gateway permissions', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Integration', 24);
  template.resourceCountIs('AWS::Lambda::Permission', 24);
  for (const resource of Object.values(
    template.findResources('AWS::ApiGatewayV2::Integration'),
  )) {
    assert.deepEqual(resource.Properties.IntegrationUri, {
      'Fn::GetAtt': ['ApplicationApi5D63FF39', 'Arn'],
    });
    assert.equal(resource.Properties.IntegrationType, 'AWS_PROXY');
  }
  const permissions = Object.values(
    template.findResources('AWS::Lambda::Permission'),
  );
  for (const route of [
    '/*/*/admin/drops/{dropId}/publish',
    '/*/*/admin/drops/{dropId}/open',
    '/*/*/admin/drops/{dropId}/pause',
    '/*/*/admin/drops/{dropId}/resume',
    '/*/*/admin/drops/{dropId}/close',
    '/*/*/admin/drops/{dropId}/reconcile-opening',
    '/*/*/admin/products',
    '/*/*/admin/products/{productId}',
    '/*/*/admin/drops',
    '/*/*/admin/drops/{dropId}',
  ]) {
    assert.ok(
      permissions.some(
        (resource) =>
          resource.Properties.SourceArn['Fn::Join'][1].at(-1) === route,
      ),
    );
  }
  for (const resource of permissions) {
    assert.equal(resource.Properties.Principal, 'apigateway.amazonaws.com');
    assert.equal(resource.Properties.Action, 'lambda:InvokeFunction');
    assert.deepEqual(resource.Properties.FunctionName, {
      'Fn::GetAtt': ['ApplicationApi5D63FF39', 'Arn'],
    });
  }
});

test('Phase 5A2 changes only approved properties of Phase 5A1 resources', () => {
  const baseline = JSON.parse(
    readFileSync(
      join(__dirname, '../../../test/fixtures/phase-5a1-resources.json'),
      'utf8',
    ),
  );
  const current = template.toJSON().Resources;
  for (const [id, original] of Object.entries(baseline)) {
    assert.ok(current[id], `Removed resource: ${id}`);
    const { Metadata: ignored, ...actual } = current[id];
    const expected = structuredClone(original) as typeof actual;
    if (id === 'ApplicationApi5D63FF39') {
      expected.Properties.Code = actual.Properties.Code;
      expected.Properties.Environment.Variables.RESERVATION_QUEUE_URL = {
        Ref: 'ReservationQueue43323CC1',
      };
    } else if (id.startsWith('ApplicationRoleDefaultPolicy')) {
      expected.Properties.PolicyDocument.Statement.push(
        {
          Effect: 'Allow',
          Action: 'dynamodb:DeleteItem',
          Resource: { 'Fn::GetAtt': ['OperationsTable90528792', 'Arn'] },
        },
        {
          Effect: 'Allow',
          Action: 'sqs:SendMessage',
          Resource: { 'Fn::GetAtt': ['ReservationQueue43323CC1', 'Arn'] },
        },
      );
    } else if (id === 'ReservationQueue43323CC1')
      expected.Properties.VisibilityTimeout = 60;
    assert.deepEqual(actual, expected, `Unapproved resource change: ${id}`);
  }
  const added = Object.entries(current)
    .filter(([id]) => !(id in baseline))
    .map(([, r]) => (r as { Type: string }).Type)
    .sort();
  assert.deepEqual(
    added,
    [
      ...Array(14).fill('AWS::CloudWatch::Alarm'),
      ...Array(3).fill('AWS::IAM::Policy'),
      ...Array(3).fill('AWS::IAM::Role'),
      'AWS::Lambda::EventInvokeConfig',
      'AWS::Lambda::EventSourceMapping',
      ...Array(2).fill('AWS::Lambda::Function'),
      ...Array(2).fill('AWS::Logs::LogGroup'),
      'AWS::Scheduler::Schedule',
      'AWS::Scheduler::ScheduleGroup',
    ].sort(),
  );
});

test('automatic opening has exact group trust, minimal policies and bounded async execution', () => {
  const resources = template.toJSON().Resources;
  const groupId = Object.keys(
    template.findResources('AWS::Scheduler::ScheduleGroup'),
  )[0];
  assert.equal(
    resources[groupId].Properties.Name,
    'batch-and-batter-dev-openings',
  );
  const schedulerRoleId = Object.keys(
    template.findResources('AWS::IAM::Role'),
  ).find(
    (id) =>
      resources[id].Properties.AssumeRolePolicyDocument.Statement[0].Principal
        .Service === 'scheduler.amazonaws.com',
  )!;
  assert.deepEqual(
    resources[schedulerRoleId].Properties.AssumeRolePolicyDocument,
    {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { Service: 'scheduler.amazonaws.com' },
          Condition: {
            StringEquals: {
              'aws:SourceAccount': { Ref: 'AWS::AccountId' },
              'aws:SourceArn': { 'Fn::GetAtt': [groupId, 'Arn'] },
            },
          },
        },
      ],
    },
  );
  const arn = (service: string, suffix: string) => ({
    'Fn::Join': [
      '',
      [
        'arn:',
        { Ref: 'AWS::Partition' },
        `:${service}:`,
        { Ref: 'AWS::Region' },
        ':',
        { Ref: 'AWS::AccountId' },
        suffix,
      ],
    ],
  });
  const target = arn('lambda', ':function:batch-and-batter-dev-api');
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  const schedulerPolicy = policies.find((p) =>
    p.Properties.Roles.some((r: { Ref: string }) => r.Ref === schedulerRoleId),
  )!;
  assert.deepEqual(schedulerPolicy.Properties.PolicyDocument, {
    Version: '2012-10-17',
    Statement: [
      { Action: 'lambda:InvokeFunction', Effect: 'Allow', Resource: target },
    ],
  });
  const applicationPolicy = policies.find((p) => p !== schedulerPolicy)!;
  const statements = applicationPolicy.Properties.PolicyDocument.Statement;
  assert.equal(statements.length, 8);
  assert.deepEqual(statements.slice(0, 2), [
    {
      Action: ['scheduler:CreateSchedule', 'scheduler:GetSchedule'],
      Effect: 'Allow',
      Resource: arn(
        'scheduler',
        ':schedule/batch-and-batter-dev-openings/open-*',
      ),
    },
    {
      Action: 'iam:PassRole',
      Effect: 'Allow',
      Resource: { 'Fn::GetAtt': [schedulerRoleId, 'Arn'] },
      Condition: {
        StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
      },
    },
  ]);
  const catalogId = Object.keys(
    template.findResources('AWS::DynamoDB::Table'),
  ).find(
    (id) =>
      resources[id].Properties.TableName === 'batch-and-batter-dev-catalog',
  )!;
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: {
        CATALOG_TABLE_NAME: { Ref: catalogId },
        OPEN_SCHEDULE_GROUP: { Ref: groupId },
        OPEN_TARGET_ARN: target,
        OPEN_SCHEDULE_ROLE_ARN: { 'Fn::GetAtt': [schedulerRoleId, 'Arn'] },
      },
    },
  });
  template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 2);
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    FunctionName: { Ref: 'ApplicationApi5D63FF39' },
    Qualifier: '$LATEST',
    MaximumEventAgeInSeconds: 900,
    MaximumRetryAttempts: 2,
    DestinationConfig: Match.absent(),
  });
});

test('expiry worker, recovery, IAM and notification-free alarms are narrowly bounded', () => {
  const resources = template.toJSON().Resources;
  const find = (prefix: string) =>
    Object.keys(resources).find((id) => id.startsWith(prefix))!;
  const functions = template.findResources('AWS::Lambda::Function');
  const workerId = Object.keys(functions).find((id) =>
    id.startsWith('CartExpiryWorker'),
  )!;
  const reconcilerId = Object.keys(functions).find((id) =>
    id.startsWith('CartExpiryReconciler'),
  )!;
  for (const [id, timeout, concurrency, handler] of [
    [workerId, 10, 5, 'expiry-worker-handler.handler'],
    [reconcilerId, 30, 1, 'expiry-reconciler-handler.handler'],
  ] as const) {
    assert.equal(resources[id].Properties.Timeout, timeout);
    assert.equal(
      resources[id].Properties.ReservedConcurrentExecutions,
      concurrency,
    );
    assert.equal(resources[id].Properties.Handler, handler);
    assert.equal(resources[id].Properties.Runtime, 'nodejs24.x');
    assert.ok(
      resources[id].Properties.Environment.Variables.RESERVATION_QUEUE_URL,
    );
  }
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 1,
    MaximumBatchingWindowInSeconds: 0,
    ScalingConfig: { MaximumConcurrency: 5 },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    EventSourceArn: { 'Fn::GetAtt': ['ReservationQueue43323CC1', 'Arn'] },
    FunctionName: { Ref: workerId },
    Enabled: true,
  });
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    FunctionName: { Ref: reconcilerId },
    Qualifier: '$LATEST',
    MaximumRetryAttempts: 2,
    MaximumEventAgeInSeconds: 120,
    DestinationConfig: {
      OnFailure: {
        Destination: {
          'Fn::GetAtt': [find('ReservationDeadLetterQueue'), 'Arn'],
        },
      },
    },
  });
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    ScheduleExpression: 'rate(1 minute)',
    FlexibleTimeWindow: { Mode: 'OFF' },
    State: 'ENABLED',
    Target: Match.objectLike({
      Arn: { 'Fn::GetAtt': [reconcilerId, 'Arn'] },
      RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 120 },
    }),
  });
  const expected: Record<string, [string[], string][]> = {
    CartExpiryWorkerRoleDefaultPolicy: [
      [
        ['logs:CreateLogStream', 'logs:PutLogEvents'],
        find('CartExpiryWorkerLogGroup'),
      ],
      [['dynamodb:GetItem', 'dynamodb:PutItem'], 'CatalogTableF8EA09BD'],
      [
        ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:ConditionCheckItem'],
        'CommerceTable6CC80189',
      ],
      [['dynamodb:GetItem', 'dynamodb:DeleteItem'], 'OperationsTable90528792'],
      [
        [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:SendMessage',
        ],
        'ReservationQueue43323CC1',
      ],
    ],
    CartExpiryReconcilerRoleDefaultPolicy: [
      [
        ['logs:CreateLogStream', 'logs:PutLogEvents'],
        find('CartExpiryReconcilerLogGroup'),
      ],
      [
        ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem'],
        'OperationsTable90528792',
      ],
      [['sqs:SendMessage'], 'ReservationQueue43323CC1'],
      [['sqs:SendMessage'], find('ReservationDeadLetterQueue')],
    ],
    CartExpiryRecoveryRoleDefaultPolicy: [
      [['lambda:InvokeFunction'], reconcilerId],
      [['sqs:SendMessage'], find('ReservationDeadLetterQueue')],
    ],
  };
  for (const [prefix, statements] of Object.entries(expected)) {
    assert.deepEqual(
      resources[find(prefix)].Properties.PolicyDocument.Statement,
      statements.map(([actions, id]) => ({
        Effect: 'Allow',
        Action: actions.length === 1 ? actions[0] : actions,
        Resource: { 'Fn::GetAtt': [id, 'Arn'] },
      })),
    );
  }
  const trust =
    resources[find('CartExpiryRecoveryRole')].Properties
      .AssumeRolePolicyDocument.Statement[0];
  assert.deepEqual(trust.Principal, { Service: 'scheduler.amazonaws.com' });
  assert.deepEqual(trust.Condition, {
    StringEquals: {
      'aws:SourceAccount': { Ref: 'AWS::AccountId' },
      'aws:SourceArn': { 'Fn::GetAtt': ['CartExpiryRecoveryGroup', 'Arn'] },
    },
  });
  for (const alarm of Object.values(
    template.findResources('AWS::CloudWatch::Alarm'),
  )) {
    assert.equal(alarm.Properties.AlarmActions, undefined);
    assert.equal(alarm.Properties.OKActions, undefined);
  }
  template.resourceCountIs('AWS::SNS::Topic', 0);
  template.resourceCountIs('AWS::SNS::Subscription', 0);
});
