import * as path from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
  aws_apigatewayv2 as apigateway,
  aws_apigatewayv2_integrations as integrations,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface DevelopmentStackProps extends StackProps {
  environment: string;
}

export class DevelopmentStack extends Stack {
  constructor(scope: Construct, id: string, props: DevelopmentStackProps) {
    super(scope, id, props);
    if (props.environment !== 'dev') {
      throw new Error(
        'Only dev is supported; review protective settings before adding environments.',
      );
    }
    const prefix = `batch-and-batter-${props.environment}`;
    Tags.of(this).add('Project', 'batch-and-batter');
    Tags.of(this).add('Environment', props.environment);

    for (const name of ['Catalog', 'Commerce', 'Operations']) {
      const table = new dynamodb.Table(this, `${name}Table`, {
        tableName: `${prefix}-${name.toLowerCase()}`,
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.DEFAULT,
        deletionProtection: false,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      new CfnOutput(this, `${name}TableName`, { value: table.tableName });
    }

    for (const name of ['Reservation', 'Notification']) {
      const deadLetterQueue = new sqs.Queue(this, `${name}DeadLetterQueue`, {
        queueName: `${prefix}-${name.toLowerCase()}-dlq`,
        fifo: false,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        retentionPeriod: Duration.days(14),
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const queue = new sqs.Queue(this, `${name}Queue`, {
        queueName: `${prefix}-${name.toLowerCase()}`,
        fifo: false,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        deliveryDelay: Duration.seconds(0),
        visibilityTimeout: Duration.seconds(30),
        retentionPeriod: Duration.days(4),
        deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 },
        removalPolicy: RemovalPolicy.DESTROY,
      });
      new CfnOutput(this, `${name}QueueName`, { value: queue.queueName });
      new CfnOutput(this, `${name}DeadLetterQueueName`, {
        value: deadLetterQueue.queueName,
      });
    }

    const adminPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: `${prefix}-admins`,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new CfnOutput(this, 'AdminUserPoolId', { value: adminPool.userPoolId });

    const media = new s3.Bucket(this, 'ProductMediaBucket', {
      // Account/Region tokens keep this globally unique without fixed account data.
      bucketName: `${prefix}-product-media-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });
    new CfnOutput(this, 'ProductMediaBucketName', { value: media.bucketName });

    const logGroup = new logs.LogGroup(this, 'ApplicationLogGroup', {
      logGroupName: `/aws/lambda/${prefix}-api`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, 'ApplicationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );
    const application = new lambda.Function(this, 'ApplicationApi', {
      functionName: `${prefix}-api`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'health.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/src')),
      role,
      logGroup,
      timeout: Duration.seconds(5),
      memorySize: 128,
    });
    const api = new apigateway.HttpApi(this, 'HttpApi', {
      apiName: `${prefix}-http-api`,
    });
    api.addRoutes({
      path: '/health',
      methods: [apigateway.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'HealthIntegration',
        application,
      ),
    });
    new CfnOutput(this, 'HttpApiEndpoint', { value: api.apiEndpoint });
  }
}
