# Admission relock controller, version 2

Status: controller, transport adapter, CLI executor and Runner Phase 1A are
locally validated. The October 7 duplicate-activation scenario remains
**NOT PASSED**. The runner is simulation-only; no executable hosted runner,
fixture creation or payment functionality is provided. Executor capabilities
remain separate and are not invoked by the runner. Browser gesture capture and
human-readiness coordination are not implemented.

## Source and provenance

The October 7 scripts were ad hoc execution tooling stored alongside the evidence
they produced, not maintained repository source. Their `SHA256SUMS` covers the
scripts as well as records. No repository references or maintained Python
admission runner were found. They remain immutable historical snapshots at:

`/Users/jksn/.codex/artifacts/batch-and-batter/hosted-duplicate-activation-replacement-20261007/`

This is the versioned working source for the **relock controller**, derived from
`admission-window.py`; it is not a replacement execution of that script. Existing
repository acceptance tooling lives under `tools/`; Python standard-library
`unittest` preserves the historical harness's local test convention without
adding dependencies or changing application packages or CI.

Historical checksums at correction start:

| File                          | SHA-256                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| admission-window.py           | 6c4e5cc3dc02dcf61850c86c6560d91890aaf5017ba3ad5a19be6bf5177f9b00 |
| common.py                     | 142c9d87136f61d8a25bbe3d8a5051912758b758b98e29e8f15ae62d98070f00 |
| checkout-gate.py              | 84829f458c49eea77bdb5fe2bb5cb6fd2b03ab80b0abf3e091815258f01b8ccc |
| test-admission.py             | 8b6084c74791240845b365393d9102e7d9d7d621dd1ef889100d303a7c75a323 |
| validate-admission-request.py | e1b3cfb8cf662a5195b09579e06bb33ca3c883846cc71f33c3e771196ee075fb |
| SHA256SUMS                    | 02ea4b7e9ffe7e63283802b0700df8421a7814043317974a2883e438a4aa247f |

## Deadline and cleanup contract

- Capture paired monotonic nanoseconds and UTC at verified enablement. Establish
  a scheduled relock at +100 seconds and a hard deadline at +120 seconds.
- Revoke the instruction gate at +100 seconds, or immediately when `stop` is set.
  Even a delayed controller wakeup cannot make `instructions_allowed()` true
  beyond that point. This gate is necessary but never sufficient authorization
  for Pay; no human instruction is emitted by this module.
- Cache the fully verified enabled configuration and its revision. The initial
  disable request uses that revision and the original complete false environment.
  There are **no configuration reads before the initial disable dispatch**.
- Retain compare-and-swap revision protection. A conflict never permits an
  unconditional overwrite. Recovery reads and full guards run only after the
  initial attempt (or for ambiguous enablement with no verified snapshot).
- Distinguish `relock_entry`, `disable_update_dispatch`, and `disabled_verified`.
  Dispatch is recorded by the adapter at its update invocation boundary, not
  when the controller enters cleanup. It is not a claim of AWS receipt.
- Dispatch at or beyond +120 seconds is a critical deadline failure. Cleanup is
  still attempted; later verified false cannot erase the failure. This is a
  conservative implementation of the existing maximum, not a longer allowance.
- Any update/read failure remains critical even if bounded recovery subsequently
  confirms false. The report separately exposes `disabled_verified`.
- Cleanup attempts at most three false updates within a 100-second cleanup
  budget. Slow or incomplete verification is critical. Stops/interruption of the
  active wait do not bypass cleanup. No catch block reports success from entry
  alone. Exact identity/environment/code drift is never overwritten.
- Only a fresh, full, Active/Successful false configuration passes verification.
  This is configuration readback, not proof that all in-flight traffic has ended.
- Events accumulate in memory; no artifact file writes precede dispatch. A
  future runner must persist the report on both success and critical exceptions
  to a **new** evidence directory, never the October 7 directory.

## Future integration boundary (not performed)

The controller is dependency-injected and cannot run a hosted scenario by itself.
Before any future use, a separately reviewed caller must supply:

1. The approved false baseline. Code hash, DEV function/account/region, exact
   sandbox binding and historical namespace remain pinned to the accepted
   artifacts. Guards compare all other configuration fields except service
   revision/status metadata; no identity normalization is allowed.
2. An `enable_and_verify(complete_verification)` callback that preserves the existing authorization,
   one-window/fixture guards, authenticated access, account/artifact/health
   preflight, full revision-guarded environment update, authoritative pricing,
   pickup and unrounded 300-second reservation checkpoints. At the completed fresh Successful readback it must immediately call
   `complete_verification(configuration)` before browser work, readiness waits or
   evidence persistence, then return the exact resulting `VerifiedEnablement`.
   Returning promptly remains required for timely cleanup; any later callback
   work consumes the original window and cannot shift its deadlines.
3. The existing independent health/commerce/ambiguity monitor connected to the
   same stop Event. Blocking monitor reads must not run on the timer thread.
4. A disable adapter with no configuration reads or hidden retries before its
   update call, exact RevisionId CAS, bounded operations, and exactly one
   `on_dispatch()` call immediately before each actual update invocation. It must
   honor the supplied timeout. Transport acceptance and completion are separate
   from the callback. No AWS adapter or subprocess runner is included here.

The controller is one-use in memory. Existing durable authorization markers,
restart handling, global monitoring, external report persistence, browser
evidence and human handoff still require caller integration review. Do not copy
the new controller into historical artifacts or invoke the historical runner to
"test" it. No acceptance approval is implied by passing local tests.

A general-purpose OS can pause longer than the 20-second margin. This code cannot
guarantee an on-time cloud invocation under arbitrary suspension, process death,
blocked adapter code or unavailable AWS. It detects a missed dispatch boundary,
revokes instructions and continues protective cleanup; unverified false is an
explicit critical failure. Local mocks establish controller behavior, not live
Lambda propagation latency. UTC jumps do not change monotonic deadline results.

## Deterministic local validation

From the repository root:

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Tests use synthetic configurations, fake nanosecond clocks and in-memory
transports. No credentials or historical artifact imports are used. Socket,
subprocess, process-spawn and real-sleep tripwires fail accidental live I/O.
No AWS CLI, SDK, Stripe client, web server or network endpoint is needed.

Tests cover normal +100-second dispatch; 5.1 ms and 19-second wakeup delays;
120 seconds minus one nanosecond, exactly 120 and past the deadline; slow reads;
stop/interruption; update/read/verification failures; ambiguous enablement;
revision conflicts and drift; instruction revocation; paired timestamps and
forward/backward UTC jumps. Timing boundary tests never sleep for 120 seconds.

## Verified-enablement handoff correction (October 9, 2026)

This is a breaking local callback-contract change. `run` now supplies a
`complete_verification(configuration)` function to the enable callback. The
callback calls it exactly once at completed fresh enablement verification and
returns its exact `VerifiedEnablement` object. That handoff contains a defensive
configuration snapshot, its explicit `revision_id`, and paired monotonic/UTC
`verified_at`. The recorder validates full configuration/identity and revision,
then stamps verification with the controller's own clock. No caller-provided or
cross-process timestamp is accepted. Old zero-argument callbacks returning a
configuration dictionary are incompatible and fail critically; no live caller
has been integrated.

The recorder retains a separate configuration snapshot and timing origin before
returning to callback code. Return-time validation rejects missing, reconstructed,
foreign or mutated handoffs; malformed timestamps, noninteger/bool monotonic
values, timestamps before this callback or in the future, invalid/non-UTC audit
times, and missing/invalid revisions are rejected without substituting now.
A repeated recorder call cannot restart the clock, even if the callback catches
its exception. The instruction gate stays closed until successful handoff return.
UTC steps are audit data only and never change monotonic deadlines.

If a callback returns after +100 seconds, cleanup starts immediately. At or after
+120 seconds, critical deadline status is latched even if readback already shows
false; subsequent cleanup cannot turn that run into a pass. First dispatch still
uses the retained verified revision with no intervening configuration read.

If the callback raises after calling the recorder, the original timestamp and
revision remain available for guarded cleanup. If it raises before recording
verification (including after possible enablement), the result is critical:
there is no invented verification timestamp or revision, and cleanup must obtain
a fresh guarded configuration. Unknown timing cannot be reported as on time.
Configuration drift still prevents unsafe overwrites; unverified disablement
remains critical.

This synchronous controller cannot interrupt an indefinitely blocked callback,
force a caller to invoke the recorder at the actual readback boundary, or ensure
relock during process suspension/termination. A delay before the recorder is
called cannot be independently detected here. These remain explicit caller and
integration review requirements. Reports remain in memory; transport integration,
monitoring, persistence, escalation, gesture evidence and human readiness are not
implemented by this correction.

Local validation for this correction: **44 tests passed, 0 failed** with the
command above. All 31 previous test cases remain (callback signatures adapted);
13 added cases exercise verification ownership, delayed return, deadline edges,
invalid/inconsistent handoffs, repeated recording, callback failure and UTC
changes. Parameterized cases include 0/5/25-second return delays (dispatch +100),
105/119-second delays (immediate dispatch), +119.999999999 (before deadline), and
+120/+125 seconds (critical with cleanup). Verification latency itself is tested
separately from later callback work. Tests use only fake clocks/transports and
existing fail-closed I/O tripwires; no cloud calls or real deadline sleeps.
`VALIDATION.txt` is the preserved earlier 31-test record, not this correction's
result. Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Dependency-injected disable adapter (local only)

`transport.py` implements `LambdaDisableTransport(baseline, executor, now_ns)`.
It implements the existing `DisableTransport` protocol without changing the
controller. It has no SDK/client construction, credentials, import-time I/O or
live entry point. Authentication, account selection and authorization remain
future caller responsibilities. No maintained hosted runner is connected.

The historical `common.py` and `admission-window.py` use AWS Lambda
`UpdateFunctionConfiguration` (CLI `lambda update-function-configuration`) and
`GetFunctionConfiguration` (CLI `lambda get-function-configuration`). This adapter
retains those operations and exact request fields; it introduces no alternate
configuration mechanism.

The supplied executor implements:

- `update_function_configuration(parameters, *, budget, max_attempts, on_dispatch)`
- `get_function_configuration(parameters, *, budget, max_attempts)`

Both return the full configuration dictionary (without SDK `ResponseMetadata`).
The executor must perform exactly one attempt, no hidden retries/backoff or
preliminary reads, and raise on errors/ambiguous outcomes. The adapter always
passes `max_attempts=1`; this is a required executor contract, not proof that an
arbitrary injected executor obeys it. No production executor is supplied here.

The adapter copies and pins the approved false baseline, including the accepted
code hash, account, region, actual sandbox binding and exact historical namespace.
Disable requests must contain exactly `FunctionName`, `RevisionId`, and the full
baseline `Environment` with admission false. Every other environment value must
match. RevisionId is preserved literally, never refreshed by the adapter; a stale
revision error propagates. The controller owns any separately guarded retry.
Requests and readback objects are defensively copied.

The adapter validates and copies the request before executor entry, then passes a
single-use guarded dispatch callback into the update operation. It no longer
records dispatch before entering the executor. The executor owns this sequence:
prepare invocation arguments and protected input; validate remaining budget;
call `on_dispatch()` once; immediately attempt the local invocation. No reads,
persistence, retries or unrelated blocking work may intervene at that boundary.

The guard rejects duplicate/out-of-scope callbacks and expired budgets. Callback
failure must prevent invocation. Successful executor return without a completed
callback, or after a swallowed callback error, raises a contract error. The
adapter cannot stop a noncompliant executor from launching anyway or prove a
launch actually occurred: callback evidence marks an attempted local dispatch,
not AWS receipt or application. Exceptions after dispatch remain failures or
ambiguous outcomes and are never retried by the adapter.

One `OperationBudget` holds an absolute monotonic deadline. The timeout includes
validation, callback, executor work and response validation. The executor receives
that same budget and must call `remaining_seconds()` at entry and after preparation, reject expiration,
and enforce the remaining total duration. Finite positive timeouts are required;
sub-nanosecond/overflowing inputs are rejected. Time spent in the marker reduces
the available executor budget. At or beyond the deadline, results are rejected
rather than returned as timely success. No deadline resets or adapter retries
occur. Raw executor exceptions propagate to the controller, which sanitizes its
report; a caller must not publish raw exceptions.

**Timeout limitation:** this synchronous adapter cannot preempt a blocking or
noncompliant executor. It detects late returns, but cannot guarantee return by the
deadline. A future concrete executor must demonstrate total timeout enforcement,
including connection/credential acquisition and any process startup. Fake tests
prove budget accounting and late-result rejection, not real network interruption,
SDK retry configuration, AWS receipt or Lambda propagation timing.

Every read calls the injected get operation; no cached update response is used.
Readback must contain the full baseline-compatible configuration, valid revision,
identity and known state/update-status fields. Malformed or drifted results raise.
Pending/InProgress/Failed states are preserved on reads for the controller's
verification logic; only its fresh Active/Successful false readback establishes
disabled verification. A malformed, ambiguous or explicitly failed update response
raises; even a valid update response does not establish disabled verification.

Prior adapter validation: **73 tests passed, 0 failed, 0 skipped** (44 unchanged controller
tests plus 29 adapter tests), using the same unittest command above. Coverage
includes exact payload/revision, environment preservation, callback ordering,
invalid requests, errors/conflicts/ambiguity without retries, shrinking budgets,
expired/late calls, malformed responses, fresh reads, mutation isolation and
controller/adapter composition. Adapter tests block sockets, subprocesses, process
spawning, sleeps and live AWS/Stripe SDK imports. No external operation was run.
Historical `VALIDATION.txt` remains unchanged.

Before future hosted use, separately review the concrete executor, completed
verification recording, durable authorization, independent monitoring, stop
propagation, instruction gating, failure escalation and protected report
persistence. Indefinite callback blocking and process suspension/termination are
not solved here. Browser evidence and human-readiness work remain separate.
Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Dispatch ownership correction — local validation

The internal executor update signature now requires `on_dispatch`; the public
controller-facing `dispatch_disable(request, timeout_seconds, on_dispatch)` and
`read_configuration(timeout_seconds)` signatures are unchanged. Existing executor
implementations must adopt the new contract; no concrete executor exists here.
The absolute operation budget is created once before request validation and is
shared through preparation, callback, launch and result validation. Neither
executor entry nor preparation completion resets it. Callback execution also
consumes time; any expired budget must prevent external I/O at the invocation
boundary, and late results remain errors. No subprocess supervision is implemented.

Latest complete local suite: **83 passed, 0 failed, 0 skipped**: all 44 controller
tests plus 39 adapter tests (29 retained/adapted and 10 added). Exact command:

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Fake operation traces assert `prepare -> callback -> launch`. Added tests cover
preparation/entry failure, preparation consuming the original budget, expiration
before preparation/during preparation/immediately before callback, missing and
duplicate callbacks, swallowed callback errors, and retained callbacks invoked
outside the operation. Existing tests continue to cover failures after dispatch,
late results, no retries, exact revision/environment preservation, fresh reads,
mutation isolation and controller cleanup. Tests block external I/O and do not
launch AWS CLI or any real subprocess. Simulated ordering is not proof of actual
process-launch ordering or cancellation.

Next: review this corrected boundary before separately authorizing concrete
executor development with local-only validation. That executor must demonstrate
argument/protected-input preparation, launch placement, retry suppression,
bounded process handling and sanitized errors. The controller, historical
validation records and PROJECT_HANDOFF.md were not changed by this correction.
No hosted runner, gesture capture or human-readiness coordination was added.
Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Concrete CLI executor — local implementation

`cli_executor.py` now supplies `AwsCliExecutor(executable, *, processes=None,
input_factory=protected_input, environment=None)`. This supersedes the earlier
checkpoint statements that no concrete executor exists. It is **LOCALLY
VALIDATED**, not connected to a maintained runner or authorized for hosted use.
Import and construction never launch AWS commands. No Python AWS SDK is added.

The two methods implement the existing internal executor protocol unchanged:

- `update_function_configuration(parameters, *, budget, max_attempts, on_dispatch)`
- `get_function_configuration(parameters, *, budget, max_attempts)`

The caller explicitly selects an absolute executable path named `aws`; the
executor resolves it, checks regular-file/executable status and rejects group/
world-writable executables. This validates the local path, not binary provenance;
trusted installation and credential/account preflight remain caller obligations.
The invocation is an argument list with `shell=False`, no stdin, private pipes,
closed unrelated descriptors and a new POSIX session. Profile is pinned to
`batch-and-batter-dev`, region to `us-east-2`, and function to the approved DEV API.
Update input contains only FunctionName, RevisionId and the complete Environment.
The adapter remains responsible for exact comparison with the approved baseline.

Request JSON is prepared in a random 0700 temporary directory and random 0600
file, referenced by `--cli-input-json file://...`. No configuration values are in
argv. Context-managed cleanup removes input on success, callback/launch failure,
timeout and parsing errors. This is ephemeral transport input, not evidence.
Request preparation and controlled subprocess environment precede the callback.
The callback is followed only by a nonblocking check of the same monotonic
OperationBudget before the local launch attempt; callback failure or expiry
prevents launch. Launch failure is conservatively ambiguous for an update. A callback or
successful process launch is not proof of AWS receipt.

`AWS_MAX_ATTEMPTS=1` and `AWS_RETRY_MODE=standard` override inherited settings;
profile/region are also explicit command arguments. Paging, prompting and debug
output are disabled. Ambient AWS credentials, proxies and unrelated environment
settings are not forwarded; reviewed profile/config/credential file paths may be
supplied. Endpoint overrides, configured endpoints, CLI history and plugins are
rejected. Direct IAM Identity Center (SSO), using either a legacy profile or an
explicit sso-session, is the sole allowed credential mechanism. Executable
credential helpers, web identity, credential_source, static credentials, alternate
providers and all additional role/source-profile chains are rejected. An approved
noninteractive SSO session must be prepared outside the window. This validator
does not inspect token caches, perform login or resolve credentials. During a
future authorized CLI operation, normal SSO credential/token refresh may occur
and consumes the original supervised operation budget; cache freshness must be
checked by the future runner before enabling admission. No credentials were read or AWS CLI run during this assignment.
Profile selection does not prove account identity. Config files and executable
must remain trusted/stable between validation and invocation.

`PosixProcesses` is the injectable launch/collect/cleanup dependency. Collection
uses nonblocking pipes and selectors with a **256 KiB limit per stdout/stderr
stream**; it never buffers unlimited CLI output. The original OperationBudget
covers preparation, process startup, credential activity, collection and parsing.
Remaining time is recalculated rather than restarting allowances. CLI connection/
read timeouts are one-second supplemental limits; parent supervision owns the
total operation deadline. Late results always fail.

Cleanup sends SIGTERM to the dedicated process group, waits up to 0.2 seconds,
then sends SIGKILL and waits up to 0.5 seconds to reap the direct child. Cleanup is
also applied after successful collection to remove surviving same-group helpers.
Failures to signal/reap are explicit TERMINATION_OR_REAP_FAILED errors. Cleanup
can extend beyond the operation deadline; it cannot convert a timeout to success.
If cleanup itself fails, its critical category takes precedence over the original
operation error. Process creation, OS suspension, termination scheduling and
escaped descendants prevent hard real-time or complete descendant guarantees.
A callback that returns at or after budget expiry produces OPERATION_TIMEOUT
without launching a child. The already-recorded callback event remains, but is
not evidence of launch or AWS transmission; this pre-launch timeout is not
classified as an ambiguous transmitted update. A final local check cannot prevent
OS suspension between the check and launch. If startup consumes the remaining
budget, existing post-launch supervision still fails and performs cleanup. An
indefinitely blocked callback still requires independent safety monitoring. No local
cancellation can undo an AWS update already transmitted. No update is replayed.

Raw stdout/stderr are never included in exception text or attributes. Errors use
sanitized categories and an ambiguity flag; chained raw exception display is
suppressed. Nonzero CLI status, revision conflicts, unexpected stderr, output
limits, malformed/duplicate-key JSON, missing fields and late output all fail.
JSON parsing preserves optional response fields without reconstructing anything
from a baseline. Update responses must preserve the requested Environment and
carry a different nonempty RevisionId. Read responses preserve their observed
revision. InProgress and Failed statuses are returned truthfully to the adapter;
only the controller's guarded fresh readback can establish disabled verification.

Response schema references inspected for this implementation:
[UpdateFunctionConfiguration](https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionConfiguration.html)
and [GetFunctionConfiguration](https://docs.aws.amazon.com/lambda/latest/api/API_GetFunctionConfiguration.html).
Both document the configuration/status fields required by this contract. The
historical admission baseline provided a readback field inventory only; it was
not reused as a purported update response. Tests use synthetic structural
fixtures. No actual update response was collected. Any newly returned optional
field that violates the existing exact baseline guard must fail closed and be
reviewed, not stripped or fabricated by this executor.

### Executor validation

Previous baseline: 83 passing tests. Added **39 executor tests**: 35 fake-process/
local contract tests and four harmless POSIX Python-child tests. Final complete
suite: **122 passed, 0 failed, 0 skipped** on macOS. The first run had one test-only
path assertion failure (`/var` versus resolved `/private/var`); the assertion now
checks the validated resolved path. No behavior was relaxed to resolve it.

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_cli_executor.py' -k LocalProcessTests -v
```

Mocked tests cover exact payload/arguments, permissions/removal, callback ordering,
preparation/startup/execution/parsing budgets, retry controls, sanitized errors,
conflicts, response validation, output limits, cleanup escalation/failure and
adapter composition. Real local children use only isolated Python: normal exit,
short timeout, SIGTERM ignored with SIGKILL escalation, and output-limit failure.
Direct children are reaped. These tests never invoke AWS CLI or external services;
mocked tests block subprocesses, sockets and AWS/Stripe SDK imports. Real child
programs contain no network or AWS operations. POSIX tests are explicitly skipped
on non-POSIX platforms; none were skipped here.

The controller, adapter, their tests, PROJECT_HANDOFF.md and historical evidence
remain unchanged. Remaining work requires separate authorization: executor review,
then maintained-runner integration, durable authorization, real identity/health
preflight, independent monitoring, evidence persistence and escalation. Browser
gesture capture and human readiness remain separate gates. Hosted duplicate-
activation acceptance remains **NOT PASSED**.

### Executor safety correction — local validation

The post-callback budget check uses the original deadline, with no external I/O,
request preparation or persistence between callback and launch decision. A
callback failure or expired budget prevents launch and removes the protected
input. Callback recording, process launch, AWS receipt and disabled verification
remain distinct. Controller/adapter contracts and the +100-second target /
120-second maximum are unchanged.

Credential validation follows Botocore's selected-profile mapping and merges
shared credentials-file entries over config-file entries, key by key. Config
`[profile name]` (including quoted names) maps to credentials `[name]`; default
is special and is not implicitly inherited. Only the selected profile and its
explicit references are resolved. Shared files necessarily undergo local INI
parsing, and the existing global endpoint/plugin/history prohibition is retained;
unrelated profiles are never used to resolve credentials. No live files were
read during this correction.

The explicit allowlist permits SSO metadata plus region, output, disabled history
and overridden retry settings. Referenced sso-session fields must agree with any
profile duplicates. The SSO account must be the approved DEV account. No role name
or start URL is asserted to prove caller identity: independently verifying the
approved account, principal, session validity and trusted profile installation
remains a runner prerequisite. The validator checks no secrets or cached tokens.
Unknown settings, mixed authentication, missing/cyclic references and unapproved
chains fail closed. DEFAULT inheritance, ambiguous profile mappings, multiline
selected values and unsafe/unreadable paths are deliberately rejected rather
than approximated. Missing default files are allowed only if the selected SSO
profile is otherwise present; explicitly supplied missing files fail closed.

Profile paths are normalized and passed explicitly to the subprocess, but files
are not locked or snapshotted. Changes between validation and CLI reading remain
a risk; this is not atomic validation. Trusted/stable files and executable are
caller obligations. No new credential mechanism or cloud permission is added.

Merge/mapping/SSO behavior was inspected in primary sources:
[Session.full_config](https://raw.githubusercontent.com/boto/botocore/develop/botocore/session.py),
[configloader](https://raw.githubusercontent.com/boto/botocore/develop/botocore/configloader.py),
and [SSOProvider](https://raw.githubusercontent.com/boto/botocore/develop/botocore/credentials.py).
These describe the modeled semantics; the installed AWS CLI was not invoked.

Validation command:

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Previous baseline: **122 passed**. Added **28 tests**, retaining and strengthening
existing tests: **150 passed, 0 failed, 0 skipped** (1.101 seconds). No regression
failure occurred. Counts: 44 controller, 39 adapter, 67 executor (including the
four retained harmless local Python subprocess tests).

Fake-clock assertions prove zero launches at exact expiry and beyond, exactly
one launch one nanosecond before expiry or with ordinary remaining time, preserved
callback events, accurate non-ambiguous pre-launch timeout and input removal.
Credential tests use only temporary synthetic files: legacy/session SSO, merge
precedence, correct profile mapping, helpers in either source or referenced
profiles, unexpected providers, role chains, missing/cyclic references, mixed
credentials, wrong account, session conflicts, unrelated-profile isolation and
sanitized parse/read failures. Fake-process tests block real subprocess/network/
SDK access. The only real processes are isolated Python children without AWS or
network operations. No AWS CLI, AWS/Stripe API, real credential resolution or
hosted scenario was performed.

Disposition: **LOCALLY VALIDATED**. Next recommended assignment: a focused
read-only review of these two corrections before maintained-runner development.
Hosted duplicate-activation acceptance remains **NOT PASSED**. Historical
validation evidence and PROJECT_HANDOFF.md were not changed.

### Profile-header normalization correction — local validation

The earlier literal-space prefix test could ignore a tab-separated definition of
an already selected profile. Config profile and sso-session maps now use the
inspected Botocore `build_profile_map` / `_parse_section` recognition: a raw
kind prefix followed by `shlex.split`, with the second of exactly two tokens as
the name. This covers tabs, multiple spaces, quoted names and unusual prefix
spellings such as `profile-other`. Names remain case-sensitive. Raw INI parsing
continues through `RawConfigParser`; no Botocore dependency was added.

Safety deliberately differs from Botocore's overwrite/ignore behavior: two
config sections with the same normalized name are rejected, even with identical
SSO settings or when unrelated to the selected profile. The special default
profile participates in duplicate detection. Profile and sso-session namespaces
are checked separately. Malformed quoting, wrong token counts and empty names
under either recognized prefix fail closed. These checks finish before dispatch.
Shared credentials section names remain literal; legitimate config/credentials
merging is unchanged and is not treated as a duplicate config definition.

Added 16 synthetic tests covering the original helper bypass in both orders,
tab-only helper profiles, quoted/multiple-space aliases, duplicate permitted
SSO definitions, unusual prefixes, malformed headers, unrelated profiles,
default aliases, cross-file merging and sso-session aliases. A small in-memory
reference of the inspected Botocore mapping checks normalization equivalence for
representative accepted forms; it is not an installed-Botocore integration test.
Every rejection uses explicit zero-launch assertions and sanitized-error checks.
External-I/O tripwires remain active; no helper is executed.

Validation command (unchanged):

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Previous baseline: **150 passed**. Current result: **166 passed, 0 failed,
0 skipped**, in 1.145 seconds: 44 controller, 39 adapter and 83 executor tests.
All four restricted local Python subprocess tests passed. No regression failures
occurred. The corrected post-callback deadline, exact revision/environment,
single-attempt behavior, protected input cleanup and interfaces remain intact.

Remaining limitations are unchanged: local files can change between validation
and CLI reading; trusted installation/profile files and independent caller/session
verification are future runner obligations. This is not atomic validation or
proof of installed CLI/runtime compatibility. OS scheduling and blocked callbacks
still require the previously documented controls.

Disposition: **LOCALLY VALIDATED**. Recommended next action: focused read-only
verification of this normalization correction before maintained-runner work.
No AWS CLI, live credentials, AWS/Stripe operations or hosted scenario were used.
Historical validation records were preserved. Hosted duplicate-activation
acceptance remains **NOT PASSED**.

## Runner Phase 1A — local orchestration foundation

`runner.py` is a library-only, one-use simulation orchestrator. It imports no
controller, transport, executor or cloud SDK and has no executable entry point,
CLI, live mode, admission enablement or Pay-instruction API. Existing controller,
adapter and executor interfaces are unchanged. This phase does not integrate them.

The normal lifecycle is `NOT_STARTED → PREFLIGHT_PENDING → READY → ACTIVE →
CLEANUP_REQUIRED → COMPLETED`. Stop from any pre-cleanup state enters
`STOP_REQUESTED`, then `CLEANUP_REQUIRED`. Cleanup runs once even after a stop or
exception, including a stop before preflight; fakes must tolerate partial setup.
A stop or critical failure ends in `FAILED`, never `COMPLETED`. A noncritical
stop returns outcome `STOPPED` without raising; a critical failure raises. This
uses the existing terminal states while distinguishing cancellation in the outcome.
A late stop may invalidate `COMPLETED` to `FAILED`; failure cannot transition
back to success. Invalid
transitions and reuse raise explicitly. `READY` is a simulation transition, not
operator readiness or authorization.

One sticky `threading.Event` subclass is shared with all callbacks. `set()` records
a component stop, `clear()` raises, and the public signal cannot be replaced.
Stop reasons are deduplicated nonsecret codes; the first critical reason is
retained under concurrent requests. State, phase claims, callback-entry admission
and stop requests share one lock. A claim is pending work, not entry permission.
Both preflight and active callbacks pass through `_admit_entry` after claiming.
The linearization point is the entry record appended under that lock after
checking stop; stop latches its Event and records its reason under the same lock.
If stop completes first, the pending callback is not admitted or invoked. Cleanup
intentionally bypasses the entry gate and runs once even when stop is set.

If entry admission wins first, that callback is in flight. The lock is released
before arbitrary callback execution, allowing responsive stop handling. Scheduling
can delay the first instruction of user callback code until after a later stop;
the admitted callback must observe the Event before further work. Entry admission
is not the exact instruction where user code starts, hard real-time cancellation,
or safe live Pay publication. Holding the lock throughout a callback would block
stop handling and is deliberately avoided.

`Runner` requires explicit `SimulationSteps(preflight, active, cleanup)` fakes.
Every callback receives the same stop signal and must return `None`; returned
configuration or verification data is rejected. These are trusted local Python
callbacks, not a sandbox capable of proving arbitrary injected code is harmless.
There are no default live dependencies or temporary live bypasses. Cleanup also
receives the latched signal on normal completion, closing further activity.

Reports are immutable in-memory snapshots, not durable authorization or current
monitor state. `SIMULATED_COMPLETED` and `STOPPED` describe orchestration only;
`relock_verified`, `hosted_authorized` and `pay_instruction_issued` remain false.
Critical failures raise `RunnerFailure` with the sanitized report. The original
exception remains its cause and `RunnerFailure.primary_exception`, even if
cleanup subsequently fails. `RunnerFailure.secondary_exceptions` is an immutable
tuple retaining secondary cleanup exception objects, including their tracebacks.
These fields are trusted local diagnostics, separate from the sanitized public
report; never serialize them or display their tracebacks without sanitization.
The first critical reason remains authoritative. If a critical stop precedes the
first Python exception in cleanup, that exception becomes `primary_exception`
(the first exception), while the original stop remains `report.primary_failure`.
Cleanup failure always prevents successful completion. Later critical
reports invalidate the current state but cannot rewrite previously returned
snapshots.

### Phase 1A validation

Before editing, local `main` was clean at
`1535cd4ae838f86459b6f4a5187a1ccf2b87612c`, with the existing harness tracked.
Post-merge CI run
[37994477310](https://github.com/useffj/batch-and-batter/actions/runs/37994477310)
completed successfully for that commit: `validate`, `validate-backend` and
`validate-infra` passed. This CI result is separate from the local Python suite.

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Initial Phase 1A result (before the corrections below): **196 passed, 0 failed, 0 skipped** in 1.135 seconds:
**166 existing tests + 30 runner tests**. Runner tests use injected fakes, a
controllable simulation counter, and event/barrier synchronization rather than
sleeps. The runner makes no time-based decisions and adds no second deadline
clock. Thread synchronization has bounded failure timeouts. Tests cover lifecycle
transitions, sticky/concurrent stops, first-failure preservation, exception and
cleanup failures, one-use execution, immutable reports, denied live-shaped inputs,
and absence of Pay/admission APIs. Network, subprocess and SDK tripwires guard
runner tests. The existing suite retains its four harmless local Python process
tests; no AWS CLI, AWS/Stripe operation or hosted execution occurred.

### Unimplemented integration requirements

Hosted execution remains prohibited. A subsequent authorized integration must
provide the actual verified-enablement timestamp handoff to one authoritative
relock controller, durable single-window authorization, independent monitoring
and monitor-health checks, critical escalation, protected evidence persistence,
guarded disabled-state verification, operator readiness, and safe Pay-instruction
publication/revocation. Phase 1A supplies none of these live controls. Indefinitely
blocked callbacks cannot be recovered by this synchronous runner; independent
safety monitoring remains necessary. No simulation cleanup result proves relock.

Disposition: **LOCALLY VALIDATED**. Next action: focused read-only review of
Runner Phase 1A and its stop/cleanup contract before separately authorizing
Runner Phase 1B. Hosted duplicate-activation acceptance remains **NOT PASSED**.

### Runner Phase 1A targeted corrections — local validation

Corrected the pending-claim versus callback-entry stop race and preservation of
secondary cleanup diagnostics. The existing same-thread test is now correctly
named as reentrancy coverage. Added 11 test methods: four controlled entry races
(preflight/active, stop-first/entry-first), two genuinely concurrent one-use tests
(success/failure), four diagnostic-preservation cases, and a noncritical-stop
terminal-state assertion. Entry-race tests assert actual callback counts and
admission records, sticky primary failure, exactly one cleanup, and no retries.
The competing-start tests synchronize two threads and keep the winning execution
active until the losing call is rejected. Existing blocked-callback tests retain
coverage of responsive stop handling.

Fresh full-suite command:

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Result: **207 passed, 0 failed, 0 skipped**, in 1.138 seconds:
**166 unchanged controller/adapter/executor tests + 41 runner tests**. Previous
baseline was 196. All tests remained local: runner callbacks are fakes with
external-I/O tripwires, bounded Event/barrier waits and no arbitrary sleeps.
Synthetic secret markers are absent from public reports; original and secondary
exception identities remain accessible to trusted callers. No AWS CLI, AWS/Stripe
API or hosted operation occurred. No existing component interface changed.

Disposition: **LOCALLY VALIDATED**, pending focused read-only review of these
corrections before Phase 1B scoping. Independent monitoring, protected persistence
and the other integration obligations above remain unimplemented. Hosted
duplicate-activation acceptance remains **NOT PASSED**.

## Phase 1B-1A — durable local authorization store

`authorization.py` is a separate standard-library SQLite component. It is not
connected to Runner, AdmissionWindow, the transport or the CLI executor. It cannot
issue Pay instructions, create fixtures in the application, change admission or
verify AWS state. No cloud service, dependency or recurring cost is added.

Callers supply an absolute designated database path and expected store/host IDs.
The parent must already exist with owner-only `0700` permissions. `initialize()`
is a distinct exclusive-create operation; ordinary operations use SQLite
`mode=rw` and never recreate a missing database. Initialization failures leave any
created file for inspection rather than deleting/replacing it. The stored IDs
are caller-supplied identity labels, not hardware attestation or human approval.

The default storage policy supports Darwin local APFS/HFS volumes, checked using
`statfs` (Darwin's `statvfs` does not retain the needed local-volume flag). Other
platforms/filesystems fail closed. A trusted injected storage policy is available
for separately reviewed environments; it must not misrepresent unsupported
storage as safe. Symlink ancestors/files, hard-linked databases, wrong ownership,
non-`0600` database/auxiliary files, non-`0700` parent directories and WAL/SHM
artifacts are rejected. This is a designated single-host filesystem contract,
not cross-host exclusion. Another machine or independently initialized database
is outside the guarantee. Stable trusted paths are required: checks do not prevent
a privileged/owning user replacing files between validation and SQLite access.
Synced-folder replication and malicious storage rollback are not detected reliably.

Schema version 1 contains:

- `metadata`: singleton schema version and persistent store/host identity.
- `authorizations`: ID, scope digest, resource key, consumption, execution ID and
  latest transition sequence; store/host/schema identity is inherited through the
  single store metadata record.
- `executions`: unique execution and authorization IDs, unique resource, owner
  instance label, `CLAIMED` state and sequence.
- `ownership`: exclusive resource-to-execution mapping.
- `events`: ordered `PROVISIONED` and `CLAIMED` transitions.

`provision_test_fixture()` is explicitly for synthetic local authorizations.
`claim()` only consumes an existing matching record; it never issues authorization.
A scope digest binds declared scope but does not prove human approval. No live
issuance mechanism exists. Caller-provided IDs/digests must remain nonsecret.

Each operation opens and closes its own connection. Claims use `BEGIN IMMEDIATE`,
foreign keys, unique constraints, rollback journaling, `synchronous=FULL` and
Darwin full-fsync support. Lock waits are bounded to 250 ms; there is no application
retry. Schema definitions, metadata, SQLite integrity, foreign keys and record/
event consistency are validated under the transaction. Consumption, execution,
ownership and claim event commit together. No arbitrary callback or external
operation runs within that transaction. Initialization also synchronizes the
parent directory after creation. Durability still depends on filesystem/hardware
honoring synchronization; local tests do not simulate physical power loss.

Claims survive connection closure, restart and owner death. No PID, lease,
heartbeat or wall-clock timeout releases ownership. **Authorization release and
verified closure are NOT IMPLEMENTED.** Consumption is permanent through this API;
claimed resources remain blocked. There is no `CLOSED_DISABLED` transition,
external recovery evidence or automatic replacement authorization.

Failures return sanitized codes. Missing/corrupt/incompatible stores, identity or
scope mismatches, malformed/ambiguous state and storage failures deny claims.
Transaction/commit errors report uncertain outcome: a caller must reopen and
inspect, never assume that failure means unconsumed. No deletion, reset or repair
is attempted. A commit acknowledged as failed after actually committing leaves
consumption and ownership intact. Public inspection returns only the synthetic
record model, not exception messages or configuration payloads. This is not the
Phase 1B evidence exporter or a tamper-proof audit log.

### Phase 1B-1A validation

Work branch: `codex/authorization-store-1b-1a`, based on reviewed main commit
`1535cd4ae838f86459b6f4a5187a1ccf2b87612c`. Existing Runner 1A files are preserved.

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Fresh result: **237 passed, 0 failed, 0 skipped**, in 2.325 seconds:
**207 existing tests + 30 authorization tests**. Tests cover explicit creation,
reopen/missing-store behavior, scope/identity/schema rejection, once-only claims,
thread contention, independent spawned-process contention, abrupt process exit
after commit, restart, resource contention across distinct authorizations,
rollback before commit and ambiguous failure after commit, busy handling,
permissions/ownership, symlinks/hardlinks, corruption and inconsistent sequences.
Concurrency assertions require one winner, one persisted execution and one owner;
children use bounded synchronization and are joined or terminated on test exit.
Only harmless local Python children are used. Network operations are blocked in
authorization tests; no AWS CLI, AWS/Stripe operation or hosted execution occurred.
Early targeted runs exposed a temporary-path alias and the Darwin `statvfs` flag
limitation; these were corrected before the successful full-suite run.

Disposition: **LOCALLY VALIDATED**, pending focused read-only review of storage,
claim atomicity, fail-closed behavior and crash semantics. Closure, monitoring,
escalation providers and live integration remain excluded. Hosted duplicate-
activation acceptance remains **NOT PASSED**.

### Phase 1B-1A allocator integrity correction

The earlier validator checked committed event rows but omitted SQLite's persisted
`sqlite_sequence` allocator. An isolated pre-correction reproduction changed the
counter from 1 to 100: SQLite integrity checking passed, a claim returned success
with event 101, and the next read failed with `AMBIGUOUS_SEQUENCE`.

The application invariant is consecutive event IDs `1..N`. This is supported by
its existing append-only writes: one automatically numbered event per transaction,
no event deletion, no conflict-ignore insertion, and whole-transaction rollback
on failure. SQLite AUTOINCREMENT by itself does **not** universally promise
consecutive IDs. Future write paths must preserve this application contract or
seek a separately reviewed design change.

Validation now inspects all `sqlite_sequence` rows. A pristine empty store has
none. A nonempty store requires exactly one row named `events`, with SQLite
integer storage type and an integer counter equal to N within signed 64-bit
positive range. Missing, duplicate, unexpected, null, negative, noninteger, low
or high counters fail with `AMBIGUOUS_ALLOCATOR`. A row containing zero in an
empty store is also rejected: no approved successful write path produces it.
A failed first provisioning transaction restores the absent allocator row.
No repair, normalization, counter reset or deletion is attempted.

Provisioning and claims validate both before mutation and after mutation, before
commit, on the same connection and within the same `BEGIN IMMEDIATE` transaction.
Post-mutation failure rolls back events, allocator changes, authorization state,
execution and ownership together. Commit uncertainty remains conservative;
exceptions after a real commit do not establish rollback. Schema version 1 and
all existing component interfaces remain unchanged; no migration is required.

Validation command:

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Fresh result: **244 passed, 0 failed, 0 skipped**, in 2.746 seconds. Added seven
allocator test methods, several with multiple corruption cases, to the prior
237-test baseline. Coverage includes the original bypass, low/missing/duplicate/
unexpected metadata, invalid types, null/negative and integer-boundary values,
empty-store validation, valid sequence progression, provisioning rejection,
reopen rejection, and post-mutation rollback in both write paths. Raw before/after
snapshots include every application table and `sqlite_sequence`, demonstrating
no added consumption, execution, ownership or event and no counter repair on
rejection. The integer-maximum corruption case is tested against a small store;
no claim is made to construct a store with 2^63-1 events.

All existing thread/process, crash/restart, ambiguous-commit and component tests
passed. No external service or real project database was used. The documented
single-host, trusted-path and physical-durability limitations remain unchanged.
Disposition: **LOCALLY VALIDATED**, pending focused read-only correction review
before recovery/closure scoping. No release, closure or monitoring was added.
Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Phase 1B-1B-A — synthetic closure-evidence evaluator

`closure_evidence.py` is a pure standard-library evaluator, independent of Runner,
SQLite and external transports. It has no executable entry point, ownership
release, live authorization, AWS/Stripe access or monitoring functionality.

Frozen typed records model `ExecutionInventory`, `OperationIntent`,
`OperationResolution`, `ParticipantQuiescence`, `DisabledObservation`,
`ControllerResult`, `CleanupDisposition` and `EvaluationRequest`. Every record carries an evidence ID,
schema version 1, a `synthetic:` source label, execution/resource/authorization
bindings, scope digest, execution version and positive causal sequence. Collection
fields must be immutable tuples of unique identifiers. Configuration evidence uses
synthetic identity/digest/revision labels rather than raw configuration payloads.
Integer fields (`schema_version`, `execution_version`, `sequence` and `cutoff`)
require actual integers, excluding booleans, in `1..2^63-1`; schema version is
further restricted to exactly 1. Unsupported values, including `10**5000`, are
rejected before digest serialization without conversion, clamping or input echo.

The request is the declared expected context. All supplied records must match it;
no wrong-execution, wrong-resource, stale-version or post-cutoff record is silently
ignored. Exactly one inventory, observation, controller result and cleanup record is required.
Intent/resolution identities must exactly cover the inventory, and each intent
must have one matching, later resolution. Only FINAL COMPLETED/TERMINAL_RESULT or
FINAL NOT_DISPATCHED/DISPATCH_PREVENTED declarations satisfy operation resolution.
Unknown, timeout, process-death or potentially delayed outcomes block eligibility.
These labels describe synthetic facts; the evaluator does not independently prove
that dispatch was prevented or an external result was terminal.

Every declared participant needs one quiescence record: authority REVOKED, work
ACCOUNTED, no pending operations and exact references to its resolved operations.
Quiescence follows those resolutions. The inventory cutoff equals the inventory's
sequence, and all intents, resolutions and quiescence precede it. The disabled
observation follows the cutoff, reconciliation and quiescence, referencing their
exact evidence IDs; it must match the requested configuration identity/digest,
include a nonempty revision, and declare SUCCESSFUL update state and DISABLED
admission. A typed `ControllerResult` references that exact observation and follows
it. Its disposition is DISABLED_VERIFIED with no critical codes, or
CRITICAL_DISABLED_VERIFIED with nonempty historical critical codes. Cleanup must
resolve `controller_result_ref` to this actual typed record in the supplied evidence
set, follow it, reference the same observation and declare RESOLVED responsibility.
Missing, incompatible, self-referential, conflicting or ambiguous result references
block eligibility. The controller record shares every request binding, including
execution, resource, authorization, scope, version and synthetic source.

The request follows all evidence. For example: intent 1, resolution 2, quiescence 3,
inventory/cutoff 4, observation 5, controller result 6, cleanup 7, request 8.
Distinct records cannot share a sequence number. No wall-clock comparison or
cross-process monotonic-clock inference is used. Typed reference resolution proves
only internal synthetic consistency, not authenticated live controller provenance
or actual AWS disabled state. Revision labels also remain synthetic declarations.

Results are `SYNTHETIC_ELIGIBLE` or `SYNTHETIC_BLOCKED`, with sorted blocking codes,
execution identity/version, a deterministic SHA-256 consistency reference and
historical critical codes combined from controller and cleanup records. Malformed inputs return a generic blocked result without
reflecting their payloads. Historical critical failures can remain present in an
eligible synthetic result; there is no acceptance-PASSED or release-authority field.
Inputs must contain synthetic nonsecret identifiers, never customer or payment data.

Identical evidence IDs/content are idempotent within an evaluation; conflicting
content is rejected. The digest is input-order independent and ignores identical
duplicate records, while including conflicting records. Tuple ordering remains
part of record content. A digest is not a signature or proof of provenance. The
stateless evaluator provides no durable replay prevention, no proof of current
execution version beyond the request, and no proof that undisclosed operations or
participants do not exist. Caller-supplied synthetic declarations establish only
internal consistency, never independently trustworthy live safety.

### Phase 1B-1B-A validation

Verified clean main at `8ab68f3da7306071e8f3f833d44023821212cd32`, merged PR #52,
and successful post-merge CI run
[38000667774](https://github.com/useffj/batch-and-batter/actions/runs/38000667774)
(all three jobs) before creating `codex/synthetic-closure-evidence-1b-1b-a`.

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

Initial local result: **268 passed, 0 failed, 0 skipped**, in 2.781 seconds:
244 existing tests plus 24 evaluator tests. Tests assert eligible and blocked
statuses and specific reasons, inventory completeness, bindings, participant
quiescence, delayed/unknown operations, causal references, malformed evidence,
duplicate/conflicting records, historical failure preservation, deterministic
results and unchanged inputs. Evaluator tests block SQLite connections, file opens,
network and subprocess operations and SDK imports. Existing approved local child
process tests remain separate. No AWS/Stripe or hosted operations occurred.

Disposition: **LOCALLY VALIDATED**, pending focused read-only evaluator review.
No existing component contract or SQLite schema changed. Atomic closure, release,
monitoring and live integration remain unimplemented. Hosted duplicate-activation
acceptance remains **NOT PASSED**.

### Phase 1B-1B-A reference and integer corrections

The original evaluator accepted a nonempty controller-result label without resolving
it, and allowed integers large enough to fail JSON serialization. The typed record
and pre-serialization bounds above correct both defects without changing existing
controller, runner or authorization-store contracts.

Fresh full-suite result using the same command: **277 passed, 0 failed, 0 skipped**,
in 2.745 seconds. Nine added test methods cover the original unrelated/self/request
reference bypasses, missing and incompatible records, every controller binding,
causal order, conflicting identities, identical duplicates, historical critical
codes and binding-sensitive deterministic digests. Numeric tests enumerate every
integer field across all evidence types and the request, checking zero, negative,
boolean, maximum-plus-one and `10**5000` inputs. They assert sanitized blocked
results, repeatability and input immutability. A valid maximum-boundary fixture
retains eligibility and a deterministic digest; schema version remains exactly 1.
All 268 preceding tests passed. No external services or hosted operations were used.

Disposition: **LOCALLY VALIDATED**, pending focused read-only correction review.
Synthetic eligibility grants no live authorization. SQLite closure, ownership
release, durable replay protection, monitoring and live integration remain excluded.
Hosted duplicate-activation acceptance remains **NOT PASSED**.
