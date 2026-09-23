# Phase 4B1: Admin authentication foundation

This phase defines an authentication boundary before adding administrative CRUD. It adds one app client to the existing admin Cognito pool, one JWT authorizer on the existing HTTP API, and one diagnostic route. It does not create users, deploy infrastructure, modify MFA, or give Lambda write permissions.

## Sign-in flow

```text
Admin signs in
    ↓
Cognito issues access token
    ↓
Authorization: Bearer <token>
    ↓
API Gateway validates JWT
    ↓
GET /admin/me
    ↓
Lambda
```

Cognito stores the administrator accounts and verifies their sign-in credentials. An **app client** identifies the application allowed to request authentication tokens from that pool. Its ID is public configuration, not a password. Our client has no secret because a future browser application cannot keep a shared secret confidential. Self-signup stays disabled; the existing pool is reused without changing its MFA settings.

A **JWT** is a signed token containing claims such as subject, issuing service, expiration, and token purpose. A signature lets API Gateway verify who issued the claims. A signed token is not encrypted, and possession of an access token can grant access until it expires. Never log, commit, or share actual tokens or sign-in credentials.

## App client configuration

The new `AdminAppClient` is a child of the existing `AdminUserPool` construct. Its name is `batch-and-batter-dev-admin-client`.

| Setting                 | Value / reason                                                                |
| ----------------------- | ----------------------------------------------------------------------------- |
| Client secret           | None (`GenerateSecret: false`)                                                |
| Password authentication | `ALLOW_USER_PASSWORD_AUTH` for explicit development/manual sign-in            |
| SRP authentication      | `ALLOW_USER_SRP_AUTH` for future compatible browser clients                   |
| Refresh authentication  | `ALLOW_REFRESH_TOKEN_AUTH` to renew a session                                 |
| Access token validity   | 15 minutes; bounds the lifetime of a stolen bearer token                      |
| ID token validity       | 15 minutes; keeps identity metadata lifetime short and aligned                |
| Refresh token validity  | 1 day; practical development sessions without the default multi-week lifetime |
| Token revocation        | Enabled                                                                       |
| User existence errors   | Suppressed (`PreventUserExistenceErrors: ENABLED`)                            |
| Identity provider       | Cognito only                                                                  |
| OAuth / Hosted UI       | Disabled; no domain or callback URLs                                          |

The pinned CDK includes refresh authentication when explicit auth flows are set and refresh rotation is not enabled. Tests assert the exact three synthesized flows, with no custom authentication, admin-password flow, or choice-based USER_AUTH. Token validity is explicitly synthesized as 15/15/1440 minutes. Rotation is not added because this phase specifically supports REFRESH_TOKEN_AUTH.

Outputs are `AdminUserPoolId` (existing) and `AdminAppClientId` (new). Neither is a secret. No usernames, passwords, user resources, or client secrets are created.

## API Gateway authorization

`HttpJwtAuthorizer` uses the existing Cognito pool's `ProviderURL` as issuer, the new client ID as its sole audience, and `$request.header.Authorization` as its identity source. Callers supply a bearer access token in that header. No global/default authorizer is installed.

API Gateway verifies JWT signature, issuer, audience/client ID and relevant time claims before invoking Lambda. For access tokens without `aud`, API Gateway checks `client_id` against the configured audience. See [AWS's HTTP API JWT authorizer documentation](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html). Explicit Cognito flow and lifetime settings follow [the app-client API reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html).

| Route                 | Authorization                      |
| --------------------- | ---------------------------------- |
| `GET /health`         | Public, unchanged health response  |
| `GET /drops/current`  | Public, unchanged catalog behavior |
| `GET /drops/{dropId}` | Public, unchanged catalog behavior |
| `GET /admin/me`       | JWT authorizer required            |

There are no administrative write routes, no second HTTP API, and no public Lambda function URL.

No OAuth scopes or resource server are added in this phase. API Gateway can otherwise accept an ID token for a matching app client. Lambda therefore additionally requires `requestContext.authorizer.jwt.claims.token_use === 'access'`. It reads only the authorizer context, never claims supplied in caller headers or the request body. Missing context receives 401; an ID token or other token-use value receives 403. Missing or malformed subject/username also receives 401. All Lambda errors retain the existing code/message/requestId contract, while API Gateway's own rejection responses are generated before Lambda runs and can have a different shape.

A successful diagnostic response contains only `authenticated: true`, `subject` (the `sub` claim), and `username`. It uses `Cache-Control: no-store`. No raw JWT, Authorization header, email, groups, or other claims are echoed or logged. The route does not initialize the Catalog repository. Lambda does not perform custom JWT signature validation or make Cognito SDK calls.

## Authorization scope and IAM

This dedicated pool is the current administrator boundary: any user provisioned there who authenticates through the new app client can call the diagnostic route. There is no group/role mapping in Phase 4B1. Do not add customers or unrelated users to this pool. Membership/role requirements must be reviewed before protected write APIs are added.

Lambda's IAM policy remains exactly its existing scoped CloudWatch log writes plus `dynamodb:GetItem` and `dynamodb:Query` on CatalogTable. It gains no DynamoDB writes, Scan, CommerceTable, OperationsTable, SQS, or Cognito management permissions. API Gateway receives one new route-scoped Lambda invocation permission; that is separate from the Lambda execution role.

The original Cognito pool, all three tables, HTTP API, Lambda, queues, S3 bucket, and log group retain their construct identities. Existing pool configuration, including MFA, is not changed.

## Human verification after separately approved deployment

This implementation performs no deployment or live sign-in. Local tests establish configuration and handler behavior; live rejection/acceptance must still be verified after approval.

1. Review the infrastructure diff and deploy only after separate authorization.
2. A human creates a development administrator in the existing pool, outside CDK/application code, and completes any required initial credential-change challenge. No default password is supplied.
3. Read the pool and app client IDs from stack outputs. Use a trusted Cognito client to sign in with USER_PASSWORD_AUTH or SRP. Keep credentials and returned tokens out of source files, shell history, logs and shared screenshots.
4. Exercise the matrix below using a client that handles bearer credentials securely. Record status/results only, not tokens.

| Check                                                          | Expected                                                |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| Public health/current/specified Drop without Authorization     | Existing public behavior                                |
| `/admin/me` without Authorization                              | API Gateway rejection, normally 401; Lambda not invoked |
| Invalid signature, expired token, wrong issuer or wrong client | API Gateway rejection                                   |
| Valid ID token for this app client                             | Lambda rejects with 403 when Gateway accepts it         |
| Valid access token for this app client                         | 200 with only the three identity fields                 |
| Attempted administrative POST/PUT/PATCH/DELETE                 | No matching write route                                 |

User creation stays separate to avoid credentials/default users in infrastructure, to keep provisioning intentional, and to let a human verify the authentication boundary before any data mutation exists.

## Validation, security and follow-ups

The existing CI already installs, typechecks, builds and tests backend/infra and synthesizes without AWS credentials. No CI change or new dependency is needed. New tests use synthetic claim objects only—no JWTs, Cognito calls, or real identities. Artifact checks continue to exclude tests, seed tooling, credentials, and infrastructure code from the Lambda bundle.

Before production administrative writes, separately review MFA, administrator provisioning and roles, browser credential/token storage, and sign-out/revocation expectations. Enabling Cognito revocation does not make API Gateway's offline JWT signature validation an immediate session-revocation check; short access-token lifetimes bound that exposure. Do not describe this diagnostic route as a completed production admin authorization system.

Phase 4B1 deliberately precedes CRUD: it proves the intended authentication boundary locally and supplies a live verification procedure without increasing the consequence of an authorization mistake. Actual administrative mutation remains a later phase.

## Local review results

- Backend: `npm ci`, typecheck, build, 73 functional tests (including 19 new admin tests) and 5 artifact checks passed.
- Infrastructure: `npm ci`, typecheck/build, 12 assertions tests and `cdk synth --lookups=false` passed. The existing CDK feature-flags notice remains unchanged.
- Backend and infrastructure audits report zero vulnerabilities. No dependencies or lockfiles changed; the accepted web dependency risk is untouched.
- Repository formatting and `git diff --check` passed. Web source and configuration are unaffected, so its application build/tests were not rerun for this backend-only phase. CI configuration is unchanged.
- Review of changed sources and generated artifacts found no actual passwords, JWTs, access/refresh tokens, client secrets, or AWS credentials. Tests contain only synthetic claim fields, not signed tokens or real accounts.
- The read-only development AWS diff succeeded with `--no-change-set`: five resource additions (client, authorizer, route, integration, invocation permission), one existing Lambda code update, and the new client-ID output. No existing resources are replaced or deleted; the user pool, tables, HTTP API and Lambda logical IDs remain. Lambda execution-role IAM is unchanged.
- No deployment, user creation, live authentication test, AWS seed execution, commit or push was performed. Human live verification is still pending a separately approved deployment.

Suggested commit message after review: `feat: add admin authentication foundation`.
