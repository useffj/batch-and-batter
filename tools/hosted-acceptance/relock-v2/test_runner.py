"""Phase 1A simulation tests: no cloud, credentials, payments or live windows."""

from dataclasses import FrozenInstanceError
from pathlib import Path
import runpy
import socket
import subprocess
import sys
from threading import Barrier, Event, Thread
import unittest
from unittest.mock import patch

from runner import (Runner, RunnerFailure, SimulationSteps, State,
                    InvalidTransition, _Lifecycle)


class FakeSteps:
    def __init__(self):
        self.calls = []
        self.signals = []
        self.ns = 0  # Controllable simulated time, not a second relock timer.
        self.hooks = {}

    def call(self, phase, stop):
        self.calls.append(phase)
        self.signals.append(stop)
        self.ns += 1
        hook = self.hooks.get(phase)
        if hook:
            return hook(stop)

    def dependencies(self):
        return SimulationSteps(lambda stop: self.call('preflight', stop),
                               lambda stop: self.call('active', stop),
                               lambda stop: self.call('cleanup', stop))


class RunnerTests(unittest.TestCase):
    def setUp(self):
        for target in ('socket.socket', 'socket.create_connection', 'subprocess.Popen',
                       'subprocess.run', 'os.system', 'os.posix_spawn', 'time.sleep'):
            blocker = patch(target, side_effect=AssertionError('REAL_IO_FORBIDDEN'))
            blocker.start()
            self.addCleanup(blocker.stop)
        blocker = patch.dict(sys.modules, {'boto3': None, 'botocore': None, 'stripe': None})
        blocker.start()
        self.addCleanup(blocker.stop)
        self.fake = FakeSteps()
        self.runner = Runner(self.fake.dependencies())

    def failure(self):
        with self.assertRaises(RunnerFailure) as caught:
            self.runner.run_simulation()
        self.assertEqual(caught.exception.report.state, State.FAILED)
        self.assertFalse(caught.exception.report.relock_verified)
        return caught.exception

    def test_initial_state_and_denied_authority(self):
        report = self.runner.snapshot()
        self.assertEqual(report.state, State.NOT_STARTED)
        self.assertEqual(report.outcome, 'INCOMPLETE')
        self.assertFalse(report.hosted_authorized)
        self.assertFalse(report.pay_instruction_issued)
        self.assertFalse(report.relock_verified)
        self.assertEqual(self.fake.calls, [])

    def test_successful_simulated_lifecycle(self):
        report = self.runner.run_simulation()
        self.assertEqual(report.history, (State.NOT_STARTED, State.PREFLIGHT_PENDING,
            State.READY, State.ACTIVE, State.CLEANUP_REQUIRED, State.COMPLETED))
        self.assertEqual(self.fake.calls, ['preflight', 'active', 'cleanup'])
        self.assertEqual(self.fake.ns, 3)
        self.assertEqual(report.outcome, 'SIMULATED_COMPLETED')
        self.assertTrue(report.cleanup_completed)
        self.assertFalse(report.relock_verified)
        self.assertTrue(self.runner.stop.is_set())

    def test_valid_stop_failure_transitions(self):
        life = _Lifecycle()
        for state in (State.PREFLIGHT_PENDING, State.STOP_REQUESTED,
                      State.CLEANUP_REQUIRED, State.FAILED):
            life.advance(state)
        self.assertEqual(life.state, State.FAILED)

    def test_invalid_transitions_leave_state_unchanged(self):
        life = _Lifecycle()
        for target in (State.ACTIVE, State.READY, State.COMPLETED, State.FAILED,
                       State.CLEANUP_REQUIRED, State.NOT_STARTED):
            with self.assertRaises(InvalidTransition):
                life.advance(target)
            self.assertEqual(life.history, [State.NOT_STARTED])

    def test_failure_is_terminal(self):
        life = _Lifecycle()
        for state in (State.STOP_REQUESTED, State.CLEANUP_REQUIRED, State.FAILED):
            life.advance(state)
        for target in State:
            with self.assertRaises(InvalidTransition):
                life.advance(target)
        self.assertEqual(life.state, State.FAILED)

    def test_stop_before_run_only_cleans_up(self):
        self.runner.request_stop()
        report = self.runner.run_simulation()
        self.assertEqual(self.fake.calls, ['cleanup'])
        self.assertEqual(report.outcome, 'STOPPED')
        self.assertNotIn(State.READY, report.history)
        self.assertNotIn(State.ACTIVE, report.history)

    def test_stop_during_preflight_prevents_readiness_and_activation(self):
        self.fake.hooks['preflight'] = lambda stop: stop.set()
        report = self.runner.run_simulation()
        self.assertEqual(self.fake.calls, ['preflight', 'cleanup'])
        self.assertNotIn(State.READY, report.history)
        self.assertEqual(report.reasons, ('COMPONENT_STOP',))

    def test_stop_during_active_visible_and_cleanup_runs(self):
        def active(stop):
            self.runner.request_stop('OBSERVED_STOP')
            self.assertTrue(stop.is_set())
            self.assertEqual(self.runner.state, State.STOP_REQUESTED)
        self.fake.hooks['active'] = active
        report = self.runner.run_simulation()
        self.assertEqual(report.outcome, 'STOPPED')
        self.assertEqual(self.fake.calls.count('active'), 1)
        self.assertEqual(self.fake.calls.count('cleanup'), 1)

    def test_duplicate_stop_requests_are_idempotent(self):
        for _ in range(3):
            self.runner.request_stop('STOP', critical=True)
        report = self.runner.snapshot()
        self.assertEqual(report.reasons, ('STOP',))
        self.assertEqual(report.primary_failure, 'STOP')
        self.assertEqual(report.history.count(State.STOP_REQUESTED), 1)

    def test_concurrent_stops_preserve_primary_and_all_reasons(self):
        self.runner.request_stop('FIRST_FAILURE', critical=True)
        barrier = Barrier(9)
        def request(index):
            barrier.wait(timeout=2)
            self.runner.request_stop('FAILURE_' + str(index), critical=True)
        threads = [Thread(target=request, args=(n,), daemon=True) for n in range(8)]
        for thread in threads:
            thread.start()
        barrier.wait(timeout=2)
        for thread in threads:
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
        report = self.runner.snapshot()
        self.assertEqual(report.primary_failure, 'FIRST_FAILURE')
        self.assertEqual(set(report.reasons), {'FIRST_FAILURE'} | {'FAILURE_' + str(n) for n in range(8)})

    def test_concurrent_stop_is_not_blocked_by_active_callback(self):
        entered, release = Event(), Event()
        results = []
        def active(stop):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            self.assertTrue(stop.is_set())
        self.fake.hooks['active'] = active
        thread = Thread(target=lambda: results.append(self.runner.run_simulation()), daemon=True)
        thread.start()
        try:
            self.assertTrue(entered.wait(timeout=2))
            self.runner.request_stop('CONCURRENT_STOP')
            self.assertTrue(self.runner.stop.is_set())
        finally:
            release.set()
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0].outcome, 'STOPPED')
        self.assertEqual(self.fake.calls, ['preflight', 'active', 'cleanup'])

    def test_concurrent_preflight_stop_prevents_active_claim(self):
        entered, release = Event(), Event()
        results = []
        def preflight(stop):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
        self.fake.hooks['preflight'] = preflight
        thread = Thread(target=lambda: results.append(self.runner.run_simulation()), daemon=True)
        thread.start()
        try:
            self.assertTrue(entered.wait(timeout=2))
            self.runner.request_stop('STOP_BEFORE_READY')
        finally:
            release.set()
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.fake.calls, ['preflight', 'cleanup'])
        self.assertNotIn(State.READY, results[0].history)

    def test_original_exception_is_preserved_as_cause(self):
        original = RuntimeError('synthetic private detail')
        def fail(stop):
            raise original
        self.fake.hooks['active'] = fail
        failure = self.failure()
        self.assertIs(failure.__cause__, original)
        self.assertEqual(failure.report.primary_failure, 'ACTIVE_EXCEPTION')
        self.assertNotIn('private', repr(failure.report))
        self.assertNotIn('private', str(failure))
        self.assertEqual(self.fake.calls[-1], 'cleanup')

    def test_preflight_exception_prevents_active(self):
        def fail(stop):
            raise ValueError('synthetic')
        self.fake.hooks['preflight'] = fail
        self.assertEqual(self.failure().report.primary_failure, 'PREFLIGHT_EXCEPTION')
        self.assertEqual(self.fake.calls, ['preflight', 'cleanup'])

    def test_cleanup_failure_is_explicit(self):
        def fail(stop):
            raise RuntimeError('synthetic')
        self.fake.hooks['cleanup'] = fail
        report = self.failure().report
        self.assertEqual(report.primary_failure, 'CLEANUP_EXCEPTION')
        self.assertFalse(report.cleanup_completed)
        self.assertEqual(self.fake.calls.count('cleanup'), 1)

    def test_cleanup_failure_cannot_replace_primary_exception(self):
        original = ValueError('first')
        def active(stop):
            raise original
        def cleanup(stop):
            raise RuntimeError('second')
        self.fake.hooks.update(active=active, cleanup=cleanup)
        failure = self.failure()
        self.assertIs(failure.__cause__, original)
        self.assertEqual(failure.report.reasons, ('ACTIVE_EXCEPTION', 'CLEANUP_EXCEPTION'))
        self.assertEqual(failure.report.primary_failure, 'ACTIVE_EXCEPTION')

    def test_critical_stop_remains_failure_after_successful_cleanup(self):
        self.runner.request_stop('PRIMARY', critical=True)
        report = self.failure().report
        self.assertTrue(report.cleanup_completed)
        self.assertEqual(report.primary_failure, 'PRIMARY')
        self.assertEqual(self.fake.calls, ['cleanup'])

    def test_event_compatibility_and_no_clear(self):
        self.assertIsInstance(self.runner.stop, Event)
        self.assertFalse(self.runner.stop.wait(0))
        self.runner.stop.set()
        self.assertTrue(self.runner.stop.wait(0))
        with self.assertRaises(InvalidTransition):
            self.runner.stop.clear()
        self.assertTrue(self.runner.stop.is_set())
        with self.assertRaises(AttributeError):
            self.runner.stop = Event()

    def test_every_dependency_receives_same_stop_signal(self):
        self.runner.run_simulation()
        self.assertEqual(len(self.fake.signals), 3)
        self.assertTrue(all(signal is self.runner.stop for signal in self.fake.signals))

    def test_no_automatic_retry_or_second_activation(self):
        self.runner.run_simulation()
        with self.assertRaises(InvalidTransition):
            self.runner.run_simulation()
        self.assertEqual(self.fake.calls, ['preflight', 'active', 'cleanup'])

    def test_reentrant_second_run_rejected(self):
        def active(stop):
            with self.assertRaises(InvalidTransition):
                self.runner.run_simulation()
        self.fake.hooks['active'] = active
        self.runner.run_simulation()
        self.assertEqual(self.fake.calls.count('active'), 1)

    def test_missing_or_live_shaped_dependencies_rejected(self):
        for value in (None, object(), {'enable': lambda: None}):
            with self.assertRaises(TypeError):
                Runner(value)
        with self.assertRaises(TypeError):
            Runner()
        with self.assertRaises(TypeError):
            SimulationSteps(None, None, None)
        self.assertEqual(self.fake.calls, [])

    def test_dependency_results_cannot_fabricate_disabled_verification(self):
        self.fake.hooks['active'] = lambda stop: {'disabled_verified': True}
        report = self.failure().report
        self.assertFalse(report.relock_verified)
        self.assertFalse(report.hosted_authorized)
        self.assertFalse(report.pay_instruction_issued)

    def test_no_live_entry_or_pay_publication_api(self):
        for name in ('run_hosted', 'enable_admission', 'publish_pay', 'authorize_pay'):
            self.assertFalse(hasattr(self.runner, name))
        report = self.runner.run_simulation()
        self.assertFalse(report.pay_instruction_issued)
        self.assertFalse(report.hosted_authorized)

    def test_import_has_no_external_side_effects(self):
        namespace = runpy.run_path(str(Path(__file__).with_name('runner.py')))
        self.assertIn('Runner', namespace)
        self.assertEqual(self.fake.calls, [])

    def test_external_io_is_blocked(self):
        for action in (lambda: socket.socket(), lambda: subprocess.run(['aws'])):
            with self.assertRaisesRegex(AssertionError, 'REAL_IO_FORBIDDEN'):
                action()

    def test_reason_codes_reject_payloads(self):
        with self.assertRaisesRegex(ValueError, 'nonsecret code'):
            self.runner.request_stop('synthetic private payload')
        self.assertEqual(self.runner.snapshot().reasons, ())

    def test_report_is_immutable_snapshot(self):
        report = self.runner.snapshot()
        with self.assertRaises(FrozenInstanceError):
            report.hosted_authorized = True
        self.runner.request_stop('LATER')
        self.assertEqual(report.reasons, ())
        self.assertEqual(self.runner.snapshot().reasons, ('LATER',))

    def test_late_critical_failure_invalidates_completion(self):
        self.runner.run_simulation()
        self.runner.request_stop('LATE_CRITICAL', critical=True)
        self.assertEqual(self.runner.snapshot().state, State.FAILED)
        self.assertEqual(self.runner.snapshot().primary_failure, 'LATE_CRITICAL')
        with self.assertRaises(InvalidTransition):
            self.runner.run_simulation()

    def test_cleanup_observes_stop_even_on_normal_completion(self):
        self.fake.hooks['cleanup'] = lambda stop: self.assertTrue(stop.is_set())
        self.runner.run_simulation()

    def _entry_race(self, phase, admitted_first=False):
        reached, release = Event(), Event()
        failures = []
        original = self.runner._admit_entry
        def controlled(candidate):
            if candidate != phase:
                return original(candidate)
            admitted = original(candidate) if admitted_first else None
            reached.set()
            if not release.wait(2):
                raise AssertionError('ENTRY_RELEASE_TIMEOUT')
            return admitted if admitted_first else original(candidate)
        def execute():
            try:
                self.runner.run_simulation()
            except BaseException as error:
                failures.append(error)
        observed = []
        self.fake.hooks[phase.lower()] = lambda stop: observed.append(stop.is_set())
        with patch.object(self.runner, '_admit_entry', side_effect=controlled):
            thread = Thread(target=execute, daemon=True)
            thread.start()
            try:
                self.assertTrue(reached.wait(2))
                self.runner.request_stop('FIRST_CRITICAL', critical=True)
                self.runner.request_stop('FIRST_CRITICAL', critical=True)
                self.runner.request_stop('SECOND_CRITICAL', critical=True)
                self.assertTrue(self.runner.stop.is_set())
            finally:
                release.set()
                thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], RunnerFailure)
        report = failures[0].report
        self.assertEqual(report.state, State.FAILED)
        self.assertNotIn(State.COMPLETED, report.history)
        self.assertEqual(report.primary_failure, 'FIRST_CRITICAL')
        self.assertEqual(report.reasons, ('FIRST_CRITICAL', 'SECOND_CRITICAL'))
        self.assertEqual(self.fake.calls.count(phase.lower()), int(admitted_first))
        self.assertEqual(self.runner._entries.count(phase), int(admitted_first))
        self.assertEqual(observed, [True] if admitted_first else [])
        self.assertEqual(self.fake.calls.count('cleanup'), 1)
        if phase == 'PREFLIGHT':
            self.assertEqual(self.fake.calls.count('active'), 0)
        with self.assertRaises(InvalidTransition):
            self.runner.run_simulation()

    def test_stop_between_preflight_claim_and_entry(self):
        self._entry_race('PREFLIGHT')

    def test_stop_between_active_claim_and_entry(self):
        self._entry_race('ACTIVE')

    def test_preflight_admitted_before_stop_is_in_flight(self):
        self._entry_race('PREFLIGHT', admitted_first=True)

    def test_active_admitted_before_stop_is_in_flight(self):
        self._entry_race('ACTIVE', admitted_first=True)

    def _competing_executions(self, fail_active=False):
        start = Barrier(3)
        loser_finished = Event()
        reports, errors = [], []
        original = RuntimeError('TEST_SECRET_CONCURRENT')
        def active(stop):
            if not loser_finished.wait(2):
                raise AssertionError('SECOND_EXECUTION_NOT_REJECTED')
            if fail_active:
                raise original
        self.fake.hooks['active'] = active
        def execute():
            try:
                start.wait(2)
                reports.append(self.runner.run_simulation())
            except BaseException as error:
                errors.append(error)
                if isinstance(error, InvalidTransition):
                    loser_finished.set()
        threads = [Thread(target=execute, daemon=True) for _ in range(2)]
        for thread in threads:
            thread.start()
        start.wait(2)
        for thread in threads:
            thread.join(3)
            self.assertFalse(thread.is_alive())
        self.assertEqual(sum(isinstance(e, InvalidTransition) for e in errors), 1)
        self.assertEqual(self.fake.calls, ['preflight', 'active', 'cleanup'])
        self.assertEqual(self.runner._entries, ['PREFLIGHT', 'ACTIVE'])
        self.assertEqual(self.runner.snapshot().history.count(State.PREFLIGHT_PENDING), 1)
        if fail_active:
            self.assertEqual(reports, [])
            self.assertEqual(len(errors), 2)
            failure = next(e for e in errors if isinstance(e, RunnerFailure))
            self.assertIs(failure.primary_exception, original)
            self.assertEqual(failure.report.state, State.FAILED)
        else:
            self.assertEqual(len(errors), 1)
            self.assertEqual(len(reports), 1)
            self.assertEqual(reports[0].outcome, 'SIMULATED_COMPLETED')

    def test_concurrent_second_run_rejected(self):
        self._competing_executions()

    def test_concurrent_single_use_with_primary_failure(self):
        self._competing_executions(fail_active=True)

    def test_primary_and_secondary_exception_identity_and_sanitization(self):
        first = ValueError('TEST_SECRET_PRIMARY')
        second = RuntimeError('TEST_SECRET_CLEANUP')
        def active(stop):
            raise first
        def cleanup(stop):
            raise second
        self.fake.hooks.update(active=active, cleanup=cleanup)
        failure = self.failure()
        self.assertIs(failure.__cause__, first)
        self.assertIs(failure.primary_exception, first)
        self.assertEqual(len(failure.secondary_exceptions), 1)
        self.assertIs(failure.secondary_exceptions[0], second)
        self.assertIsNotNone(second.__traceback__)
        self.assertEqual(failure.report.primary_failure, 'ACTIVE_EXCEPTION')
        self.assertEqual(failure.report.reasons, ('ACTIVE_EXCEPTION', 'CLEANUP_EXCEPTION'))
        self.assertNotIn('TEST_SECRET', repr(failure.report))
        self.assertNotIn('TEST_SECRET', str(failure))
        self.assertFalse(failure.report.cleanup_completed)
        self.assertEqual(self.fake.calls.count('cleanup'), 1)

    def test_primary_exception_successful_cleanup_diagnostics(self):
        original = RuntimeError('TEST_SECRET_PRIMARY_ONLY')
        def active(stop):
            raise original
        self.fake.hooks['active'] = active
        failure = self.failure()
        self.assertIs(failure.primary_exception, original)
        self.assertIs(failure.__cause__, original)
        self.assertEqual(failure.secondary_exceptions, ())
        self.assertTrue(failure.report.cleanup_completed)
        self.assertNotIn('TEST_SECRET', repr(failure.report))
        self.assertEqual(self.fake.calls.count('cleanup'), 1)

    def test_stop_then_cleanup_exception_preserves_authoritative_reason(self):
        error = RuntimeError('TEST_SECRET_STOP_CLEANUP')
        self.runner.request_stop('MONITOR_FAILURE', critical=True)
        self.runner.request_stop('ANOTHER_FAILURE', critical=True)
        def cleanup(stop):
            raise error
        self.fake.hooks['cleanup'] = cleanup
        failure = self.failure()
        self.assertEqual(failure.report.primary_failure, 'MONITOR_FAILURE')
        self.assertEqual(failure.report.reasons,
                         ('MONITOR_FAILURE', 'ANOTHER_FAILURE', 'CLEANUP_EXCEPTION'))
        self.assertIs(failure.primary_exception, error)
        self.assertIs(failure.__cause__, error)
        self.assertEqual(failure.secondary_exceptions, ())
        self.assertNotIn('TEST_SECRET', repr(failure.report))
        self.assertEqual(self.fake.calls, ['cleanup'])

    def test_cleanup_only_exception_diagnostics(self):
        error = RuntimeError('TEST_SECRET_CLEANUP_ONLY')
        def cleanup(stop):
            raise error
        self.fake.hooks['cleanup'] = cleanup
        failure = self.failure()
        self.assertIs(failure.primary_exception, error)
        self.assertIs(failure.__cause__, error)
        self.assertEqual(failure.secondary_exceptions, ())
        self.assertEqual(failure.report.primary_failure, 'CLEANUP_EXCEPTION')
        self.assertNotIn('TEST_SECRET', repr(failure.report))
        self.assertEqual(self.fake.calls, ['preflight', 'active', 'cleanup'])

    def test_noncritical_stop_never_completes(self):
        self.fake.hooks['active'] = lambda stop: stop.set()
        report = self.runner.run_simulation()
        self.assertEqual(report.state, State.FAILED)
        self.assertEqual(report.outcome, 'STOPPED')
        self.assertIsNone(report.primary_failure)
        self.assertNotIn(State.COMPLETED, report.history)
        self.assertEqual(self.fake.calls.count('cleanup'), 1)
