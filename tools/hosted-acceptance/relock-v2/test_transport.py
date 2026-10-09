"""Fake-executor adapter contract tests. No cloud, sockets or subprocesses."""

from copy import deepcopy
import importlib
import socket
import subprocess
import sys
from threading import Event
import unittest
from unittest.mock import patch

from admission_window import AdmissionWindow, CriticalRelockFailure, NS
from test_admission_window import baseline, FakeClock
from transport import LambdaDisableTransport, TransportContractError


class FakeExecutor:
    def __init__(self, clock, events):
        self.clock, self.events = clock, events
        self.config = baseline()
        self.config['Environment']['Variables']['PAYMENT_START_ENABLED'] = 'true'
        self.config['RevisionId'] = 'enabled-revision'
        self.calls = []
        self.latency = 0
        self.error = None
        self.response_filter = lambda c: c
        self.mutate_request = False
        self.last_response = None
        self.prepare_latency = 0
        self.prepare_error = None

    def _begin(self, operation, parameters, budget, max_attempts):
        self.events.append(operation)
        remaining = budget.remaining_seconds()  # Before any simulated I/O.
        self.calls.append((operation, deepcopy(parameters), remaining, max_attempts, budget.deadline_ns))
        if self.error:
            raise self.error
        self.clock.advance(self.latency)

    def update_function_configuration(self, parameters, *, budget, max_attempts, on_dispatch):
        budget.remaining_seconds()
        self.events.append('prepare')
        prepared = deepcopy(parameters)
        self.clock.advance(self.prepare_latency)
        if self.prepare_error:
            raise self.prepare_error
        budget.remaining_seconds()
        on_dispatch()
        self._begin('launch', prepared, budget, max_attempts)
        if parameters['RevisionId'] != self.config['RevisionId']:
            raise RuntimeError('Revision conflict')
        self.config['Environment'] = deepcopy(parameters['Environment'])
        self.config['RevisionId'] = 'update-revision'
        self.config['LastUpdateStatus'] = 'InProgress'
        if self.mutate_request:
            parameters['Environment']['Variables']['UNCHANGED_SETTING'] = 'executor mutation'
        return self.response_filter(deepcopy(self.config))

    def get_function_configuration(self, parameters, *, budget, max_attempts):
        self._begin('read', parameters, budget, max_attempts)
        self.last_response = self.response_filter(deepcopy(self.config))
        return self.last_response


class TransportTests(unittest.TestCase):
    def setUp(self):
        for target in ('socket.socket', 'socket.create_connection', 'subprocess.Popen',
                       'subprocess.run', 'os.system', 'os.posix_spawn', 'time.sleep'):
            blocker = patch(target, side_effect=AssertionError('REAL_IO_FORBIDDEN'))
            blocker.start()
            self.addCleanup(blocker.stop)
        modules = patch.dict(sys.modules, {'boto3': None, 'botocore': None, 'stripe': None})
        modules.start()
        self.addCleanup(modules.stop)
        self.clock = FakeClock()
        self.events = []
        self.executor = FakeExecutor(self.clock, self.events)
        self.base = baseline()
        self.adapter = LambdaDisableTransport(self.base, self.executor, self.clock.now_ns)
        self.request = {'FunctionName': self.base['FunctionName'], 'RevisionId': 'enabled-revision',
                        'Environment': deepcopy(self.base['Environment'])}

    def dispatch(self, timeout=10, callback=None, request=None):
        return self.adapter.dispatch_disable(
            self.request if request is None else request, timeout,
            callback if callback is not None else lambda: self.events.append('callback'))

    def test_complete_request_and_exact_revision_preserved(self):
        self.dispatch()
        self.assertEqual(self.executor.calls[0][1], self.request)
        self.assertEqual(self.executor.calls[0][1]['RevisionId'], 'enabled-revision')

    def test_only_admission_diff_and_unrelated_environment_preserved(self):
        before = deepcopy(self.executor.config['Environment']['Variables'])
        self.dispatch()
        after = self.executor.calls[0][1]['Environment']['Variables']
        self.assertEqual([k for k in before if before[k] != after[k]], ['PAYMENT_START_ENABLED'])
        self.assertEqual(after, self.base['Environment']['Variables'])

    def test_no_read_and_exact_callback_update_adjacency(self):
        self.dispatch()
        self.assertEqual(self.events, ['prepare', 'callback', 'launch'])
        self.assertEqual(len(self.executor.calls), 1)

    def test_invalid_request_rejected_without_callback(self):
        variants = [None, {}, [], {**self.request, 'Unexpected': True}]
        for field in self.request:
            broken = deepcopy(self.request)
            del broken[field]
            variants.append(broken)
        for field, value in [('FunctionName', 'wrong'), ('RevisionId', ''), ('RevisionId', 1),
                             ('Environment', {}), ('Environment', None)]:
            variants.append({**self.request, field: value})
        for request in variants:
            with self.subTest(request_type=type(request).__name__):
                with self.assertRaises(TransportContractError):
                    self.adapter.dispatch_disable(request, 10, lambda: self.events.append('callback'))
        self.assertEqual(self.events, [])

    def test_environment_identity_or_admission_changes_rejected(self):
        for key in self.request['Environment']['Variables']:
            request = deepcopy(self.request)
            request['Environment']['Variables'][key] = 'different'
            with self.subTest(key=key), self.assertRaises(TransportContractError):
                self.dispatch(request=request)
        self.assertEqual(self.events, [])

    def test_noncallable_callback_rejected(self):
        with self.assertRaises(TransportContractError):
            self.adapter.dispatch_disable(self.request, 10, None)
        self.assertEqual(self.events, [])

    def test_callback_failure_prevents_update(self):
        def callback():
            self.events.append('callback')
            raise RuntimeError('callback failure')
        with self.assertRaisesRegex(RuntimeError, 'callback failure'):
            self.dispatch(callback=callback)
        self.assertEqual(self.events, ['prepare', 'callback'])
        self.assertEqual(self.executor.calls, [])

    def test_update_failure_propagates_without_retry(self):
        error = RuntimeError('update failure')
        self.executor.error = error
        with self.assertRaises(RuntimeError) as caught:
            self.dispatch()
        self.assertIs(caught.exception, error)
        self.assertEqual(self.events, ['prepare', 'callback', 'launch'])
        self.assertEqual(self.executor.calls[0][3], 1)

    def test_revision_conflict_not_refreshed_or_retried(self):
        self.request['RevisionId'] = 'stale-revision'
        with self.assertRaisesRegex(RuntimeError, 'Revision conflict'):
            self.dispatch()
        self.assertEqual(self.events, ['prepare', 'callback', 'launch'])
        self.assertEqual(self.executor.calls[0][1]['RevisionId'], 'stale-revision')

    def test_ambiguous_timeout_propagates(self):
        self.executor.error = TimeoutError('unknown update outcome')
        with self.assertRaises(TimeoutError):
            self.dispatch()
        self.assertEqual(len(self.executor.calls), 1)

    def test_positive_budget_reaches_executor(self):
        origin = self.clock.ns
        self.dispatch(timeout=2.5)
        self.assertEqual(self.executor.calls[0][2:], (2.5, 1, origin + 2_500_000_000))

    def test_invalid_timeouts_do_not_dispatch_or_read(self):
        for timeout in (0, -1, True, None, '10', float('nan'), float('inf'), 1e-12, 1e308, 10**1000):
            with self.subTest(timeout=timeout):
                with self.assertRaises(TransportContractError):
                    self.dispatch(timeout=timeout)
                with self.assertRaises(TransportContractError):
                    self.adapter.read_configuration(timeout)
        self.assertEqual(self.events, [])

    def test_callback_time_consumes_same_budget(self):
        def callback():
            self.events.append('callback')
            self.clock.advance(3 * NS)
        self.dispatch(timeout=10, callback=callback)
        self.assertEqual(self.executor.calls[0][2], 7)
        self.assertEqual(self.events, ['prepare', 'callback', 'launch'])

    def test_expired_callback_budget_prevents_executor_io(self):
        def callback():
            self.clock.advance(10 * NS)
        with self.assertRaises(TimeoutError):
            self.dispatch(callback=callback)
        self.assertEqual(self.executor.calls, [])  # Executor entered, no simulated I/O.

    def test_slow_update_never_returns_timely_success(self):
        for latency in (10 * NS, 11 * NS):
            self.executor.config['RevisionId'] = 'enabled-revision'
            self.executor.latency = latency
            with self.subTest(latency=latency), self.assertRaises(TimeoutError):
                self.dispatch()
        self.assertEqual(len(self.executor.calls), 2)  # One per explicit test call.

    def test_slow_read_never_returns_timely_success(self):
        self.executor.latency = 10 * NS
        with self.assertRaises(TimeoutError):
            self.adapter.read_configuration(10)
        self.assertEqual(len(self.executor.calls), 1)

    def test_missing_or_malformed_update_response_rejected(self):
        for response in (None, {}, [], {'RevisionId': 'x'}):
            self.executor.config['RevisionId'] = 'enabled-revision'
            self.executor.response_filter = lambda c, response=response: response
            with self.subTest(response=response), self.assertRaises(TransportContractError):
                self.dispatch()
        self.assertEqual(len(self.executor.calls), 4)

    def test_inconsistent_update_response_rejected(self):
        def wrong(c):
            c['Environment']['Variables']['PAYMENT_START_ENABLED'] = 'true'
            return c
        self.executor.response_filter = wrong
        with self.assertRaises(TransportContractError):
            self.dispatch()

    def test_explicit_update_failure_response_propagates(self):
        for field in ('LastUpdateStatus', 'State'):
            self.executor.config = baseline()
            self.executor.config['RevisionId'] = 'enabled-revision'
            def failed(config):
                config[field] = 'Failed'
                return config
            self.executor.response_filter = failed
            with self.subTest(field=field), self.assertRaises(TransportContractError):
                self.dispatch()
        self.assertEqual(len(self.executor.calls), 2)

    def test_update_return_is_not_disabled_verification(self):
        self.assertIsNone(self.dispatch())
        self.assertEqual(self.executor.config['LastUpdateStatus'], 'InProgress')
        self.assertEqual(self.events, ['prepare', 'callback', 'launch'])

    def test_readback_is_fresh_and_preserves_new_revision(self):
        first = self.adapter.read_configuration(10)
        self.executor.config['RevisionId'] = 'fresh-read-revision'
        second = self.adapter.read_configuration(10)
        self.assertEqual(first['RevisionId'], 'enabled-revision')
        self.assertEqual(second['RevisionId'], 'fresh-read-revision')
        self.assertEqual(self.events, ['read', 'read'])
        self.assertEqual(self.executor.calls[0][1], {'FunctionName': self.base['FunctionName']})
        self.assertEqual(self.executor.calls[0][3], 1)

    def test_malformed_or_drifted_readback_rejected(self):
        variants = [None, {}, []]
        for key in self.base:
            config = deepcopy(self.executor.config)
            del config[key]
            variants.append(config)
        for key, value in [('RevisionId', 0), ('State', 'unknown'), ('LastUpdateStatus', 'unknown'),
                           ('Timeout', 99), ('FunctionArn', 'wrong')]:
            config = deepcopy(self.executor.config)
            config[key] = value
            variants.append(config)
        for response in variants:
            self.executor.response_filter = lambda c, response=response: response
            with self.subTest(response_type=type(response).__name__), self.assertRaises(TransportContractError):
                self.adapter.read_configuration(10)

    def test_failed_readback_status_preserved_for_controller(self):
        self.executor.config['LastUpdateStatus'] = 'Failed'
        self.assertEqual(self.adapter.read_configuration(10)['LastUpdateStatus'], 'Failed')

    def test_read_error_propagates_without_retry(self):
        self.executor.error = TimeoutError('read timeout')
        with self.assertRaises(TimeoutError):
            self.adapter.read_configuration(10)
        self.assertEqual(self.events, ['read'])

    def test_no_mutation_of_request_baseline_or_returned_configuration(self):
        before_request, before_baseline = deepcopy(self.request), deepcopy(self.base)
        self.executor.mutate_request = True
        self.dispatch()
        self.assertEqual(self.request, before_request)
        self.assertEqual(self.base, before_baseline)
        read = self.adapter.read_configuration(10)
        read['Environment']['Variables']['UNCHANGED_SETTING'] = 'caller mutation'
        self.assertNotEqual(read, self.executor.last_response)
        self.base['Environment']['Variables']['UNCHANGED_SETTING'] = 'caller baseline mutation'
        self.executor.config['RevisionId'] = 'enabled-revision'
        self.dispatch()  # Adapter retained its original baseline.

    def test_baseline_identity_and_artifact_guards(self):
        for key, value in [('FunctionArn', 'wrong'), ('CodeSha256', 'AAAA'), ('FunctionName', 'wrong')]:
            config = baseline()
            config[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                LambdaDisableTransport(config, self.executor, self.clock.now_ns)
        for key in ('STRIPE_ACCOUNT_ID', 'STRIPE_LEDGER_ACCOUNT_ID', 'STRIPE_LEDGER_NAMESPACE'):
            config = baseline()
            config['Environment']['Variables'][key] = 'wrong'
            with self.subTest(key=key), self.assertRaises(ValueError):
                LambdaDisableTransport(config, self.executor, self.clock.now_ns)
        self.assertEqual(self.events, [])

    def test_controller_and_adapter_compatible_without_live_runner(self):
        original_read = self.executor.get_function_configuration
        def completed_read(parameters, **kwargs):
            self.executor.config['LastUpdateStatus'] = 'Successful'
            return original_read(parameters, **kwargs)
        self.executor.get_function_configuration = completed_read
        window = AdmissionWindow(self.base, self.adapter, Event(), self.clock)
        report = window.run(lambda complete: complete(deepcopy(self.executor.config)))
        self.assertEqual(report['result'], 'DISABLED_VERIFIED')
        dispatch = next(e for e in report['events'] if e['event'] == 'disable_update_dispatch')
        self.assertEqual(dispatch['elapsed_from_enable_ns'], 100 * NS)
        self.assertEqual(self.events, ['prepare', 'launch', 'read'])

    def test_controller_latches_ambiguous_adapter_failure(self):
        self.executor.error = TimeoutError('sensitive failure')
        window = AdmissionWindow(self.base, self.adapter, Event(), self.clock)
        with self.assertRaises(CriticalRelockFailure) as caught:
            window.run(lambda complete: complete(deepcopy(self.executor.config)))
        self.assertEqual(caught.exception.report['result'], 'CRITICAL')
        self.assertFalse(caught.exception.report['disabled_verified'])
        self.assertNotIn('sensitive', str(caught.exception.report))

    def test_preparation_failure_has_no_callback_or_launch(self):
        self.executor.prepare_error = RuntimeError('preparation failed')
        with self.assertRaisesRegex(RuntimeError, 'preparation failed'):
            self.dispatch()
        self.assertEqual(self.events, ['prepare'])
        self.assertEqual(self.executor.calls, [])

    def test_preparation_consumes_original_budget(self):
        origin = self.clock.ns
        self.executor.prepare_latency = 4 * NS
        self.dispatch()
        self.assertEqual(self.events, ['prepare', 'callback', 'launch'])
        self.assertEqual(self.executor.calls[0][2:], (6, 1, origin + 10 * NS))

    def test_expiration_during_preparation_prevents_callback(self):
        for latency in (10 * NS, 11 * NS):
            self.events.clear()
            self.executor.prepare_latency = latency
            with self.subTest(latency=latency), self.assertRaises(TimeoutError):
                self.dispatch()
            self.assertEqual(self.events, ['prepare'])
            self.assertEqual(self.executor.calls, [])

    def test_expired_budget_at_executor_entry_prevents_preparation(self):
        original = self.executor.update_function_configuration
        def delayed_entry(parameters, **kwargs):
            self.clock.advance(10 * NS)
            return original(parameters, **kwargs)
        self.executor.update_function_configuration = delayed_entry
        with self.assertRaises(TimeoutError):
            self.dispatch()
        self.assertEqual(self.events, [])

    def test_missing_callback_cannot_return_success(self):
        def missing(parameters, **kwargs):
            return deepcopy(self.base)
        self.executor.update_function_configuration = missing
        with self.assertRaisesRegex(TransportContractError, 'Missing'):
            self.dispatch()
        self.assertEqual(self.events, [])

    def test_duplicate_callback_is_rejected_even_if_executor_swallows_error(self):
        def duplicate(parameters, *, on_dispatch, **kwargs):
            self.events.append('prepare')
            on_dispatch()
            try:
                on_dispatch()
            except TransportContractError:
                pass
            return deepcopy(self.base)
        self.executor.update_function_configuration = duplicate
        with self.assertRaises(TransportContractError):
            self.dispatch()
        self.assertEqual(self.events, ['prepare', 'callback'])

    def test_swallowed_callback_failure_cannot_return_success(self):
        def broken(parameters, *, on_dispatch, **kwargs):
            try:
                on_dispatch()
            except RuntimeError:
                pass
            return deepcopy(self.base)
        def failing_callback():
            raise RuntimeError('callback failed')
        self.executor.update_function_configuration = broken
        with self.assertRaises(TransportContractError):
            self.dispatch(callback=failing_callback)
        self.assertEqual(self.executor.calls, [])

    def test_executor_failure_before_dispatch_propagates(self):
        def broken(parameters, **kwargs):
            raise RuntimeError('executor entry failed')
        self.executor.update_function_configuration = broken
        with self.assertRaisesRegex(RuntimeError, 'executor entry failed'):
            self.dispatch()
        self.assertEqual(self.events, [])

    def test_guard_rejects_expired_budget_before_callback(self):
        def broken(parameters, *, on_dispatch, **kwargs):
            self.events.append('prepare')
            self.clock.advance(10 * NS)
            on_dispatch()  # Deliberately omit executor's required budget check.
            self.events.append('launch')
        self.executor.update_function_configuration = broken
        with self.assertRaises(TimeoutError):
            self.dispatch()
        self.assertEqual(self.events, ['prepare'])

    def test_callback_cannot_be_used_after_executor_returns(self):
        retained = []
        def retain(parameters, *, on_dispatch, **kwargs):
            retained.append(on_dispatch)
            on_dispatch()
            return deepcopy(self.base)
        self.executor.update_function_configuration = retain
        self.dispatch()
        with self.assertRaises(TransportContractError):
            retained[0]()
        self.assertEqual(self.events, ['callback'])

    def test_external_io_and_live_sdk_imports_blocked(self):
        for action in (lambda: socket.socket(), lambda: subprocess.run(['aws', '--version'])):
            with self.assertRaisesRegex(AssertionError, 'REAL_IO_FORBIDDEN'):
                action()
        for module in ('boto3', 'botocore', 'stripe'):
            with self.assertRaises(ModuleNotFoundError):
                importlib.import_module(module)


if __name__ == '__main__':
    unittest.main()
