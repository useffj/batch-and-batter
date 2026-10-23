# Bounded shared-commerce release definition — 1N-AK

Status: **NOT DEPLOYABLE — SEPARATE AUTHORIZATION REQUIRED**.

This source-only extension reuses `build-api-release.cjs` and its unchanged trusted
baseline anchor. It does not approve an artifact, execute a deployment, or replace
the release process. Default API-code-only behavior remains strict. The new fixed
`shared-commerce` mode permits the additions below, never a caller-provided allowlist
or values imported from an untrusted synthesized template.

## Exact contract

All four routes already exist in CDK; their definitions were reused unchanged.
Each uses `HttpApiF5A9A8A7`, JWT authorizer
`HttpApiAdminJwtAuthorizerA698361D`, and integration with
`ApplicationApi5D63FF39`. The following complete resource additions are fixed,
including metadata, properties, principal, integration target and invocation ARN:

| Resource path (`Resources.` prefix)                                                | Type                             |
| ---------------------------------------------------------------------------------- | -------------------------------- |
| `HttpApiGETadminproductsAdminCatalogIntegrationEB82D66E`                           | `AWS::ApiGatewayV2::Integration` |
| `HttpApiGETadminproductsAdminCatalogIntegrationPermission019DC0D5`                 | `AWS::Lambda::Permission`        |
| `HttpApiGETadminproductsF96C398C`                                                  | `AWS::ApiGatewayV2::Route`       |
| `HttpApiGETadminproductsproductIdAdminGetProductIntegration73A28469`               | `AWS::ApiGatewayV2::Integration` |
| `HttpApiGETadminproductsproductIdAdminGetProductIntegrationPermissionF096BCBB`     | `AWS::Lambda::Permission`        |
| `HttpApiGETadminproductsproductIdCF6151D2`                                         | `AWS::ApiGatewayV2::Route`       |
| `HttpApiGETadmindropsAdminListDropsIntegrationBF8996E1`                            | `AWS::ApiGatewayV2::Integration` |
| `HttpApiGETadmindropsAdminListDropsIntegrationPermission1DF66F9F`                  | `AWS::Lambda::Permission`        |
| `HttpApiGETadmindrops49B1B593`                                                     | `AWS::ApiGatewayV2::Route`       |
| `HttpApiPUTadmindropsdropIddraftAdminSaveWeeklyDraftIntegrationBFCE0AB9`           | `AWS::ApiGatewayV2::Integration` |
| `HttpApiPUTadmindropsdropIddraftAdminSaveWeeklyDraftIntegrationPermission84F4C6F0` | `AWS::Lambda::Permission`        |
| `HttpApiPUTadmindropsdropIddraft8F8B95AB`                                          | `AWS::ApiGatewayV2::Route`       |

The route keys are exactly `GET /admin/products`,
`GET /admin/products/{productId}`, `GET /admin/drops`, and
`PUT /admin/drops/{dropId}/draft`. CDK's invocation permissions use its normal
`/*/*/path` suffix (stage/method wildcards) but remain bound to this API, account,
region, application Lambda and exact route path. Route methods and JWT bindings
are exact; no additional public route is allowed.

The only existing IAM property change is
`Resources.ApplicationRoleDefaultPolicy2A2BCE7E.Properties.PolicyDocument.Statement[3].Action`:
insert `dynamodb:Scan` after `dynamodb:Query`. The statement must otherwise exactly
match its existing action sequence, Allow effect, and Catalog-only ARN
`Fn::GetAtt: [CatalogTableF8EA09BD, Arn]`. No index, Commerce, Operations or wildcard
resource is added. All other statements and role bindings stay identical.

Only when supplied with the existing verified API candidate identity may a future
release also change `Resources.ApplicationApi5D63FF39.Properties.Code`. This milestone
built no candidate and changed none of the five accepted Code references. The
financial worker Code, handlers, runtime, environment, parameters, payment admission,
lifecycle policies and every other resource/property remain exact baseline copies.

## Local preparation interface

From `infra`, after infrastructure TypeScript compilation (without backend rebuild):

```sh
node scripts/build-api-release.cjs --shared-commerce authenticated-snapshot.json new-output-directory
```

A separately reviewed candidate JSON may later be supplied as the final argument;
its existing artifact identity and destination validation still apply. The old
`snapshot candidate output-directory` invocation remains API-code-only.
The CLI always validates the fixed anchor, account, region, stack identity,
update time, complete financial parameters, UPDATE_COMPLETE status, and 15-minute
freshness. Caller evidence cannot replace the anchor. Existing destinations are
refused. All output retains deployment blockers; no option enables execution.
Pure proposal/comparison helpers establish structural equality only, never fresh
AWS evidence or deployment authorization.

## Validation and synthesis boundary

The read-only installed Original template retrieved during this milestone matched
the unchanged anchor SHA-256
`7afad8c03b128eff48b0ce8af20b6c7c400e0b40273441db75c2d775afe510e9`.
The local bounded proposal contains 191 resources: 179 preserved plus 12 additions,
and only the Catalog action edit. No candidate was selected. This template read
is not a fresh complete release snapshot or approval to deploy.

Full current CDK synthesis is **REJECTED**, not an approved release input. Additional
pre-existing source differences were detected and excluded:

- Commerce table attribute definitions and GSI definitions.
- Application-role Commerce ConditionCheckItem, Commerce/Operations/index Query,
  and restricted Operations UpdateItem statements.
- Guest origin, cancellation-hours and pickup-cutoff parameters and API environment.
- Financial parameter defaults/AllowedValues, including admission AllowedValues.
- Lambda asset metadata on all five existing functions.
- Replacement of installed `AdminStorefrontAssignmentIntegration`,
  `AdminStorefrontAssignmentRoute`, and `AdminStorefrontAssignmentInvokePermission`
  with CDK-generated counterparts.
- Additional guest request/view/pickup; admin media read/write/upload/status/complete/
  asset; fulfillment; customer search/history; notification; cancellation request/
  review; guest access/reissue/revoke; refund worklist; and order list/detail route,
  integration and permission resources.

No exception was added for these differences. Full-stack deployment remains blocked.

Focused validation: 75 infrastructure/release tests; TypeScript compilation and
no-emit typecheck; offline CDK synthesis with lookups disabled; formatting and diff
checks. Tests compare the fixed resource contract with actual CDK output, preserve
all five accepted artifacts, retain API-only behavior and reject unauthorized
route/JWT/integration/IAM/financial/runtime/lifecycle changes, stale evidence and
blocker bypasses. No backend/API build or hosted acceptance was repeated.

## Separate hosted gates

1. Protected shared-commerce API and frontend acceptance access.
2. Controlled ownership backfill for the existing three Products, with conflict decisions.
3. Catalog readiness activation; never initialize the existing Catalog as empty.
4. Exact future API artifact financial compatibility, create-only publication,
   accepted artifact retention and rollback verification.
5. Fresh authenticated baseline, explicit authorization, reviewed bounded change set,
   post-release verification and separately authorized deployment/hosted acceptance.

Public Job 9 and restricted Job 4 are preserved by making no hosting changes.
Payment admission remains disabled; production tax/fee policy is unapproved.
Hosted duplicate-activation acceptance remains **NOT PASSED**. No AWS writes,
publication, database operations, emails, Stripe operations, or protected-workspace
changes are part of this checkpoint.

Next bounded milestone: focused PR review and CI for this validator, with separate
authorization to publish the branch. Do not activate any hosted capability.
