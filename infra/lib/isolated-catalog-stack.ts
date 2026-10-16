import {
  Stack,
  CfnParameter,
  CfnOutput,
  RemovalPolicy,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_apigatewayv2 as gateway,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  isolatedRoutes,
  ISOLATED_TABLE,
} from '../../backend/src/isolated-catalog-contract';
// Separate stack: never added to DevelopmentStack or its ordinary deployment path.
export class IsolatedCatalogStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, { env: { account: '302154194958', region: 'us-east-2' } });
    const initializer = new CfnParameter(this, 'InitializerRoleArn', {
      type: 'String',
      allowedPattern: 'arn:aws:iam::302154194958:role/[A-Za-z0-9+=,.@_/-]+',
      description:
        'Separately approved exclusive initializer role. No grants are created for it.',
    });
    const key = new CfnParameter(this, 'ArtifactKey', {
      type: 'String',
      allowedPattern: 'api-releases/[a-f0-9-]{36}/[a-f0-9]{64}\\.zip',
    });
    const version = new CfnParameter(this, 'ArtifactVersion', {
      type: 'String',
      minLength: 1,
      maxLength: 1024,
      // CloudFormation length is character-based. The existing publisher's
      // isolatedArtifactParameters must enforce the 1024 UTF-8 byte limit
      // before submission; do not normalize this opaque exact-version value.
      allowedPattern: '(?!null(?![\\s\\S]))[\\s\\S]+',
    });
    const tableArn = `arn:aws:dynamodb:us-east-2:302154194958:table/${ISOLATED_TABLE}`;
    const table = new dynamodb.CfnTable(this, 'Catalog', {
      tableName: ISOLATED_TABLE,
      billingMode: 'PAY_PER_REQUEST',
      attributeDefinitions: [
        { attributeName: 'PK', attributeType: 'S' },
        { attributeName: 'SK', attributeType: 'S' },
      ],
      keySchema: [
        { attributeName: 'PK', keyType: 'HASH' },
        { attributeName: 'SK', keyType: 'RANGE' },
      ],
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      sseSpecification: { sseEnabled: true },
      deletionProtectionEnabled: true,
      // Initial deployment is quarantined. Removal of this deny requires a
      // separately reviewed post-initialization template update, never an env flag.
      resourcePolicy: {
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'ExclusiveInitialization',
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
              Resource: tableArn,
              Condition: {
                ArnNotEquals: { 'aws:PrincipalArn': initializer.valueAsString },
              },
            },
          ],
        },
      },
    });
    table.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const group = new logs.LogGroup(this, 'Logs', {
      logGroupName: '/aws/lambda/batch-and-batter-dev-isolated-catalog',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const role = new iam.Role(this, 'CatalogRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [tableArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [group.logGroupArn],
      }),
    );
    const fn = new lambda.CfnFunction(this, 'CatalogApi', {
      functionName: 'batch-and-batter-dev-isolated-catalog',
      role: role.roleArn,
      runtime: 'nodejs24.x',
      handler: 'handler.handler',
      architectures: ['x86_64'],
      memorySize: 512,
      timeout: 30,
      reservedConcurrentExecutions: 0,
      code: {
        s3Bucket: 'cdk-hnb659fds-assets-302154194958-us-east-2',
        s3Key: key.valueAsString,
        s3ObjectVersion: version.valueAsString,
      },
      environment: {
        variables: {
          CATALOG_TABLE_NAME: ISOLATED_TABLE,
          PAYMENT_START_ENABLED: 'false',
        },
      },
    });
    fn.addDependency(table);
    const api = new gateway.CfnApi(this, 'Api', {
      name: 'batch-and-batter-dev-isolated-catalog',
      protocolType: 'HTTP',
    });
    const auth = new gateway.CfnAuthorizer(this, 'AdminAuthorizer', {
      apiId: api.ref,
      name: 'existing-cognito-admin',
      authorizerType: 'JWT',
      identitySource: ['$request.header.Authorization'],
      jwtConfiguration: {
        audience: ['mnvhvb6s87q5hsscdmjj59pv'],
        issuer:
          'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_KuxDBXnZn',
      },
    });
    const integration = new gateway.CfnIntegration(this, 'Integration', {
      apiId: api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: fn.attrArn,
      payloadFormatVersion: '2.0',
    });
    isolatedRoutes.forEach(
      (routeKey, n) =>
        new gateway.CfnRoute(this, `Route${n}`, {
          apiId: api.ref,
          routeKey,
          authorizationType: 'JWT',
          authorizerId: auth.ref,
          target: `integrations/${integration.ref}`,
        }),
    );
    new gateway.CfnStage(this, 'Stage', {
      apiId: api.ref,
      stageName: '$default',
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit: 10,
        throttlingRateLimit: 5,
      },
    });
    new lambda.CfnPermission(this, 'GatewayInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: fn.ref,
      principal: 'apigateway.amazonaws.com',
      sourceArn: `arn:aws:execute-api:us-east-2:302154194958:${api.ref}/*/*/admin/*`,
      sourceAccount: '302154194958',
    });
    new CfnOutput(this, 'AdminApiBaseUrl', { value: api.attrApiEndpoint });
    new CfnOutput(this, 'CatalogTableName', { value: table.ref });
  }
}
