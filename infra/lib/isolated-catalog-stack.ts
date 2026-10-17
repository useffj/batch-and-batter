import {
  Stack,
  CfnParameter,
  CfnOutput,
  RemovalPolicy,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_apigatewayv2 as gateway,
} from 'aws-cdk-lib';
import { mediaRoutes } from '../../backend/src/media-routes';
import type { Construct } from 'constructs';
import {
  isolatedRoutes,
  ISOLATED_TABLE,
} from '../../backend/src/isolated-catalog-contract';
// Separate stack: never added to DevelopmentStack or its ordinary deployment path.
export class IsolatedCatalogStack extends Stack {
  constructor(scope: Construct, id: string, media = false) {
    super(scope, id, { env: { account: '302154194958', region: 'us-east-2' } });
    new CfnParameter(this, 'InitializerRoleArn', {
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
      // Activation preserves the explicit deny and exempts only the existing
      // dedicated execution role. Its physical ARN was verified in DEV.
      resourcePolicy: {
        policyDocument: {
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
              Resource: tableArn,
              Condition: {
                ArnNotEquals: {
                  'aws:PrincipalArn':
                    'arn:aws:iam::302154194958:role/batch-and-batter-dev-isolated-c-CatalogRole0D3BB0F5-h0IDNrAPJlbX',
                },
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
      reservedConcurrentExecutions: 2,
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
    if (media) {
      const bucket = new s3.Bucket(this, 'IsolatedMediaBucket', {
        bucketName:
          'batch-and-batter-dev-isolated-media-302154194958-us-east-2',
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.RETAIN,
        cors: [
          {
            allowedOrigins: [
              'https://admin-dev-3b23b18.d1aw7cfglvejmo.amplifyapp.com',
            ],
            allowedMethods: [s3.HttpMethods.POST],
            allowedHeaders: ['content-type'],
            maxAge: 300,
          },
        ],
      });
      const processorKey = new CfnParameter(this, 'ProcessorArtifactKey', {
        type: 'String',
        allowedPattern: 'media-releases/[a-f0-9-]{36}/[a-f0-9]{64}\\.zip',
      });
      const processorVersion = new CfnParameter(
        this,
        'ProcessorArtifactVersion',
        {
          type: 'String',
          minLength: 1,
          maxLength: 1024,
          allowedPattern: '(?!null(?![\\s\\S]))[\\s\\S]+',
        },
      );
      const processorLogs = new logs.LogGroup(this, 'ProcessorLogs', {
        logGroupName:
          '/aws/lambda/batch-and-batter-dev-isolated-media-processor',
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const processorRole = new iam.Role(this, 'ProcessorRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [processorLogs.logGroupArn],
        }),
      );
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
          resources: [tableArn],
          conditions: {
            'ForAllValues:StringLike': {
              'dynamodb:LeadingKeys': [
                'PRODUCT#*',
                'PRODUCT_SLUG#*',
                'PRODUCT_INTEGRITY#V1',
                'PRODUCT_MEDIA#*',
                'PRODUCT_MEDIA_UPLOAD#*',
              ],
            },
            Null: { 'dynamodb:LeadingKeys': 'false' },
          },
        }),
      );
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [tableArn],
          conditions: {
            'ForAllValues:StringLike': {
              'dynamodb:LeadingKeys': [
                'PRODUCT_MEDIA#*',
                'PRODUCT_MEDIA_UPLOAD#*',
              ],
            },
            Null: { 'dynamodb:LeadingKeys': 'false' },
          },
        }),
      );
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [bucket.arnForObjects('staging/products/*')],
        }),
      );
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [bucket.arnForObjects('approved/products/*')],
          conditions: { StringEquals: { 's3:if-none-match': '*' } },
        }),
      );
      const processor = new lambda.CfnFunction(this, 'MediaProcessor', {
        functionName: 'batch-and-batter-dev-isolated-media-processor',
        role: processorRole.roleArn,
        runtime: 'nodejs24.x',
        handler: 'index.handler',
        architectures: ['x86_64'],
        memorySize: 1024,
        timeout: 30,
        ephemeralStorage: { size: 512 },
        reservedConcurrentExecutions: 2,
        code: {
          s3Bucket: 'cdk-hnb659fds-assets-302154194958-us-east-2',
          s3Key: processorKey.valueAsString,
          s3ObjectVersion: processorVersion.valueAsString,
        },
        environment: {
          variables: {
            CATALOG_TABLE_NAME: ISOLATED_TABLE,
            MEDIA_BUCKET_NAME: bucket.bucketName,
          },
        },
      });
      new lambda.CfnEventInvokeConfig(this, 'ProcessorRetries', {
        functionName: processor.ref,
        qualifier: '$LATEST',
        maximumEventAgeInSeconds: 900,
        maximumRetryAttempts: 2,
      });
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [bucket.arnForObjects('staging/products/*')],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [bucket.arnForObjects('approved/products/*')],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [processor.attrArn],
        }),
      );
      fn.addPropertyOverride('Environment.Variables.MEDIA_ENABLED', 'isolated');
      fn.addPropertyOverride(
        'Environment.Variables.MEDIA_BUCKET_NAME',
        bucket.bucketName,
      );
      fn.addPropertyOverride(
        'Environment.Variables.MEDIA_PROCESSOR_ARN',
        processor.attrArn,
      );
      table.addPropertyOverride(
        'ResourcePolicy.PolicyDocument.Statement.0.Condition.ArnNotEquals.aws:PrincipalArn',
        [
          'arn:aws:iam::302154194958:role/batch-and-batter-dev-isolated-c-CatalogRole0D3BB0F5-h0IDNrAPJlbX',
          processorRole.roleArn,
        ],
      );
    }

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
    [...isolatedRoutes, ...(media ? mediaRoutes : [])].forEach(
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
