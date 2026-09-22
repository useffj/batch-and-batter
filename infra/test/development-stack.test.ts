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

test('one Node 24 Lambda preserves its identity and serves exactly three read-only routes', () => {
  template.resourceCountIs('AWS::Lambda::Function', 1);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Handler: 'handler.handler',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 3);
  const functionId = Object.keys(
    template.findResources('AWS::Lambda::Function'),
  )[0];
  assert.equal(functionId, 'ApplicationApi5D63FF39');
  const routes = Object.values(
    template.findResources('AWS::ApiGatewayV2::Route'),
  );
  assert.deepEqual(
    routes.map((route) => route.Properties.RouteKey).sort(),
    ['GET /drops/current', 'GET /drops/{dropId}', 'GET /health'].sort(),
  );
  for (const route of routes)
    assert.equal(route.Properties.AuthorizationType, 'NONE');
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

test('admin pool disables signup and has no users, client or hosted domain', () => {
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.hasResourceProperties('AWS::Cognito::UserPool', {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  });
  for (const type of ['UserPoolUser', 'UserPoolClient', 'UserPoolDomain']) {
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
