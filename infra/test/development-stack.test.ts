import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DevelopmentStack } from '../lib/development-stack';

const compositionRoutes = [
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

test('one Node 24 Lambda preserves its identity and serves exactly the fifteen approved routes', () => {
  template.resourceCountIs('AWS::Lambda::Function', 1);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Handler: 'handler.handler',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 15);
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
      VisibilityTimeout: 30,
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
  template.resourceCountIs('AWS::Logs::LogGroup', 1);
  template.hasResourceProperties('AWS::Logs::LogGroup', {
    RetentionInDays: 14,
  });
  template.resourceCountIs('AWS::IAM::Role', 1);
  template.hasResourceProperties('AWS::IAM::Role', {
    ManagedPolicyArns: Match.absent(),
  });
  template.resourceCountIs('AWS::IAM::Policy', 1);
  const policies = template.findResources('AWS::IAM::Policy');
  const statements =
    Object.values(policies)[0].Properties.PolicyDocument.Statement;
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0].Action, [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
  ]);
  assert.equal(statements[0].Effect, 'Allow');
  const logId = Object.keys(template.findResources('AWS::Logs::LogGroup'))[0];
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
  // Exact statements exclude Commerce, Operations, SQS and all other service permissions.
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
  template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  template.resourceCountIs('AWS::Scheduler::Schedule', 0);
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

test('all twelve admin routes bind the JWT authorizer to the existing pool, client and HTTP API', () => {
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
  template.resourceCountIs('AWS::ApiGatewayV2::Integration', 15);
  template.resourceCountIs('AWS::Lambda::Permission', 15);
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

test('publication adds only one route/integration/permission and changes only Lambda code', () => {
  const baseline = JSON.parse(
    readFileSync(
      join(__dirname, '../../../test/fixtures/phase-4b2b1-resources.json'),
      'utf8',
    ),
  );
  const current = template.toJSON().Resources;
  for (const [id, expected] of Object.entries(baseline)) {
    assert.ok(current[id], `Existing resource removed: ${id}`);
    const { Metadata: _metadata, ...actual } = current[id];
    if (id === 'ApplicationApi5D63FF39') {
      const prior = structuredClone(expected) as typeof actual;
      assert.ok(actual.Properties.Code.S3Key);
      prior.Properties.Code = actual.Properties.Code;
      assert.deepEqual(actual, prior, 'Lambda changed beyond code');
    } else
      assert.deepEqual(actual, expected, `Unrelated resource changed: ${id}`);
  }
  const added = Object.entries(current)
    .filter(([id]) => !(id in baseline))
    .map(([, resource]) => (resource as { Type: string }).Type);
  assert.deepEqual(
    added.sort(),
    [
      ...Array(1).fill('AWS::ApiGatewayV2::Route'),
      ...Array(1).fill('AWS::ApiGatewayV2::Integration'),
      ...Array(1).fill('AWS::Lambda::Permission'),
    ].sort(),
  );
});
