# Phase 5B2C2A — recovery infrastructure DLQ separation

Local implementation and read-only validation only. NO DEPLOYMENT IS AUTHORIZED.
PAYMENT_START_ENABLED remains false. No payment enablement, Stripe mutation,
application-data mutation, or message deletion is part of this phase.

## Infrastructure scope

Add the Standard SSE-SQS queue `batch-and-batter-dev-recovery-infrastructure-dlq`,
retained for 14 days, with no consumer and no redrive policy. Route only expiry
reconciler asynchronous OnFailure envelopes and expiry recovery Scheduler delivery
failures here. Replace those roles' exact destination `sqs:SendMessage` resource ARNs.
Keep the reconciler $LATEST retry policy (2 retries / 120 seconds), Scheduler group,
cadence, payload, target, retry policy and flexible window unchanged.

Add `RecoveryInfrastructureDlqNonEmpty`, physically named
`batch-and-batter-dev-payment-RecoveryInfrastructureDlqNonEmpty`, with visible-message
Maximum >= 1 over one minute, one evaluation datapoint and missing data not breaching.
Its action uses the existing payment-alerts SNS topic and existing bounded topic policy.

Preserve reservation source/redrive/DLQ, worker mapping/permissions, payment queues,
payment worker, admission, tables and routes. Reservation DLQ means exhausted business
queue processing after deployment, subject to legacy records already present.

See [the recovery runbook](PAYMENT_RECOVERY_RUNBOOK.md#recovery-infrastructure-separation-phase-5b2c2a-pending-deployment)
for distinct triage rules and the unresolved three-record EventAgeExceeded investigation.
Neither queue may be automatically purged. The known old message
`071e449a-f9bc-428f-9e99-fe5344117cbc` must remain until separately authorized cleanup.
No historical acceptance result is superseded by this local infrastructure correction.

## Validation scope

Deterministic infrastructure tests cover queue isolation, exact destination permissions,
worker isolation, preserved reservation redrive/alarm, new alarm/SNS policy compatibility,
no runtime Scan and disabled payment admission. Full backend functional/artifact and
infrastructure regressions, audits, synth, formatting and read-only deployed-stack diff
are required before human review. Expected diff: two additions and four modifications;
no replacements or deletions and no SNS policy change.
