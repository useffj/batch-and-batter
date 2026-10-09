"""Phase 1A: one-use, in-memory simulation orchestration. No hosted entry point.

Injected callbacks are trusted local simulation code, not a security sandbox.
No controller, executor, admission transport or authentication is constructed.
"""

from dataclasses import dataclass
from enum import Enum
import re
from threading import Event, RLock
from typing import Callable


class State(str, Enum):
    NOT_STARTED = 'NOT_STARTED'
    PREFLIGHT_PENDING = 'PREFLIGHT_PENDING'
    READY = 'READY'
    ACTIVE = 'ACTIVE'
    STOP_REQUESTED = 'STOP_REQUESTED'
    CLEANUP_REQUIRED = 'CLEANUP_REQUIRED'
    COMPLETED = 'COMPLETED'
    FAILED = 'FAILED'


class InvalidTransition(RuntimeError):
    pass


_ALLOWED = {
    State.NOT_STARTED: {State.PREFLIGHT_PENDING, State.STOP_REQUESTED},
    State.PREFLIGHT_PENDING: {State.READY, State.STOP_REQUESTED},
    State.READY: {State.ACTIVE, State.STOP_REQUESTED},
    State.ACTIVE: {State.STOP_REQUESTED, State.CLEANUP_REQUIRED},
    State.STOP_REQUESTED: {State.CLEANUP_REQUIRED},
    State.CLEANUP_REQUIRED: {State.COMPLETED, State.FAILED},
    # A late critical report may invalidate completion, never the reverse.
    State.COMPLETED: {State.FAILED},
    State.FAILED: set(),
}


class _Lifecycle:
    """Owned by Runner; callers cannot advance the runner's public state."""
    def __init__(self):
        self.state = State.NOT_STARTED
        self.history = [self.state]

    def advance(self, target):
        if target not in _ALLOWED[self.state]:
            raise InvalidTransition('Invalid simulation lifecycle transition')
        self.state = target
        self.history.append(target)


class _StopEvent(Event):
    """Event-compatible sticky signal; set() records a component stop reason."""
    def __init__(self, request):
        super().__init__()
        self._request = request

    def set(self):
        self._request('COMPONENT_STOP')

    def clear(self):
        raise InvalidTransition('Stop cannot be cleared')

    def _latch(self):
        super().set()


@dataclass(frozen=True)
class SimulationSteps:
    """Local fakes only. Each callback receives the same sticky Event.

    Return None, never an admission/configuration/payment result. Cleanup is
    called once even if preflight stops/fails, and must tolerate partial setup.
    Active work must cooperate with stop; callbacks cannot be forcibly canceled.
    """
    preflight: Callable[[Event], None]
    active: Callable[[Event], None]
    cleanup: Callable[[Event], None]

    def __post_init__(self):
        if not all(callable(f) for f in (self.preflight, self.active, self.cleanup)):
            raise TypeError('Simulation callbacks required')


@dataclass(frozen=True)
class Report:
    state: State
    outcome: str
    history: tuple[State, ...]
    reasons: tuple[str, ...]
    primary_failure: str | None
    cleanup_completed: bool
    # Deliberately not settable from callback results.
    relock_verified: bool = False
    hosted_authorized: bool = False
    pay_instruction_issued: bool = False


class RunnerFailure(RuntimeError):
    def __init__(self, report, *, primary_exception=None, secondary_exceptions=()):
        super().__init__('Simulation failed; inspect sanitized report')
        self.report = report
        # Trusted diagnostics only: never serialize these into public reports.
        self.primary_exception = primary_exception
        self.secondary_exceptions = tuple(secondary_exceptions)


class Runner:
    """Library-only simulation; no live mode, default dependencies or retries.

    Claims are pending work. Entry admission and stop share one lock; only an
    admitted callback is in flight. Its Python body can begin after a later stop
    and must cooperate with the Event. No lock spans arbitrary callback code.
    """
    def __init__(self, steps: SimulationSteps):
        if type(steps) is not SimulationSteps:
            raise TypeError('Explicit SimulationSteps required; live execution unsupported')
        self._steps = steps
        self._lock = RLock()
        self._lifecycle = _Lifecycle()
        self._stop = _StopEvent(self.request_stop)
        self._used = False
        self._entries = []
        self._reasons = []
        self._primary_failure = None
        self._cleanup_completed = False

    @property
    def stop(self) -> Event:
        return self._stop

    @property
    def state(self):
        with self._lock:
            return self._lifecycle.state

    def request_stop(self, reason='OPERATOR_STOP', *, critical=False):
        # Accept codes only, never raw exception text or arbitrary payloads.
        if not isinstance(reason, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', reason):
            raise ValueError('Stop reason must be a nonsecret code')
        if type(critical) is not bool:
            raise TypeError('Critical must be boolean')
        with self._lock:
            self._stop._latch()
            if reason not in self._reasons:
                self._reasons.append(reason)
            if critical and self._primary_failure is None:
                self._primary_failure = reason
            state = self._lifecycle.state
            if state not in {State.STOP_REQUESTED, State.CLEANUP_REQUIRED, State.COMPLETED, State.FAILED}:
                self._lifecycle.advance(State.STOP_REQUESTED)
            elif state == State.COMPLETED:
                self._lifecycle.advance(State.FAILED)

    def snapshot(self):
        with self._lock:
            state = self._lifecycle.state
            if state == State.FAILED:
                outcome = 'FAILED' if self._primary_failure else 'STOPPED'
            elif state == State.COMPLETED:
                outcome = 'STOPPED' if self._reasons else 'SIMULATED_COMPLETED'
            else:
                outcome = 'INCOMPLETE'
            return Report(state, outcome, tuple(self._lifecycle.history),
                          tuple(self._reasons), self._primary_failure,
                          self._cleanup_completed)

    @staticmethod
    def _invoke(callback, stop):
        if callback(stop) is not None:
            raise TypeError('Simulation callbacks must return None')

    def _admit_entry(self, phase):
        """Linearization point: record entry under the same lock as stop.

        A phase claim alone does not admit entry. Cleanup intentionally bypasses
        this gate. The lock is released before invoking arbitrary callback code.
        """
        with self._lock:
            if self._stop.is_set():
                return False
            expected = {'PREFLIGHT': State.PREFLIGHT_PENDING, 'ACTIVE': State.ACTIVE}
            if self._lifecycle.state != expected.get(phase) or phase in self._entries:
                raise InvalidTransition('Invalid callback entry')
            self._entries.append(phase)
            return True

    def run_simulation(self):
        with self._lock:
            if self._used:
                raise InvalidTransition('Runner is one-use; no repeated activation')
            self._used = True
            preflight_claimed = not self._stop.is_set()
            if preflight_claimed:
                self._lifecycle.advance(State.PREFLIGHT_PENDING)
        primary_exception = None
        secondary_exceptions = []
        phase = 'PREFLIGHT'
        try:
            if preflight_claimed and self._admit_entry('PREFLIGHT'):
                self._invoke(self._steps.preflight, self._stop)
            with self._lock:
                active_claimed = not self._stop.is_set()
                if active_claimed:
                    self._lifecycle.advance(State.READY)
                    self._lifecycle.advance(State.ACTIVE)
            if active_claimed:
                phase = 'ACTIVE'
                if self._admit_entry('ACTIVE'):
                    self._invoke(self._steps.active, self._stop)
        except BaseException as error:
            primary_exception = error
            self.request_stop(phase + '_EXCEPTION', critical=True)
        finally:
            with self._lock:
                self._stop._latch()  # Close all future activities, including on success.
                self._lifecycle.advance(State.CLEANUP_REQUIRED)
            try:
                self._invoke(self._steps.cleanup, self._stop)
                with self._lock:
                    self._cleanup_completed = True
            except BaseException as error:
                if primary_exception is None:
                    primary_exception = error
                else:
                    secondary_exceptions.append(error)
                self.request_stop('CLEANUP_EXCEPTION', critical=True)
            with self._lock:
                self._lifecycle.advance(State.FAILED if self._reasons else State.COMPLETED)
        report = self.snapshot()
        if report.primary_failure is not None:
            # Preserve the original exception for the calling orchestration layer;
            # never put its message in the report. Callers must sanitize tracebacks.
            raise RunnerFailure(report, primary_exception=primary_exception,
                                secondary_exceptions=secondary_exceptions) from primary_exception
        return report
