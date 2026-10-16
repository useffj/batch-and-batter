import { addPayments } from './payments';
import { addCartExpiry } from './cart-expiry';
import { artifactCode } from './artifacts';
import {
  CfnOutput,
  CfnParameter,
  ArnFormat,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
  aws_apigatewayv2 as apigateway,
  aws_apigatewayv2_integrations as integrations,
  aws_apigatewayv2_authorizers as authorizers,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_sqs as sqs,
  aws_scheduler as scheduler,
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
    const applicationArn = this.formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: `${prefix}-api`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const scheduleGroup = new scheduler.CfnScheduleGroup(
      this,
      'OpeningScheduleGroup',
      { name: `${prefix}-openings` },
    );
    const schedulerRole = new iam.Role(this, 'OpeningSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
            'aws:SourceArn': scheduleGroup.attrArn,
          },
        },
      }),
    });
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [applicationArn],
      }),
    );
    Tags.of(this).add('Project', 'batch-and-batter');
    Tags.of(this).add('Environment', props.environment);

    let catalogTable: dynamodb.Table | undefined;
    let commerceTable: dynamodb.Table | undefined;
    let operationsTable: dynamodb.Table | undefined;
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
      if (name === 'Catalog') catalogTable = table;
      if (name === 'Commerce') {
        commerceTable = table;
        for (const index of ['GSI1', 'GSI2'])
          table.addGlobalSecondaryIndex({
            indexName: index,
            partitionKey: {
              name: index + 'PK',
              type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
              name: index + 'SK',
              type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.INCLUDE,
            nonKeyAttributes: ['orderId', 'status', 'dropId'],
          });
      }
      if (name === 'Operations') operationsTable = table;
      new CfnOutput(this, `${name}TableName`, { value: table.tableName });
    }

    let reservationQueue: sqs.Queue | undefined;
    let reservationDlq: sqs.Queue | undefined;
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
        visibilityTimeout: Duration.seconds(name === 'Reservation' ? 60 : 30),
        retentionPeriod: Duration.days(4),
        deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 },
        removalPolicy: RemovalPolicy.DESTROY,
      });
      if (name === 'Reservation') {
        reservationQueue = queue;
        reservationDlq = deadLetterQueue;
      }
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
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: adminPool.userPoolId,
      groupName: 'batch-and-batter-admins',
    });
    new CfnOutput(this, 'AdminGroupName', { value: adminGroup.ref });
    const adminClient = adminPool.addClient('AdminAppClient', {
      userPoolClientName: `${prefix}-admin-client`,
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      // CDK includes ALLOW_REFRESH_TOKEN_AUTH when rotation is disabled.
      disableOAuth: true,
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(1),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });
    new CfnOutput(this, 'AdminAppClientId', {
      value: adminClient.userPoolClientId,
    });

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
        actions: ['scheduler:CreateSchedule', 'scheduler:GetSchedule'],
        resources: [
          this.formatArn({
            service: 'scheduler',
            resource: 'schedule',
            resourceName: `${prefix}-openings/open-*`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );
    if (!catalogTable || !commerceTable || !operationsTable)
      throw new Error('Application tables are required');
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [catalogTable.tableArn],
      }),
    );
    for (const table of [commerceTable, operationsTable]) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            ...(table === commerceTable ? ['dynamodb:ConditionCheckItem'] : []),
          ],
          resources: [table.tableArn],
        }),
      );
    }
    if (!reservationQueue || !reservationDlq)
      throw new Error('Reservation queues required');
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:DeleteItem'],
        resources: [operationsTable.tableArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [reservationQueue.queueArn],
      }),
    );
    const guestOrigin = new CfnParameter(this, 'GuestOrderOrigin', {
      type: 'String',
      default: '',
      allowedPattern: '^$|^https://[A-Za-z0-9.-]+(?::[0-9]+)?$',
      description:
        'Approved customer order-link origin; empty keeps guest access unavailable.',
    });
    const cancellationHours = new CfnParameter(this, 'GuestCancellationHours', {
      type: 'Number',
      default: 24,
      minValue: 1,
      maxValue: 168,
      description:
        'Cancellation deadline in elapsed hours before confirmed Denver pickup start.',
    });
    const guestCutoff = new CfnParameter(this, 'GuestPickupCutoff', {
      type: 'String',
      default: '15:00',
      allowedPattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
      description: 'Denver-local day-before pickup-change cutoff.',
    });
    const application = new lambda.Function(this, 'ApplicationApi', {
      functionName: `${prefix}-api`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler.handler',
      code: artifactCode(this, 'ApplicationApi5D63FF39', 'handler.handler'),
      environment: {
        GUEST_CANCELLATION_HOURS: cancellationHours.valueAsString,
        GUEST_ORDER_ORIGIN: guestOrigin.valueAsString,
        GUEST_PICKUP_CUTOFF: guestCutoff.valueAsString,
        RESERVATION_QUEUE_URL: reservationQueue.queueUrl,
        CATALOG_TABLE_NAME: catalogTable.tableName,
        COMMERCE_TABLE_NAME: commerceTable.tableName,
        OPERATIONS_TABLE_NAME: operationsTable.tableName,
        OPEN_SCHEDULE_GROUP: scheduleGroup.ref,
        OPEN_TARGET_ARN: applicationArn,
        OPEN_SCHEDULE_ROLE_ARN: schedulerRole.roleArn,
      },
      role,
      logGroup,
      timeout: Duration.seconds(15),
      memorySize: 256,
    });
    application.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: Duration.minutes(15),
    });
    const api = new apigateway.HttpApi(this, 'HttpApi', {
      apiName: `${prefix}-http-api`,
    });
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      logGroupName: `/aws/vendedlogs/apigateway/${prefix}-http-api`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Configure the existing default stage without changing its construct identity.
    const stage = api.defaultStage!.node.defaultChild as apigateway.CfnStage;
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
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
      }),
    };
    api.addRoutes({
      path: '/health',
      methods: [apigateway.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'HealthIntegration',
        application,
      ),
    });
    for (const [route, integrationId] of [
      ['/drops/current', 'CurrentDropIntegration'],
      ['/drops/{dropId}', 'DropIntegration'],
    ]) {
      api.addRoutes({
        path: route,
        methods: [apigateway.HttpMethod.GET],
        integration: new integrations.HttpLambdaIntegration(
          integrationId,
          application,
        ),
      });
    }
    for (const [route, method, integrationId] of [
      [
        '/orders/manage/request',
        apigateway.HttpMethod.POST,
        'GuestCancellationRequestIntegration',
      ],
      [
        '/orders/manage/view',
        apigateway.HttpMethod.POST,
        'GuestOrderViewIntegration',
      ],
      [
        '/orders/manage/pickup',
        apigateway.HttpMethod.POST,
        'GuestOrderPickupIntegration',
      ],
      ['/carts', apigateway.HttpMethod.POST, 'CreateCartIntegration'],
      ['/carts/{cartId}', apigateway.HttpMethod.GET, 'GetCartIntegration'],
      [
        '/carts/{cartId}/items',
        apigateway.HttpMethod.PUT,
        'ReplaceCartIntegration',
      ],
      [
        '/carts/{cartId}',
        apigateway.HttpMethod.DELETE,
        'ReleaseCartIntegration',
      ],
    ] as const) {
      api.addRoutes({
        path: route,
        methods: [method],
        integration: new integrations.HttpLambdaIntegration(
          integrationId,
          application,
        ),
      });
    }
    const adminAuthorizer = new authorizers.HttpJwtAuthorizer(
      'AdminJwtAuthorizer',
      adminPool.userPoolProviderUrl,
      {
        jwtAudience: [adminClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      },
    );
    api.addRoutes({
      path: '/admin/me',
      methods: [apigateway.HttpMethod.GET],
      authorizer: adminAuthorizer,
      integration: new integrations.HttpLambdaIntegration(
        'AdminMeIntegration',
        application,
      ),
    });
    for (const [route, method, integrationId] of [
      [
        '/admin/storefront/assignment',
        apigateway.HttpMethod.GET,
        'AdminStorefrontAssignmentIntegration',
      ],
      [
        '/admin/drops/{dropId}',
        apigateway.HttpMethod.PATCH,
        'AdminEditScheduledDropIntegration',
      ],
      [
        '/admin/drops/{dropId}/cancel',
        apigateway.HttpMethod.POST,
        'AdminCancelScheduledDropIntegration',
      ],
      [
        '/admin/products/{productId}/media',
        apigateway.HttpMethod.GET,
        'AdminMediaReadIntegration',
      ],
      [
        '/admin/products/{productId}/media',
        apigateway.HttpMethod.PUT,
        'AdminMediaWriteIntegration',
      ],
      [
        '/admin/products/{productId}/media/uploads',
        apigateway.HttpMethod.POST,
        'AdminMediaUploadIntegration',
      ],
      [
        '/admin/products/{productId}/media/uploads/{uploadId}',
        apigateway.HttpMethod.GET,
        'AdminMediaStatusIntegration',
      ],
      [
        '/admin/products/{productId}/media/uploads/{uploadId}/complete',
        apigateway.HttpMethod.POST,
        'AdminMediaRequestProcessingIntegration',
      ],
      [
        '/admin/products/{productId}/media/assets/{mediaId}',
        apigateway.HttpMethod.GET,
        'AdminMediaAssetIntegration',
      ],
      ['/admin/products', apigateway.HttpMethod.GET, 'AdminCatalogIntegration'],
      [
        '/admin/products/{productId}',
        apigateway.HttpMethod.GET,
        'AdminGetProductIntegration',
      ],
      [
        '/admin/products',
        apigateway.HttpMethod.POST,
        'AdminCreateProductIntegration',
      ],
      [
        '/admin/products/{productId}',
        apigateway.HttpMethod.PUT,
        'AdminReplaceProductIntegration',
      ],
      [
        '/admin/fulfillment',
        apigateway.HttpMethod.GET,
        'AdminFulfillmentIntegration',
      ],
      [
        '/admin/orders/{orderId}/fulfillment',
        apigateway.HttpMethod.POST,
        'AdminFulfillmentWriteIntegration',
      ],
      [
        '/admin/customers/search',
        apigateway.HttpMethod.POST,
        'AdminCustomerSearchIntegration',
      ],
      [
        '/admin/customers/history',
        apigateway.HttpMethod.POST,
        'AdminCustomerHistoryIntegration',
      ],
      [
        '/admin/orders/{orderId}/notifications',
        apigateway.HttpMethod.GET,
        'AdminNotificationsIntegration',
      ],
      [
        '/admin/orders/{orderId}/requests',
        apigateway.HttpMethod.GET,
        'AdminCancellationRequestIntegration',
      ],
      [
        '/admin/orders/{orderId}/requests/review',
        apigateway.HttpMethod.POST,
        'AdminCancellationReviewIntegration',
      ],
      [
        '/admin/orders/{orderId}/access',
        apigateway.HttpMethod.GET,
        'AdminGuestAccessIntegration',
      ],
      [
        '/admin/orders/{orderId}/access/reissue',
        apigateway.HttpMethod.POST,
        'AdminGuestReissueIntegration',
      ],
      [
        '/admin/orders/{orderId}/access/revoke',
        apigateway.HttpMethod.POST,
        'AdminGuestRevokeIntegration',
      ],
      [
        '/admin/refund-worklist',
        apigateway.HttpMethod.GET,
        'AdminRefundWorklistIntegration',
      ],
      ['/admin/orders', apigateway.HttpMethod.GET, 'AdminOrdersIntegration'],
      [
        '/admin/orders/{orderId}',
        apigateway.HttpMethod.GET,
        'AdminOrderDetailsIntegration',
      ],
      ['/admin/drops', apigateway.HttpMethod.GET, 'AdminListDropsIntegration'],
      [
        '/admin/drops/{dropId}/draft',
        apigateway.HttpMethod.PUT,
        'AdminSaveWeeklyDraftIntegration',
      ],
      [
        '/admin/drops',
        apigateway.HttpMethod.POST,
        'AdminCreateDropIntegration',
      ],
      [
        '/admin/drops/{dropId}',
        apigateway.HttpMethod.PUT,
        'AdminReplaceDropIntegration',
      ],
      [
        '/admin/drops/{dropId}/composition',
        apigateway.HttpMethod.GET,
        'AdminCompositionIntegration',
      ],
      [
        '/admin/drops/{dropId}/products',
        apigateway.HttpMethod.POST,
        'AdminAttachDropProductIntegration',
      ],
      [
        '/admin/drops/{dropId}/products/{productId}',
        apigateway.HttpMethod.PUT,
        'AdminReplaceDropProductIntegration',
      ],
      [
        '/admin/drops/{dropId}/products/{productId}',
        apigateway.HttpMethod.DELETE,
        'AdminRemoveDropProductIntegration',
      ],
      [
        '/admin/drops/{dropId}/pickups/{date}',
        apigateway.HttpMethod.PUT,
        'AdminPutPickupIntegration',
      ],
      [
        '/admin/drops/{dropId}/pickups/{date}',
        apigateway.HttpMethod.DELETE,
        'AdminRemovePickupIntegration',
      ],
      [
        '/admin/drops/{dropId}/publish',
        apigateway.HttpMethod.POST,
        'AdminPublishDropIntegration',
      ],
      [
        '/admin/drops/{dropId}/open',
        apigateway.HttpMethod.POST,
        'AdminOpenDropIntegration',
      ],
      [
        '/admin/drops/{dropId}/pause',
        apigateway.HttpMethod.POST,
        'AdminPauseDropIntegration',
      ],
      [
        '/admin/drops/{dropId}/resume',
        apigateway.HttpMethod.POST,
        'AdminResumeDropIntegration',
      ],
      [
        '/admin/drops/{dropId}/close',
        apigateway.HttpMethod.POST,
        'AdminCloseDropIntegration',
      ],
      [
        '/admin/drops/{dropId}/reconcile-opening',
        apigateway.HttpMethod.POST,
        'AdminReconcileOpeningIntegration',
      ],
    ] as const) {
      api.addRoutes({
        path: route,
        methods: [method],
        authorizer: adminAuthorizer,
        integration: new integrations.HttpLambdaIntegration(
          integrationId,
          application,
        ),
      });
    }
    const recovery = addCartExpiry(
      this,
      prefix,
      catalogTable,
      commerceTable,
      operationsTable,
      reservationQueue,
      reservationDlq,
    );
    addPayments(
      this,
      prefix,
      application,
      role,
      api,
      catalogTable,
      commerceTable,
      operationsTable,
      recovery,
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [
          operationsTable.tableArn,
          commerceTable.tableArn,
          `${commerceTable.tableArn}/index/GSI1`,
          `${commerceTable.tableArn}/index/GSI2`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [operationsTable.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['GUEST_RATE#*'],
          },
        },
      }),
    );
    new CfnOutput(this, 'HttpApiEndpoint', { value: api.apiEndpoint });
  }
}
