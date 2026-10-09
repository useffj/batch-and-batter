"""Local Lambda DisableTransport adapter; no client, credentials or live entry point."""

from base64 import b64decode
from copy import deepcopy
from dataclasses import dataclass
import math
from time import monotonic_ns
from typing import Callable, Protocol

from admission_window import API_SHA256, FUNCTION, LEDGER_NAMESPACE, NS, SANDBOX, guard


class TransportContractError(ValueError):
    """Malformed request or untrustworthy operation response; never verification."""


@dataclass(frozen=True)
class OperationBudget:
    """One absolute deadline shared with the executor; never reset per retry/read.

    The executor must check remaining_seconds at entry (before external I/O),
    enforce that total remaining budget, and make only one attempt. This object
    does not interrupt blocked Python code. Late returns are rejected separately.
    """
    deadline_ns: int
    now_ns: Callable[[], int]

    def remaining_seconds(self) -> float:
        remaining = self.deadline_ns - self.now_ns()
        if remaining <= 0:
            raise TimeoutError("Operation budget exhausted; outcome may be ambiguous")
        return remaining / NS


class LambdaExecutor(Protocol):
    def update_function_configuration(self, parameters: dict, *,
                                      budget: OperationBudget, max_attempts: int,
                                      on_dispatch: Callable[[], None]) -> dict:
        """Invoke Lambda UpdateFunctionConfiguration once, with bounded total time.

        Prepare arguments/protected input first, then check the original budget.
        Call on_dispatch exactly once immediately before the local invocation.
        Callback failure must prevent launch. No reads, persistence, retries or
        unrelated blocking work may intervene between callback and invocation.
        Return the complete configuration response, without SDK ResponseMetadata.
        Errors/conflicts/ambiguous outcomes must raise, never retry automatically.
        """
        ...

    def get_function_configuration(self, parameters: dict, *,
                                   budget: OperationBudget, max_attempts: int) -> dict:
        """Fresh Lambda GetFunctionConfiguration, not a cached update response.

        Same bounded, single-attempt contract; return complete configuration.
        """
        ...


class LambdaDisableTransport:
    def __init__(self, baseline: dict, executor: LambdaExecutor,
                 now_ns: Callable[[], int] = monotonic_ns):
        self._baseline = deepcopy(baseline)
        self._executor = executor
        self._now_ns = now_ns
        self._validate_configuration(self._baseline, "false")
        guard(self._baseline, self._baseline, "false")
        env = self._baseline["Environment"]["Variables"]
        if (self._baseline["FunctionName"] != FUNCTION
                or self._baseline["FunctionArn"] !=
                "arn:aws:lambda:us-east-2:302154194958:function:" + FUNCTION
                or b64decode(self._baseline["CodeSha256"]).hex() != API_SHA256
                or env.get("STRIPE_ACCOUNT_ID") != SANDBOX
                or env.get("STRIPE_LEDGER_ACCOUNT_ID") != SANDBOX
                or env.get("STRIPE_LEDGER_NAMESPACE") != LEDGER_NAMESPACE):
            raise TransportContractError("Baseline outside approved identity/artifact")

    def _budget(self, seconds: float) -> OperationBudget:
        start = self._now_ns()
        try:
            if (type(seconds) not in (int, float) or not math.isfinite(seconds)
                    or seconds <= 0):
                raise ValueError()
            # Round down, never extend the caller's allowance.
            duration = int(seconds * NS)
        except (ValueError, OverflowError):
            raise TransportContractError("Timeout must be finite and positive") from None
        if duration <= 0:
            raise TransportContractError("Timeout below clock resolution")
        return OperationBudget(start + duration, self._now_ns)

    @staticmethod
    def _revision(value):
        if not isinstance(value, str) or not value.strip():
            raise TransportContractError("Missing or malformed revision")

    def _validate_configuration(self, config: dict, expected_flag=None):
        try:
            if not isinstance(config, dict):
                raise ValueError()
            self._revision(config["RevisionId"])
            if config["State"] not in ("Pending", "Active", "Inactive", "Failed"):
                raise ValueError()
            if config["LastUpdateStatus"] not in ("InProgress", "Successful", "Failed"):
                raise ValueError()
            variables = config["Environment"]["Variables"]
            if not isinstance(variables, dict) or any(
                    not isinstance(k, str) or not isinstance(v, str)
                    for k, v in variables.items()):
                raise ValueError()
            flag = variables["PAYMENT_START_ENABLED"]
            if flag not in ("true", "false") or (expected_flag is not None and flag != expected_flag):
                raise ValueError()
            # Retain the controller's exact full-configuration comparison.
            guard(config, self._baseline, flag, ready=False)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise TransportContractError("Incomplete or inconsistent configuration") from None

    def dispatch_disable(self, request: dict, timeout_seconds: float,
                         on_dispatch: Callable[[], None]) -> None:
        budget = self._budget(timeout_seconds)
        parameters = deepcopy(request)
        if (not isinstance(parameters, dict)
                or set(parameters) != {"FunctionName", "RevisionId", "Environment"}
                or parameters["FunctionName"] != self._baseline["FunctionName"]
                or parameters["Environment"] != self._baseline["Environment"]
                or not callable(on_dispatch)):
            raise TransportContractError("Invalid admission-only disable request")
        self._revision(parameters["RevisionId"])
        invoke = self._executor.update_function_configuration
        budget.remaining_seconds()
        active, called, completed, invalid = True, False, False, False

        def record_dispatch():
            nonlocal called, completed, invalid
            if not active or called:
                invalid = True
                raise TransportContractError("Duplicate or out-of-scope dispatch callback")
            called = True
            try:
                budget.remaining_seconds()
                on_dispatch()
            except BaseException:
                invalid = True
                raise
            completed = True

        try:
            response = invoke(parameters, budget=budget, max_attempts=1,
                              on_dispatch=record_dispatch)
        finally:
            active = False
        if invalid or not completed:
            raise TransportContractError("Missing or failed dispatch callback")
        budget.remaining_seconds()
        self._validate_configuration(response, "false")
        if response["LastUpdateStatus"] == "Failed" or response["State"] == "Failed":
            raise TransportContractError("Update response reports failure")
        budget.remaining_seconds()
        # Update return is not disabled verification. Controller must read back.

    def read_configuration(self, timeout_seconds: float) -> dict:
        budget = self._budget(timeout_seconds)
        parameters = {"FunctionName": self._baseline["FunctionName"]}
        invoke = self._executor.get_function_configuration
        budget.remaining_seconds()
        response = invoke(parameters, budget=budget, max_attempts=1)
        budget.remaining_seconds()
        self._validate_configuration(response)
        result = deepcopy(response)
        budget.remaining_seconds()
        return result
