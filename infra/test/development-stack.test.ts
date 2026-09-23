import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DevelopmentStack } from '../lib/development-stack';

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

test('one Node 24 Lambda preserves its identity and serves exactly four read-only routes', () => {
  template.resourceCountIs('AWS::Lambda::Function', 1);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Handler: 'handler.handler',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 4);
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
      'GET /admin/me',
      'GET /drops/current',
      'GET /drops/{dropId}',
      'GET /health',
    ].sort(),
  );
  for (const route of routes.filter(
    (route) => route.Properties.RouteKey !== 'GET /admin/me',
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

test('Lambda has only scoped logging and Catalog GetItem/Query permissions', () => {
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
    Action: ['dynamodb:GetItem', 'dynamodb:Query'],
    Resource: { 'Fn::GetAtt': [catalogId, 'Arn'] },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { CATALOG_TABLE_NAME: { Ref: catalogId } } },
  });
  // Exact statements exclude Commerce, Operations, SQS and any write grants.
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

test('only admin/me binds the JWT authorizer to the existing pool, client and HTTP API', () => {
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
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    ApiId: { Ref: apiId },
    RouteKey: 'GET /admin/me',
    AuthorizationType: 'JWT',
    AuthorizerId: { Ref: authorizerId },
  });
  // Keep Lambda invocation behind API Gateway, with no public function URL.
  template.resourceCountIs('AWS::Lambda::Url', 0);
});

test('existing pool, API, Lambda and table logical identities remain unchanged', () => {
  const expected = {
    CatalogTableF8EA09BD: 'AWS::DynamoDB::Table',
    CommerceTable6CC80189: 'AWS::DynamoDB::Table',
    OperationsTable90528792: 'AWS::DynamoDB::Table',
    AdminUserPoolD0AF18CF: 'AWS::Cognito::UserPool',
    ApplicationApi5D63FF39: 'AWS::Lambda::Function',
    HttpApiF5A9A8A7: 'AWS::ApiGatewayV2::Api',
  };
  for (const [id, type] of Object.entries(expected))
    assert.ok(
      template.findResources(type)[id],
      `Missing original resource ${id}`,
    );
});
