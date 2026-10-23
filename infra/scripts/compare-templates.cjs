const fs = require('node:fs');
const assert = require('node:assert/strict');
const API = 'ApplicationApi5D63FF39';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
// Fixed reviewed contract: never derive permissions from caller-supplied synthesis.
const SHARED_ROUTES = [
  [
    'GET /admin/products',
    'HttpApiGETadminproductsF96C398C',
    'HttpApiGETadminproductsAdminCatalogIntegrationEB82D66E',
    'HttpApiGETadminproductsAdminCatalogIntegrationPermission019DC0D5',
    'GET--admin--products',
    'AdminCatalogIntegration',
  ],
  [
    'GET /admin/products/{productId}',
    'HttpApiGETadminproductsproductIdCF6151D2',
    'HttpApiGETadminproductsproductIdAdminGetProductIntegration73A28469',
    'HttpApiGETadminproductsproductIdAdminGetProductIntegrationPermissionF096BCBB',
    'GET--admin--products--{productId}',
    'AdminGetProductIntegration',
  ],
  [
    'GET /admin/drops',
    'HttpApiGETadmindrops49B1B593',
    'HttpApiGETadmindropsAdminListDropsIntegrationBF8996E1',
    'HttpApiGETadmindropsAdminListDropsIntegrationPermission1DF66F9F',
    'GET--admin--drops',
    'AdminListDropsIntegration',
  ],
  [
    'PUT /admin/drops/{dropId}/draft',
    'HttpApiPUTadmindropsdropIddraft8F8B95AB',
    'HttpApiPUTadmindropsdropIddraftAdminSaveWeeklyDraftIntegrationBFCE0AB9',
    'HttpApiPUTadmindropsdropIddraftAdminSaveWeeklyDraftIntegrationPermission84F4C6F0',
    'PUT--admin--drops--{dropId}--draft',
    'AdminSaveWeeklyDraftIntegration',
  ],
];
function sharedCommerceResources() {
  const resources = {};
  for (const [
    key,
    routeId,
    integrationId,
    permissionId,
    segment,
    name,
  ] of SHARED_ROUTES) {
    const api = { Ref: 'HttpApiF5A9A8A7' };
    const lambda = { 'Fn::GetAtt': [API, 'Arn'] };
    const prefix = `batch-and-batter-dev/HttpApi/${segment}`;
    resources[integrationId] = {
      Type: 'AWS::ApiGatewayV2::Integration',
      Properties: {
        ApiId: api,
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: lambda,
        PayloadFormatVersion: '2.0',
      },
      Metadata: { 'aws:cdk:path': `${prefix}/${name}/Resource` },
    };
    resources[permissionId] = {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        Action: 'lambda:InvokeFunction',
        FunctionName: lambda,
        Principal: 'apigateway.amazonaws.com',
        SourceArn: {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':execute-api:us-east-2:302154194958:',
              api,
              `/*/*${key.split(' ')[1]}`,
            ],
          ],
        },
      },
      Metadata: { 'aws:cdk:path': `${prefix}/${name}-Permission` },
    };
    resources[routeId] = {
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        ApiId: api,
        AuthorizationType: 'JWT',
        AuthorizerId: { Ref: 'HttpApiAdminJwtAuthorizerA698361D' },
        RouteKey: key,
        Target: { 'Fn::Join': ['', ['integrations/', { Ref: integrationId }]] },
      },
      Metadata: { 'aws:cdk:path': `${prefix}/Resource` },
    };
  }
  return resources;
}
function applySharedCommerceDelta(baseline) {
  const proposed = structuredClone(baseline);
  const resources = proposed.Resources;
  for (const [id, type] of [
    ['HttpApiF5A9A8A7', 'AWS::ApiGatewayV2::Api'],
    ['HttpApiAdminJwtAuthorizerA698361D', 'AWS::ApiGatewayV2::Authorizer'],
    ['CatalogTableF8EA09BD', 'AWS::DynamoDB::Table'],
    ['ApplicationRole90C00724', 'AWS::IAM::Role'],
  ])
    assert.equal(
      resources?.[id]?.Type,
      type,
      'SHARED_BASELINE_IDENTITY_CHANGED',
    );
  for (const [id, resource] of Object.entries(sharedCommerceResources())) {
    assert.ok(!Object.hasOwn(resources, id), 'SHARED_RESOURCE_ALREADY_EXISTS');
    resources[id] = resource;
  }
  const policy = resources.ApplicationRoleDefaultPolicy2A2BCE7E;
  assert.equal(policy?.Type, 'AWS::IAM::Policy');
  assert.deepStrictEqual(policy.Properties.Roles, [
    { Ref: 'ApplicationRole90C00724' },
  ]);
  const statements = policy.Properties.PolicyDocument.Statement;
  const catalog = statements.filter(
    (s) =>
      JSON.stringify(canonical(s.Resource)) ===
      JSON.stringify(
        canonical({ 'Fn::GetAtt': ['CatalogTableF8EA09BD', 'Arn'] }),
      ),
  );
  assert.equal(catalog.length, 1, 'CATALOG_POLICY_SHAPE_CHANGED');
  assert.deepStrictEqual(
    catalog[0],
    {
      Action: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        'dynamodb:ConditionCheckItem',
      ],
      Effect: 'Allow',
      Resource: { 'Fn::GetAtt': ['CatalogTableF8EA09BD', 'Arn'] },
    },
    'CATALOG_POLICY_SHAPE_CHANGED',
  );
  catalog[0].Action.splice(2, 0, 'dynamodb:Scan');
  return proposed;
}
function assertMode(mode) {
  if (!['api-code-only', 'shared-commerce'].includes(mode))
    throw Error('INVALID_RELEASE_MODE');
}

function compareTemplates(
  baseline,
  candidate,
  approvedApiCode,
  mode = 'api-code-only',
) {
  assertMode(mode);
  if (
    !baseline?.Resources ||
    !candidate?.Resources ||
    !baseline.Resources[API] ||
    !candidate.Resources[API]
  )
    throw Error('INVALID_TEMPLATE');
  const expected =
    mode === 'shared-commerce'
      ? applySharedCommerceDelta(baseline)
      : structuredClone(baseline);
  if (approvedApiCode !== undefined) {
    if (
      !approvedApiCode ||
      !Object.hasOwn(approvedApiCode, 'S3Bucket') ||
      !Object.hasOwn(approvedApiCode, 'S3Key') ||
      Object.keys(approvedApiCode).some(
        (k) => !['S3Bucket', 'S3Key', 'S3ObjectVersion'].includes(k),
      )
    )
      throw Error('INVALID_APPROVED_API_CODE');
    expected.Resources[API].Properties.Code = approvedApiCode;
  }
  assert.deepStrictEqual(
    canonical(candidate),
    canonical(expected),
    'UNAPPROVED_TEMPLATE_CHANGE',
  );
  return true;
}
module.exports = {
  compareTemplates,
  applySharedCommerceDelta,
  sharedCommerceResources,
  assertMode,
};
if (require.main === module) {
  try {
    if (![4, 5].includes(process.argv.length))
      throw Error(
        'Usage: compare-templates baseline.json candidate.json [approved-api-code.json]',
      );
    const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
    compareTemplates(
      read(process.argv[2]),
      read(process.argv[3]),
      process.argv[4] ? read(process.argv[4]) : undefined,
    );
    console.log(
      'Exact allowed template comparison passed; not deployment authorization or proof of baseline freshness.',
    );
  } catch {
    console.error('TEMPLATE_COMPARISON_FAILED');
    process.exitCode = 1;
  }
}
