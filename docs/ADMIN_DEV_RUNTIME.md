# Admin DEV runtime configuration — 1A-DEV1

Local implementation only, based on merged PR #54 (`63e9d5cf6b187dcb3f8fe8d929153a8c0715dfda`). No provisioning or deployment is authorized by this document. Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Runtime behavior

The admin page and four admin API handlers use `admin/runtime.ts`. Its server-only loader uses AWS SDK v3 `SSMClient`, fixed to `us-east-2`, with the default temporary-credential provider chain, two maximum attempts and a five-second abort signal. There are no explicit AWS credentials, SDK logger, build-time reads, or business-data writes. The existing encryption, Cognito calls, backend authorization and 15-minute maximum session lifetime are unchanged.

`ADMIN_SESSION_KEY_PARAMETER` must equal `/batch-and-batter/dev/admin/session-key`. Each response must have that exact Name, the exact account/region ARN below, Type `SecureString`, and a Value of exactly 64 hexadecimal characters (32 bytes). No trimming, labels, version selectors, alternate account, region or parameter are accepted. Requests use `GetParameter` with `WithDecryption: true`.

The loaded key is passed only to existing server-side session logic. It is never assigned to process.env, logged, written to disk, returned in responses, or passed as a React prop. Next.js `server-only` boundaries protect the loader, adapter and encryption module. Local tests mock the marker and AWS transport; production does not.

Missing/invalid configuration and SDK errors become a sanitized configuration error: API HTTP 503 with no-store headers, or the existing admin-page configuration redirect. No raw SDK error reaches those surfaces. Production never falls back to `ADMIN_SESSION_KEY`. Only explicit `NODE_ENV=development` or `test`, with no parameter configured and a valid key, can use that local environment setting. If a parameter is configured, even local development must use it and fail closed on errors. Never put real DEV keys in local environment files.

## Cache and rotation

One validated key is cached per server process for 60 seconds after retrieval. Concurrent reads share one in-flight promise. Expired keys are discarded before refresh; failures are not cached and do not permit stale reads. A later request retries. There is no background polling, persistent cache or automated rotation. AWS/network failures after expiry therefore make admin services unavailable until recovery.

After an operator-authorized rotation, warm instances may use the old key for up to the remaining cache lifetime, while new instances use the new key. Sessions and pending MFA challenges sealed with the old key fail decryption once an instance loads the new key. During that transition, users may need to restart sign-in. There is no old-key grace ring and rotation is not instantaneous global revocation. In-flight requests retain their resolved key until completion. JavaScript does not guarantee physical zeroization of garbage-collected strings; the cache bounds use, not forensic memory retention. Session lifetime remains at most 15 minutes.

## SSR settings and operator provisioning plan

The existing `prepare-amplify-env.mjs` explicitly adds only these optional nonsecret settings to `web/.env.production` during an authorized hosting build:

| Setting                     | Operator-provided value                                        |
| --------------------------- | -------------------------------------------------------------- |
| ADMIN_ORIGIN                | Exact HTTPS origin of the authorized DEV hosting site, no path |
| ADMIN_API_BASE_URL          | HTTPS DEV API base URL, including its stage if applicable      |
| ADMIN_COGNITO_REGION        | us-east-2                                                      |
| ADMIN_COGNITO_CLIENT_ID     | Existing secretless admin Cognito app client ID                |
| ADMIN_SESSION_KEY_PARAMETER | /batch-and-batter/dev/admin/session-key                        |

Missing settings remain absent so storefront-only builds keep working and admin fails closed. Malformed supplied values are rejected before writing, without echoing them. Existing storefront and checkout settings are preserved. `ADMIN_SESSION_KEY`, arbitrary `NEXT_PUBLIC_` variables, AWS credentials and passwords are excluded. Do not provide a real key to the build environment or Next config; no build step retrieves SSM secrets. Only the parameter locator belongs in artifacts.

For separately authorized provisioning, an operator must create a Standard SecureString at the exact path, containing a securely generated 32-byte key encoded as 64 hex characters. Creation, rotation and key generation are outside this milestone. Do not pass secret values through shell arguments, logs, source control, build variables or this document.

Assign a dedicated SSR **compute** role to only the approved DEV hosting branch of app `d1aw7cfglvejmo` (currently `main` serves that DEV application despite its Amplify stage label). Confirm the app/branch mapping before attachment. Do not make it the app-wide default or attach it to preview branches. This is separate from the Amplify build/service role. Keep auto-builds, auto-branch creation and PR previews disabled. No new deployment permission is needed.

Proposed compute-role permission, for operator review only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:us-east-2:302154194958:parameter/batch-and-batter/dev/admin/session-key"
    }
  ]
}
```

Trust principal: `amplify.amazonaws.com`; action: `sts:AssumeRole`. Scope the trust to this account and app using AWS-supported source conditions after operator validation of the service context. Branch isolation is enforced by branch-specific role attachment; do not assume an unverified branch ARN trust condition works. Do not attach general managed policies, Parameter Store wildcards, GetParametersByPath, GetParameterHistory, write permissions, or unrelated service permissions. Audit all attached and inline permissions, not just this statement. Operator role creation/attachment privileges must be separate from runtime privileges.

For DEV, the AWS-managed `alias/aws/ssm` key avoids another key resource and policy. Its default policy allows account principals to decrypt when SSM access permits retrieval, so it provides less independent isolation. The exact SSM resource permission remains essential. A customer-managed symmetric KMS key provides independently controlled decryption and revocation, with additional cost and key-policy administration. If selected in a separately reviewed plan, allow only `kms:Decrypt` on that specific key ARN, constrained by:

```json
{
  "StringEquals": {
    "kms:ViaService": "ssm.us-east-2.amazonaws.com",
    "kms:EncryptionContext:PARAMETER_ARN": "arn:aws:ssm:us-east-2:302154194958:parameter/batch-and-batter/dev/admin/session-key"
  }
}
```

The CMK key policy must also permit this role (or narrowly delegate via IAM). No Encrypt, GenerateDataKey, key administration or wildcard KMS permission is needed by this reader. Provisioning permissions belong to the operator, not SSR.

## Validation and remaining gates

Automated tests use synthetic keys and mocked SSM; no real DEV key or AWS call is required. Tests cover identity/type/format rejection, errors, no production fallback, coalescing, TTL, retry, rotation and existing login/MFA/session/dashboard/logout through the adapter. Environment-artifact tests use isolated temporary directories and exclude credentials and secrets.

Fresh npm audit on 2026-10-13 reports **8 vulnerable package nodes (7 high, 1 moderate)**: existing Next/PostCSS, ESLint/braces dependency chains and sharp. No AWS SDK or server-only advisory is reported. No audit fix or dependency downgrade was applied. These findings are not cleared by passing tests; new dependencies and a changed SSR artifact require fresh security/artifact review. The historical DEV exception expires October 14, 2026 at 5 PM America/Denver and does not authorize this new artifact.

Remaining gates: focused code/security review and separately authorized source-control checkpoint; operator-approved role/key/branch configuration; renewed dependency and packaged-artifact review; narrowly authorized DEV frontend/API deployment preserving accepted mixed Lambda artifacts; then separately authorized live Cognito/dashboard acceptance. Do not perform a full-stack CDK deployment or change payment admission, Stripe, inventory mutation behavior or accepted payment artifacts.

## Guidance reviewed

- [Amplify SSR compute roles](https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html): temporary runtime credentials and branch-specific attachment.
- [Amplify SSR environment variables](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html): explicit SSR environment preparation; sensitive values must not be put in deployment artifacts.
- [SSM SecureString and KMS](https://docs.aws.amazon.com/systems-manager/latest/userguide/secure-string-parameter-kms-encryption.html): GetParameter decryption and encryption-context restrictions.
- [Restricting SecureString decryption](https://docs.aws.amazon.com/systems-manager/latest/userguide/ps-restrict-decryption.html): aws/ssm versus customer-managed-key isolation.
