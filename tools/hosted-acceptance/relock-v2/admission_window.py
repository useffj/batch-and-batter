"""Version 2 relock controller. No cloud client, CLI, credentials, or live entry point.

The separately reviewed caller owns authorization, preflight, enablement and the
independent health/commerce monitor. See README.md for the adapter contract.
"""

from base64 import b64decode
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import datetime, timezone, timedelta
from threading import Event
from time import monotonic_ns
from typing import Callable, Protocol

NS = 1_000_000_000
TARGET_NS = 100 * NS
HARD_LIMIT_NS = 120 * NS
CLEANUP_NS = 100 * NS
MAX_DISPATCHES = 3
FUNCTION = "batch-and-batter-dev-api"
API_SHA256 = "57a4c98fd6e773bd4b31aa53e248b0151376a85ea7640bb759f613ce5f4f5205"
SANDBOX = "acct_1UL8LdDz3QSwRsAl"
LEDGER_NAMESPACE = "dev:acct_1UL8xeDXKfaUH9bm"
VOLATILE = {
    "RevisionId", "LastModified", "LastUpdateStatus", "LastUpdateStatusReason",
    "LastUpdateStatusReasonCode", "State", "StateReason", "StateReasonCode",
}


@dataclass(frozen=True)
class Stamp:
    monotonic_ns: int
    utc: str


@dataclass(frozen=True)
class VerifiedEnablement:
    configuration: dict
    revision_id: str
    verified_at: Stamp


class Clock(Protocol):
    def stamp(self) -> Stamp: ...
    def now_ns(self) -> int: ...
    def wait(self, stop: Event, seconds: float) -> None: ...


class SystemClock:
    def stamp(self) -> Stamp:
        # Read monotonic first: UTC is a correlation aid, never a deadline clock.
        return Stamp(monotonic_ns(), datetime.now(timezone.utc).isoformat())

    def now_ns(self) -> int:
        return monotonic_ns()

    def wait(self, stop: Event, seconds: float) -> None:
        stop.wait(seconds)


class DisableTransport(Protocol):
    def dispatch_disable(
        self, request: dict, timeout_seconds: float, on_dispatch: Callable[[], None]
    ) -> None:
        """No configuration reads or hidden retries. Call on_dispatch exactly once
        immediately before the actual update invocation; apply RevisionId CAS.
        The callback marks local invocation, NOT service acceptance or completion.
        Honor timeout_seconds. A failed/ambiguous invocation raises.
        """
        ...

    def read_configuration(self, timeout_seconds: float) -> dict:
        """Honor timeout_seconds; return a fresh complete configuration."""
        ...


class CriticalRelockFailure(RuntimeError):
    def __init__(self, report: dict):
        super().__init__("CRITICAL: relock or deadline verification failed; inspect report")
        self.report = report


def guard(current: dict, baseline: dict, flag: str, *, ready: bool = True) -> None:
    """Preserve the reviewed full configuration, code and exact identity values."""
    stable = lambda c: {k: v for k, v in c.items() if k not in VOLATILE | {"Environment"}}
    expected = deepcopy(baseline["Environment"])
    expected["Variables"]["PAYMENT_START_ENABLED"] = flag
    if stable(current) != stable(baseline) or current["Environment"] != expected:
        raise ValueError("Configuration differs from approved baseline")
    if not current.get("RevisionId"):
        raise ValueError("Missing revision guard")
    if ready and (current.get("State") != "Active" or current.get("LastUpdateStatus") != "Successful"):
        raise ValueError("Configuration not successfully applied")


class AdmissionWindow:
    """One-use controller; external monitor sets stop for every existing stop rule.

    No browser actions are implemented. instructions_allowed is a necessary
    revocable gate for a future caller, not a readiness or payment authorization.
    Reports stay in memory so artifact writes cannot delay dispatch or cleanup.
    """

    def __init__(self, baseline: dict, transport: DisableTransport,
                 stop: Event, clock: Clock | None = None):
        self.baseline = deepcopy(baseline)
        guard(self.baseline, self.baseline, "false")
        env = self.baseline["Environment"]["Variables"]
        if (self.baseline["FunctionName"] != FUNCTION
                or self.baseline.get("FunctionArn") !=
                "arn:aws:lambda:us-east-2:302154194958:function:" + FUNCTION
                or b64decode(self.baseline["CodeSha256"]).hex() != API_SHA256
                or env.get("STRIPE_ACCOUNT_ID") != SANDBOX
                or env.get("STRIPE_LEDGER_ACCOUNT_ID") != SANDBOX
                or env.get("STRIPE_LEDGER_NAMESPACE") != LEDGER_NAMESPACE):
            raise ValueError("Baseline outside accepted DEV identity/artifact scope")
        self.transport = transport
        self.stop = stop
        self.clock = clock or SystemClock()
        self.events: list[dict] = []
        self.errors: list[str] = []
        self.enabled: Stamp | None = None
        self.disabled: Stamp | None = None
        self.cached: dict | None = None
        self.closed = True
        self.used = False
        self.dispatches = 0

    def record(self, name: str, stamp: Stamp | None = None, **fields) -> Stamp:
        stamp = stamp or self.clock.stamp()
        self.events.append({"event": name, **asdict(stamp), **fields})
        return stamp

    def fail(self, code: str) -> None:
        # Exception messages may contain payloads/credentials. Retain codes only.
        if code not in self.errors:
            self.errors.append(code)

    def instructions_allowed(self) -> bool:
        return bool(self.enabled and not self.closed and not self.stop.is_set()
                    and self.clock.now_ns() < self.enabled.monotonic_ns + TARGET_NS)

    def report(self) -> dict:
        return {
            "version": 2,
            "result": "CRITICAL" if self.errors or self.disabled is None else "DISABLED_VERIFIED",
            "disabled_verified": self.disabled is not None,
            "instructions_allowed": self.instructions_allowed(),
            "target_seconds": 100,
            "hard_limit_seconds": 120,
            "errors": list(self.errors),
            "events": deepcopy(self.events),
            "verification_boundary": "Successful full configuration readback; not in-flight drainage",
        }

    def run(self, enable_and_verify: Callable[
            [Callable[[dict], VerifiedEnablement]], VerifiedEnablement]) -> dict:
        """Callback calls complete_verification(fresh_configuration) immediately
        upon successful readback, before persistence or other work, and returns
        that exact handoff. It must use this controller-supplied recorder, never
        a timestamp from another process/clock. The recorder validates the full
        configuration, stamps completed verification, and retains cleanup state.
        """
        if self.used:
            raise ValueError("Only one admission window allowed")
        self.used = True
        issued = None
        callback_active = True
        callback_start = self.clock.now_ns()

        def validate_stamp(stamp):
            if (not isinstance(stamp, Stamp)
                    or type(stamp.monotonic_ns) is not int
                    or not callback_start <= stamp.monotonic_ns <= self.clock.now_ns()
                    or not isinstance(stamp.utc, str)):
                raise ValueError("Invalid verification timestamp")
            utc = datetime.fromisoformat(stamp.utc)
            if utc.utcoffset() != timedelta(0):
                raise ValueError("Verification audit timestamp must be UTC")

        def complete_verification(configuration):
            nonlocal issued
            try:
                if not callback_active or issued is not None:
                    raise ValueError("Verification may only complete once during callback")
                live = deepcopy(configuration)
                guard(live, self.baseline, "true")
                revision = live["RevisionId"]
                if not isinstance(revision, str) or not revision.strip():
                    raise ValueError("Invalid verified revision")
                observed = self.clock.stamp()
                validate_stamp(observed)
                # Retain independent state now, even if callback later raises or
                # tampers with its returned handoff. Never fabricate a revision.
                self.cached = deepcopy(live)
                self.enabled = observed
                issued = VerifiedEnablement(live, revision, observed)
                self.record("enabled_verified", observed,
                            scheduled_relock_ns=observed.monotonic_ns + TARGET_NS,
                            hard_deadline_ns=observed.monotonic_ns + HARD_LIMIT_NS)
                return issued
            except BaseException:
                self.fail("INVALID_VERIFICATION_HANDOFF")
                raise

        try:
            if self.stop.is_set():
                raise ValueError("Stopped before enablement")
            handoff = enable_and_verify(complete_verification)
            callback_active = False
            # Object provenance rejects external clock domains, stale windows,
            # and reconstructed/serialized timestamps rather than normalizing.
            if (issued is None or handoff is not issued
                    or handoff.configuration != self.cached
                    or handoff.revision_id != self.cached["RevisionId"]
                    or handoff.verified_at != self.enabled):
                self.fail("INVALID_VERIFICATION_HANDOFF")
                raise ValueError("Missing or inconsistent verification handoff")
            validate_stamp(handoff.verified_at)
            if self.errors:
                raise ValueError("Verification previously failed")
            self.closed = False
            while self.instructions_allowed():
                remaining = self.enabled.monotonic_ns + TARGET_NS - self.clock.now_ns()
                self.clock.wait(self.stop, max(0, remaining) / NS)
        except BaseException:
            self.fail("ENABLE_OR_CONTROLLER_FAILURE")
        finally:
            callback_active = False
            self.closed = True
            if (self.enabled is not None
                    and self.clock.now_ns() >= self.enabled.monotonic_ns + HARD_LIMIT_NS):
                self.fail("DISPATCH_DEADLINE_MISSED")
            self.stop.set()  # Invalidates instructions even if cleanup fails.
            try:
                self._relock()
            except BaseException:
                self.fail("CLEANUP_EXCEPTION")
        report = self.report()
        if report["result"] == "CRITICAL":
            raise CriticalRelockFailure(report)
        return report

    def _relock(self) -> None:
        entry = self.record("relock_entry")
        end = entry.monotonic_ns + CLEANUP_NS
        config = self.cached

        def budget() -> float:
            return min(10.0, max(0, end - self.clock.now_ns()) / NS)

        while self.clock.now_ns() < end:
            if config is not None:
                flag = config["Environment"]["Variables"].get("PAYMENT_START_ENABLED")
                guard(config, self.baseline, flag, ready=False)
                if flag not in ("true", "false"):
                    raise ValueError("Unknown admission state")
                if config.get("State") != "Active" or config.get("LastUpdateStatus") == "Failed":
                    self.fail("CONFIGURATION_NOT_READY")
                elif config.get("LastUpdateStatus") == "Successful":
                    if flag == "false":
                        self.disabled = self.record("disabled_verified")
                        return
                    if self.dispatches >= MAX_DISPATCHES:
                        self.fail("DISABLE_ATTEMPTS_EXHAUSTED")
                        break
                    # First iteration uses the verified-enabled snapshot. No
                    # blocking configuration read occurs before initial dispatch.
                    request = {
                        "FunctionName": self.baseline["FunctionName"],
                        "RevisionId": config["RevisionId"],
                        "Environment": deepcopy(self.baseline["Environment"]),
                    }
                    self.dispatches += 1
                    called = False

                    def on_dispatch():
                        nonlocal called
                        if called:
                            raise ValueError("Hidden transport retry")
                        called = True
                        stamp = self.record("disable_update_dispatch", attempt=self.dispatches)
                        if self.enabled is not None:
                            elapsed = stamp.monotonic_ns - self.enabled.monotonic_ns
                            self.events[-1]["elapsed_from_enable_ns"] = elapsed
                            # Intentionally conservative: dispatch must be BEFORE
                            # the limit, not merely enter cleanup at the limit.
                            if elapsed >= HARD_LIMIT_NS:
                                self.fail("DISPATCH_DEADLINE_MISSED")

                    try:
                        self.transport.dispatch_disable(request, budget(), on_dispatch)
                        if not called:
                            self.fail("DISPATCH_NOT_RECORDED")
                    except BaseException:
                        # Failure never becomes a passing run even if recovery
                        # subsequently verifies false. Do not expose raw errors.
                        self.fail("DISABLE_UPDATE_FAILED")
                    config = None
            if self.clock.now_ns() >= end:
                break
            try:
                config = self.transport.read_configuration(budget())
            except BaseException:
                self.fail("DISABLED_READ_FAILED")
                config = None
            if self.clock.now_ns() >= end:
                break
            # Validate a fresh false result on the next iteration without delay.
            if config is not None and config.get("LastUpdateStatus") == "Successful":
                continue
            # The scenario stop must NOT skip cleanup waits or verification.
            self.clock.wait(Event(), min(1.0, max(0, end - self.clock.now_ns()) / NS))
        self.fail("DISABLED_NOT_VERIFIED")
