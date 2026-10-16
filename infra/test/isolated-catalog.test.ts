import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { IsolatedCatalogStack } from '../lib/isolated-catalog-stack';
import { isolatedRoutes } from '../../backend/src/isolated-catalog-contract';
test('isolated stack has only catalog resources, exclusive catalog writes and authenticated routes', () => {
  const t = Template.fromStack(new IsolatedCatalogStack(new App(), 'isolated'));
  t.resourceCountIs('AWS::DynamoDB::Table', 1);
  t.resourceCountIs('AWS::Lambda::Function', 1);
  t.resourceCountIs('AWS::ApiGatewayV2::Route', 11);
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'batch-and-batter-dev-isolated-catalog',
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    DeletionProtectionEnabled: true,
  });
  t.hasResourceProperties('AWS::Lambda::Function', {
    ReservedConcurrentExecutions: 2,
    Environment: {
      Variables: {
        CATALOG_TABLE_NAME: 'batch-and-batter-dev-isolated-catalog',
        PAYMENT_START_ENABLED: 'false',
      },
    },
  });
  assert.deepEqual(t.toJSON().Resources.Catalog.Properties.ResourcePolicy, {
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ExclusiveCatalogWriter',
          Effect: 'Deny',
          Principal: '*',
          Action: [
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:BatchWriteItem',
            'dynamodb:PartiQLInsert',
            'dynamodb:PartiQLUpdate',
            'dynamodb:PartiQLDelete',
          ],
          Resource:
            'arn:aws:dynamodb:us-east-2:302154194958:table/batch-and-batter-dev-isolated-catalog',
          Condition: {
            ArnNotEquals: {
              'aws:PrincipalArn':
                'arn:aws:iam::302154194958:role/batch-and-batter-dev-isolated-c-CatalogRole0D3BB0F5-h0IDNrAPJlbX',
            },
          },
        },
      ],
    },
  });
  const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map(
    (r) => r.Properties,
  );
  assert.deepEqual(
    routes.map((r) => r.RouteKey).sort(),
    [...isolatedRoutes].sort(),
  );
  assert.ok(routes.every((r) => r.AuthorizationType === 'JWT'));
  const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  assert.ok(
    !/commerce|operations|sqs:|s3:|ssm:|scheduler:|stripe/i.test(policies),
  );
  const resources = t.toJSON().Resources;
  assert.ok(
    Object.values(resources).every((r: any) =>
      [
        'AWS::DynamoDB::Table',
        'AWS::Logs::LogGroup',
        'AWS::IAM::Role',
        'AWS::IAM::Policy',
        'AWS::Lambda::Function',
        'AWS::Lambda::Permission',
        'AWS::ApiGatewayV2::Api',
        'AWS::ApiGatewayV2::Authorizer',
        'AWS::ApiGatewayV2::Integration',
        'AWS::ApiGatewayV2::Route',
        'AWS::ApiGatewayV2::Stage',
      ].includes(r.Type),
    ),
  );
});

test('CloudFormation exact-version reference accepts opaque Unicode without normalization', () => {
  const json = Template.fromStack(
    new IsolatedCatalogStack(new App(), 'opaque'),
  ).toJSON();
  const p = json.Parameters.ArtifactVersion;
  assert.equal(p.MinLength, 1);
  assert.equal(p.MaxLength, 1024);
  const pattern = new RegExp('^(?:' + p.AllowedPattern + ')$');
  for (const value of [
    ' _+/=.%:Version ID ',
    'null\n',
    '版本-🍪-e\u0301',
    '🍪'.repeat(256),
    'x'.repeat(1024),
  ])
    assert.ok(pattern.test(value));
  for (const value of ['', 'null']) assert.equal(pattern.test(value), false);
  assert.deepEqual(json.Resources.CatalogApi.Properties.Code.S3ObjectVersion, {
    Ref: 'ArtifactVersion',
  });
});
