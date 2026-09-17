import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DevelopmentStack } from '../lib/development-stack';
import { handler } from '../../backend/src/health';

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

test('one Node 24 Lambda is wired to the sole unauthenticated HTTP health route', () => {
  template.resourceCountIs('AWS::Lambda::Function', 1);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Handler: 'health.handler',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
  const functionId = Object.keys(
    template.findResources('AWS::Lambda::Function'),
  )[0];
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

test('Lambda can only write streams in its pre-created 14-day log group', () => {
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
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Action, [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
  ]);
  assert.equal(statements[0].Effect, 'Allow');
  const logId = Object.keys(template.findResources('AWS::Logs::LogGroup'))[0];
  assert.deepEqual(statements[0].Resource, { 'Fn::GetAtt': [logId, 'Arn'] });
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

test('health handler returns only service health JSON', async () => {
  const response = await handler();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(response.body), {
    status: 'ok',
    service: 'batch-and-batter-api',
  });
});
