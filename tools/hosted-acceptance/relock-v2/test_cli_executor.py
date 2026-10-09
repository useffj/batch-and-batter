"""Synthetic executor contracts and explicitly authorized harmless Python children."""

from contextlib import contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import tempfile
from time import monotonic_ns
import unittest
from unittest.mock import patch

from admission_window import NS, AdmissionWindow
from threading import Event
from transport import OperationBudget, LambdaDisableTransport
from test_admission_window import baseline, FakeClock
from cli_executor import (AwsCliExecutor, ExecutorError, PosixProcesses, protected_input,
                          controlled_environment, OUTPUT_LIMIT, PROFILE, REGION)


# Synthetic structural fixture; not a purported historical update response.
def response_fixture(status='InProgress'):
    config = baseline()
    config.update(RevisionId='new-revision', LastUpdateStatus=status,
                  Architectures=['arm64'], CodeSize=100, Description='synthetic',
                  EphemeralStorage={'Size': 512}, Handler='index.handler',
                  LastModified='2026-10-09T00:00:00Z', LoggingConfig={'LogFormat': 'Text'},
                  MemorySize=128, PackageType='Zip', Role='synthetic-role', Runtime='nodejs24.x',
                  RuntimeVersionConfig={'RuntimeVersionArn': 'synthetic-runtime'},
                  SnapStart={'ApplyOn': 'None', 'OptimizationStatus': 'Off'},
                  TracingConfig={'Mode': 'PassThrough'}, Version='$LATEST', VpcConfig={})
    return config


class FakeProcesses:
    def __init__(self, owner):
        self.owner = owner
        self.stdout = json.dumps(response_fixture()).encode()
        self.stderr = b''
        self.code = 0
        self.launch_error = self.collect_error = self.cleanup_error = None
        self.latency = self.startup_latency = 0
        self.calls = []
        self.cleaned = False
        self.path = None

    def launch(self, argv, env):
        self.owner.events.append('launch')
        self.calls.append((argv, env))
        self.path = Path(argv[-1][7:])
        self.request = json.loads(self.path.read_text())
        self.modes = (stat.S_IMODE(self.path.stat().st_mode), stat.S_IMODE(self.path.parent.stat().st_mode))
        self.owner.clock.advance(self.startup_latency)
        if self.launch_error:
            raise self.launch_error
        return self

    def collect(self, process, budget, limit):
        self.remaining = budget.remaining_seconds()
        self.owner.clock.advance(self.latency)
        if self.collect_error:
            raise self.collect_error
        return self.code, self.stdout, self.stderr

    def cleanup(self, process):
        self.cleaned = True
        if self.cleanup_error:
            raise self.cleanup_error


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.aws = self.root / 'aws'
        self.aws.write_text('not a real AWS executable')
        self.aws.chmod(0o700)
        self.clock = FakeClock()
        self.events = []
        self.proc = FakeProcesses(self)
        self.config = self.root / '.aws' / 'config'
        self.config.parent.mkdir()
        self.credentials = self.config.parent / 'credentials'
        self.sso = ('sso_account_id = 302154194958\nsso_role_name = SyntheticRole\n'
                    'sso_start_url = https://synthetic.awsapps.com/start\nsso_region = us-east-1\n')
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso)
        self.env = {'HOME': str(self.root), 'PATH': '/usr/bin:/bin'}
        self.executor = AwsCliExecutor(str(self.aws), processes=self.proc, environment=self.env)
        self.request = {'FunctionName': baseline()['FunctionName'], 'RevisionId': 'old-revision',
                        'Environment': deepcopy(baseline()['Environment'])}
        for target in ('socket.socket', 'socket.create_connection', 'subprocess.Popen',
                       'subprocess.run', 'os.system', 'os.posix_spawn', 'time.sleep'):
            block = patch(target, side_effect=AssertionError('REAL_IO_FORBIDDEN'))
            block.start()
            self.addCleanup(block.stop)
        block = patch.dict(sys.modules, {'boto3': None, 'botocore': None, 'stripe': None})
        block.start()
        self.addCleanup(block.stop)

    def budget(self, seconds=10):
        return OperationBudget(self.clock.ns + int(seconds * NS), self.clock.now_ns)

    def update(self, budget=None, callback=None, attempts=1):
        return self.executor.update_function_configuration(self.request, budget=budget or self.budget(),
            max_attempts=attempts, on_dispatch=callback or (lambda: self.events.append('callback')))

    def assert_error(self, category, action=None):
        with self.assertRaises(ExecutorError) as result:
            (action or self.update)()
        self.assertEqual(result.exception.category, category)
        self.assertNotIn('sensitive', str(result.exception))
        return result.exception

    def test_operation_profile_region_arguments(self):
        self.update()
        argv, env = self.proc.calls[0]
        self.assertEqual(argv[:3], [str(self.aws.resolve()), 'lambda', 'update-function-configuration'])
        self.assertEqual(argv[argv.index('--profile') + 1], PROFILE)
        self.assertEqual(argv[argv.index('--region') + 1], REGION)
        for flag in ('--no-paginate', '--no-cli-pager', '--no-cli-auto-prompt'):
            self.assertIn(flag, argv)
        self.assertNotIn('--debug', argv)

    def test_exact_request_revision_environment_and_no_mutation(self):
        original = deepcopy(self.request)
        self.update()
        self.assertEqual(self.proc.request, original)
        self.assertEqual(self.request, original)
        self.assertEqual(set(self.proc.request), {'FunctionName', 'RevisionId', 'Environment'})

    def test_protected_input_before_callback_and_permissions(self):
        @contextmanager
        def prepared(request):
            with protected_input(request) as path:
                self.path = Path(path)
                self.events.append('prepare')
                yield path
        self.executor.input_factory = prepared
        def callback():
            self.assertTrue(self.path.exists())
            self.assertEqual(json.loads(self.path.read_text()), self.request)
            self.events.append('callback')
        self.update(callback=callback)
        self.assertEqual(self.events, ['prepare', 'callback', 'launch'])
        self.assertEqual(self.proc.modes, (0o600, 0o700))
        self.assertFalse(self.path.parent.exists())

    def test_no_values_in_arguments(self):
        self.request['Environment']['Variables']['SYNTHETIC_SECRET'] = 'sensitive-placeholder'
        config = response_fixture()
        config['Environment'] = deepcopy(self.request['Environment'])
        self.proc.stdout = json.dumps(config).encode()
        self.update()
        self.assertNotIn('sensitive-placeholder', str(self.proc.calls[0][0]))
        self.assertNotIn('old-revision', str(self.proc.calls[0][0]))

    def test_launch_failure_cleanup(self):
        self.proc.launch_error = OSError('sensitive path')
        self.assertTrue(self.assert_error('LAUNCH_FAILED').ambiguous)
        self.assertFalse(self.proc.path.parent.exists())
        self.assertEqual(self.events, ['callback', 'launch'])
        self.assertEqual(len(self.proc.calls), 1)

    def test_callback_failure_prevents_launch_and_cleans_input(self):
        @contextmanager
        def capture(request):
            with protected_input(request) as path:
                self.path = Path(path)
                yield path
        self.executor.input_factory = capture
        def callback():
            raise RuntimeError('sensitive')
        self.assert_error('CALLBACK_FAILED', lambda: self.update(callback=callback))
        self.assertEqual(self.proc.calls, [])
        self.assertFalse(self.path.parent.exists())

    def test_preparation_failure_prevents_callback(self):
        @contextmanager
        def broken(request):
            raise OSError('sensitive')
            yield
        self.executor.input_factory = broken
        self.assert_error('EXECUTOR_FAILED')
        self.assertEqual(self.events, [])

    def test_expired_budget_prevents_dispatch(self):
        self.assert_error('OPERATION_TIMEOUT', lambda: self.update(budget=self.budget(0)))
        self.assertEqual(self.events, [])

    def test_preparation_consumes_original_budget(self):
        @contextmanager
        def slow(request):
            with protected_input(request) as path:
                self.clock.advance(4 * NS)
                yield path
        self.executor.input_factory = slow
        self.update()
        self.assertEqual(self.proc.remaining, 6)

    def test_preparation_expiry_cleans_without_callback(self):
        @contextmanager
        def slow(request):
            with protected_input(request) as path:
                self.path = Path(path)
                self.clock.advance(10 * NS)
                yield path
        self.executor.input_factory = slow
        self.assert_error('OPERATION_TIMEOUT')
        self.assertEqual(self.events, [])
        self.assertFalse(self.path.parent.exists())

    def test_startup_consumes_remaining_budget(self):
        self.proc.startup_latency = 3 * NS
        self.update()
        self.assertEqual(self.proc.remaining, 7)

    def test_startup_expiry_still_cleans_process(self):
        self.proc.startup_latency = 11 * NS
        self.assert_error('OPERATION_TIMEOUT')
        self.assertTrue(self.proc.cleaned)
        self.assertFalse(self.proc.path.parent.exists())

    def test_execution_timeout_is_ambiguous_no_retry(self):
        self.proc.collect_error = subprocess.TimeoutExpired('sensitive command', 1)
        error = self.assert_error('OPERATION_TIMEOUT')
        self.assertTrue(error.ambiguous)
        self.assertTrue(self.proc.cleaned)
        self.assertFalse(self.proc.path.parent.exists())
        self.assertEqual(len(self.proc.calls), 1)

    def test_late_completion_rejected(self):
        self.proc.latency = 10 * NS
        self.assert_error('OPERATION_TIMEOUT')
        self.assertTrue(self.proc.cleaned)

    def test_parsing_consumes_budget(self):
        parse = self.executor._response
        def slow(*args):
            result = parse(*args)
            self.clock.advance(10 * NS)
            return result
        with patch.object(self.executor, '_response', side_effect=slow):
            self.assert_error('OPERATION_TIMEOUT')

    def test_retry_environment_overrides_inherited_settings(self):
        self.executor.environment.update(AWS_MAX_ATTEMPTS='9', AWS_RETRY_MODE='adaptive',
            AWS_PROFILE='wrong', AWS_REGION='wrong', AWS_ACCESS_KEY_ID='sensitive', AWS_PAGER='bad')
        self.update()
        env = self.proc.calls[0][1]
        self.assertEqual(env['AWS_MAX_ATTEMPTS'], '1')
        self.assertEqual(env['AWS_RETRY_MODE'], 'standard')
        self.assertEqual(env['AWS_PROFILE'], PROFILE)
        self.assertEqual(env['AWS_REGION'], REGION)
        self.assertNotIn('AWS_ACCESS_KEY_ID', env)
        self.assertEqual(env['AWS_PAGER'], '')

    def test_endpoint_override_rejected_before_dispatch(self):
        self.executor.environment['AWS_ENDPOINT_URL_LAMBDA'] = 'https://invalid.example'
        self.assert_error('ENDPOINT_OVERRIDE')
        self.assertEqual(self.events, [])

    def test_profile_endpoint_history_and_renewal_fail_closed(self):
        config = self.root / 'config'
        self.executor.environment['AWS_CONFIG_FILE'] = str(config)
        for setting, category in [('endpoint_url = https://invalid.example', 'UNAPPROVED_CLI_CONFIGURATION'),
                                  ('cli_history = enabled', 'UNAPPROVED_CLI_CONFIGURATION'),
                                  ('sso_session = example', 'CREDENTIAL_PREFLIGHT_REQUIRED'),
                                  ('credential_process = helper', 'CREDENTIAL_PREFLIGHT_REQUIRED')]:
            config.write_text(f'[profile {PROFILE}]\n{setting}\n')
            self.assert_error(category)
        self.assertEqual(self.events, [])

    def test_invalid_executable_rejected_without_launch(self):
        for path in ('aws', str(self.root/'missing'), str(self.root)):
            with self.subTest(path=path), self.assertRaises(ExecutorError):
                AwsCliExecutor(path)
        self.aws.chmod(0o777)
        with self.assertRaises(ExecutorError):
            AwsCliExecutor(str(self.aws))
        self.assertEqual(self.proc.calls, [])

    def test_invalid_request_and_attempt_count(self):
        for attempts in (0, 2, True):
            self.assert_error('INVALID_REQUEST', lambda: self.update(attempts=attempts))
        self.request['FunctionName'] = 'wrong'
        self.assert_error('INVALID_REQUEST')
        self.assertEqual(self.events, [])

    def test_revision_conflict_sanitized_without_replay(self):
        self.proc.code = 255
        self.proc.stderr = b'sensitive PreconditionFailedException'
        self.assert_error('REVISION_CONFLICT')
        self.assertEqual(len(self.proc.calls), 1)

    def test_cli_error_and_stderr_sanitized(self):
        self.proc.code = 255
        self.proc.stderr = b'sensitive'
        self.assert_error('CLI_FAILED')
        self.proc.code = 0
        self.assert_error('UNEXPECTED_STDERR')

    def test_malformed_json_and_duplicate_keys_rejected(self):
        for data in (b'', b'sensitive', b'[]', b'{"x":1,"x":2}', b'{"x":NaN}', b'\xff'):
            self.proc.stdout = data
            self.assert_error('INVALID_RESPONSE')

    def test_missing_or_invalid_response_fields(self):
        for key in ('RevisionId', 'Environment', 'FunctionArn', 'State', 'LastUpdateStatus', 'CodeSha256'):
            config = response_fixture()
            del config[key]
            self.proc.stdout = json.dumps(config).encode()
            self.assert_error('INVALID_RESPONSE')
        for key, value in [('RevisionId', 'old-revision'), ('FunctionArn', 'wrong'), ('State', 'unknown')]:
            config = response_fixture()
            config[key] = value
            self.proc.stdout = json.dumps(config).encode()
            self.assert_error('INVALID_RESPONSE')

    def test_output_limits(self):
        self.proc.stdout = b'x' * (OUTPUT_LIMIT + 1)
        self.assert_error('OUTPUT_LIMIT')
        self.proc.stdout = b'{}'
        self.proc.stderr = b'x' * (OUTPUT_LIMIT + 1)
        self.assert_error('OUTPUT_LIMIT')

    def test_fresh_read_construction_and_optional_fields_preserved(self):
        config = response_fixture('Successful')
        self.proc.stdout = json.dumps(config).encode()
        for _ in range(2):
            result = self.executor.get_function_configuration({'FunctionName': baseline()['FunctionName']},
                budget=self.budget(), max_attempts=1)
            self.assertEqual(result, config)
        self.assertEqual(len(self.proc.calls), 2)
        self.assertEqual(self.proc.calls[0][0][2], 'get-function-configuration')
        self.assertEqual(set(self.proc.request), {'FunctionName'})
        self.assertNotIn('callback', self.events)

    def test_inprogress_and_failed_status_preserved_not_verified(self):
        for status in ('InProgress', 'Failed'):
            self.proc.stdout = json.dumps(response_fixture(status)).encode()
            self.assertEqual(self.update()['LastUpdateStatus'], status)

    def test_adapter_composition_preserves_strict_full_response_guards(self):
        base = response_fixture('Successful')
        base['RevisionId'] = 'baseline-revision'
        adapter = LambdaDisableTransport(base, self.executor, self.clock.now_ns)
        adapter.dispatch_disable(self.request, 10, lambda: self.events.append('callback'))
        self.proc.stdout = json.dumps(response_fixture('Failed')).encode()
        with self.assertRaises(ValueError):
            adapter.dispatch_disable(self.request, 10, lambda: None)
        self.proc.stdout = json.dumps(response_fixture('Successful')).encode()
        self.assertEqual(adapter.read_configuration(10), response_fixture('Successful'))

    def test_termination_failure_reported_and_request_removed(self):
        self.proc.collect_error = TimeoutError()
        self.proc.cleanup_error = ExecutorError('TERMINATION_OR_REAP_FAILED', ambiguous=True)
        self.assert_error('TERMINATION_OR_REAP_FAILED')
        self.assertFalse(self.proc.path.parent.exists())

    def test_shell_free_session_launch_options_with_mock(self):
        with patch('subprocess.Popen') as popen:
            PosixProcesses().launch(['synthetic'], {'ENV': 'value'})
            options = popen.call_args.kwargs
            self.assertFalse(options['shell'])
            self.assertTrue(options['start_new_session'])
            self.assertTrue(options['close_fds'])
            self.assertEqual(popen.call_args.args[0], ['synthetic'])

    def test_cleanup_escalates_and_reports_unreaped_child(self):
        from unittest.mock import Mock
        process = Mock(pid=12345, returncode=None)
        process.wait.side_effect = subprocess.TimeoutExpired('synthetic', 0.2)
        with patch('os.killpg') as kill:
            self.assert_error('TERMINATION_OR_REAP_FAILED', lambda: PosixProcesses().cleanup(process))
        self.assertEqual([c.args[1] for c in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual([c.kwargs['timeout'] for c in process.wait.call_args_list], [0.2, 0.5])

    def test_stdout_and_stderr_never_attached_to_exception(self):
        self.proc.stderr = b'sensitive payload'
        self.proc.stdout = b'sensitive configuration'
        self.proc.code = 1
        error = self.assert_error('CLI_FAILED')
        self.assertEqual(set(vars(error)), {'category', 'ambiguous'})
        self.assertTrue(error.__suppress_context__)

    def test_read_timeout_is_failure_without_update_claim(self):
        self.proc.collect_error = TimeoutError('sensitive')
        error = self.assert_error('OPERATION_TIMEOUT', lambda:
            self.executor.get_function_configuration({'FunctionName': baseline()['FunctionName']},
                budget=self.budget(), max_attempts=1))
        self.assertFalse(error.ambiguous)
        self.assertTrue(self.proc.cleaned)

    def test_callback_latency_cannot_yield_late_success(self):
        def callback():
            self.clock.advance(10 * NS)
        self.assert_error('OPERATION_TIMEOUT', lambda: self.update(callback=callback))
        self.assertFalse(self.proc.cleaned)
        self.assertEqual(len(self.proc.calls), 0)

    def callback_boundary(self, advance, permitted):
        original = self.budget()
        @contextmanager
        def capture(request):
            with protected_input(request) as path:
                self.path = Path(path)
                yield path
        self.executor.input_factory = capture
        def callback():
            self.events.append('callback')
            self.clock.advance(advance)
        if permitted:
            self.update(budget=original, callback=callback)
            self.assertEqual(self.proc.remaining, (10 * NS - advance) / NS)
        else:
            error = self.assert_error('OPERATION_TIMEOUT', lambda:
                self.update(budget=original, callback=callback))
            self.assertFalse(error.ambiguous)
            self.assertFalse(self.proc.cleaned)
        self.assertEqual(len(self.proc.calls), int(permitted))
        self.assertEqual(self.events, ['callback', 'launch'] if permitted else ['callback'])
        self.assertFalse(self.path.parent.exists())

    def test_callback_with_remaining_time_launches_once(self):
        self.callback_boundary(3 * NS, True)

    def test_callback_exact_expiry_zero_launches_and_input_removed(self):
        self.callback_boundary(10 * NS, False)

    def test_callback_beyond_expiry_zero_launches_and_input_removed(self):
        self.callback_boundary(10 * NS + 1, False)

    def test_callback_one_ns_before_expiry_launches_once(self):
        self.callback_boundary(10 * NS - 1, True)

    def reject_profile(self, category):
        error = self.assert_error(category)
        self.assertEqual(len(self.proc.calls), 0)
        self.assertEqual(self.events, [])
        self.assertEqual(set(vars(error)), {'category', 'ambiguous'})
        self.assertTrue(error.__suppress_context__)

    def test_approved_legacy_sso_profile(self):
        self.update()
        self.assertEqual(len(self.proc.calls), 1)

    def test_approved_sso_session_and_quoted_profile_mapping(self):
        self.config.write_text(f'[profile "{PROFILE}"]\nsso_session = synthetic session\n'
            'sso_account_id = 302154194958\nsso_role_name = SyntheticRole\n'
            '[sso-session "synthetic session"]\nsso_region = us-east-1\n'
            'sso_start_url = https://synthetic.awsapps.com/start\n'
            'sso_registration_scopes = sso:account:access\n')
        self.update()
        self.assertEqual(len(self.proc.calls), 1)

    def test_config_credential_helper_never_executes(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso + 'credential_process = sensitive-helper\n')
        self.reject_profile('CREDENTIAL_PREFLIGHT_REQUIRED')

    def test_credentials_file_helper_is_merged_and_rejected(self):
        self.credentials.write_text(f'[{PROFILE}]\ncredential_process = sensitive-helper\n')
        self.reject_profile('CREDENTIAL_PREFLIGHT_REQUIRED')

    def test_referenced_credentials_profile_helper_rejected(self):
        self.credentials.write_text(f'[{PROFILE}]\nsource_profile = origin\n'
                                   '[origin]\ncredential_process = sensitive-helper\n')
        self.reject_profile('CREDENTIAL_PREFLIGHT_REQUIRED')

    def test_credential_source_and_web_identity_rejected(self):
        for setting in ('credential_source = Ec2InstanceMetadata',
                        'web_identity_token_file = sensitive-token-file'):
            with self.subTest(setting=setting.split('=')[0]):
                self.credentials.write_text(f'[{PROFILE}]\n{setting}\n')
                self.reject_profile('CREDENTIAL_PREFLIGHT_REQUIRED')

    def test_unapproved_role_chain_rejected(self):
        self.credentials.write_text(f'[{PROFILE}]\nrole_arn = synthetic-role\nsource_profile = origin\n'
                                   '[origin]\n' + self.sso)
        self.reject_profile('UNAPPROVED_PROFILE_CHAIN')

    def test_role_without_source_rejected(self):
        self.credentials.write_text(f'[{PROFILE}]\nrole_arn = synthetic-role\n')
        self.reject_profile('UNAPPROVED_PROFILE_CHAIN')

    def test_missing_source_profile_rejected(self):
        self.credentials.write_text(f'[{PROFILE}]\nsource_profile = absent\n')
        self.reject_profile('CREDENTIAL_PROFILE_MISSING')

    def test_cyclic_merged_source_profiles_rejected(self):
        self.credentials.write_text(f'[{PROFILE}]\nsource_profile = origin\n')
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
                              f'[profile origin]\nsource_profile = {PROFILE}\n')
        self.reject_profile('CREDENTIAL_PROFILE_CYCLE')

    def test_default_source_mapping_is_not_inherited_implicitly(self):
        self.credentials.write_text(f'[{PROFILE}]\nsource_profile = default\n')
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
                              '[default]\ncredential_process = sensitive-helper\n')
        self.reject_profile('CREDENTIAL_PREFLIGHT_REQUIRED')

    def test_merged_static_credentials_conflict_with_sso(self):
        self.credentials.write_text(f'[{PROFILE}]\naws_access_key_id = sensitive-fake\n'
                                   'aws_secret_access_key = sensitive-fake\n')
        self.reject_profile('UNAPPROVED_CREDENTIAL_MECHANISM')

    def test_credentials_precedence_over_config_account(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso.replace('302154194958', '000000000000'))
        self.credentials.write_text(f'[{PROFILE}]\nsso_account_id = 302154194958\n')
        self.update()
        self.assertEqual(len(self.proc.calls), 1)

    def test_credentials_override_can_make_approved_config_invalid(self):
        self.credentials.write_text(f'[{PROFILE}]\nsso_account_id = 000000000000\n')
        self.reject_profile('UNAPPROVED_SSO_ACCOUNT')

    def test_unrelated_profile_does_not_override_selected_profile(self):
        self.credentials.write_text('[unrelated]\ncredential_process = sensitive-helper\n'
                                   f'[profile {PROFILE}]\ncredential_process = sensitive-helper\n')
        self.update()
        self.assertEqual(len(self.proc.calls), 1)

    def test_missing_selected_profile_does_not_fall_back(self):
        self.config.write_text('[default]\n' + self.sso)
        self.reject_profile('CREDENTIAL_PROFILE_MISSING')

    def test_credentials_only_sso_profile_supported(self):
        self.config.unlink()
        self.credentials.write_text(f'[{PROFILE}]\n' + self.sso)
        self.update()
        self.assertEqual(len(self.proc.calls), 1)

    def test_invalid_files_fail_safely(self):
        for data in ('sensitive invalid file', f'[{PROFILE}]\nx = a\nx = b',
                     '[DEFAULT]\ncredential_process = sensitive-helper'):
            with self.subTest():
                self.credentials.write_text(data)
                self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_unreadable_file_failure_is_sanitized(self):
        original = Path.open
        def guarded(path, *args, **kwargs):
            if path == self.credentials:
                raise PermissionError('sensitive-path')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'open', guarded):
            self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_explicit_missing_file_fails_closed(self):
        self.executor.environment['AWS_SHARED_CREDENTIALS_FILE'] = str(self.root / 'missing')
        self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_unknown_credential_provider_is_not_authorized(self):
        self.credentials.write_text(f'[{PROFILE}]\nlogin_session = sensitive-new-provider\n')
        self.reject_profile('UNAPPROVED_CREDENTIAL_MECHANISM')

    def test_sso_session_conflict_rejected(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
            'sso_session = synthetic\n[sso-session synthetic]\nsso_region = us-west-2\n')
        self.reject_profile('CONFLICTING_SSO_CONFIGURATION')

    def test_sso_missing_session_rejected(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso + 'sso_session = missing\n')
        self.reject_profile('CREDENTIAL_PREFLIGHT_REQUIRED')

    def test_credentials_file_endpoint_and_history_rejected(self):
        for setting in ('endpoint_url = https://invalid.example', 'cli_history = enabled'):
            self.credentials.write_text(f'[{PROFILE}]\n{setting}\n')
            self.reject_profile('UNAPPROVED_CLI_CONFIGURATION')

    def test_tab_profile_helper_rejected_before_launch(self):
        self.config.write_text(f'[profile\t{PROFILE}]\n' + self.sso +
                               'credential_process = sensitive-helper\n')
        self.reject_profile('CREDENTIAL_PREFLIGHT_REQUIRED')

    def test_tab_duplicate_helper_after_sso_rejected(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
            f'[profile\t{PROFILE}]\ncredential_process = sensitive-helper\n')
        self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_tab_duplicate_helper_before_sso_rejected(self):
        self.config.write_text(f'[profile\t{PROFILE}]\ncredential_process = sensitive-helper\n'
                               f'[profile {PROFILE}]\n' + self.sso)
        self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_quoted_duplicate_aliases_rejected(self):
        for quote in ('"', "'"):
            self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
                f'[profile {quote}{PROFILE}{quote}]\n' + self.sso)
            self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_multiple_space_and_tab_sso_headers_supported(self):
        for separator in ('  ', '\t', ' \t  '):
            self.config.write_text(f'[profile{separator}{PROFILE}]\n' + self.sso)
            before = len(self.proc.calls)
            self.update()
            self.assertEqual(len(self.proc.calls), before + 1)

    def test_duplicate_normalized_sso_without_helper_rejected(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
                               f'[profile   {PROFILE}]\n' + self.sso)
        self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_unusual_botocore_prefix_helper_rejected(self):
        for prefix in ('profile-other', 'profiles', 'profile"suffix"'):
            self.config.write_text(f'[{prefix} {PROFILE}]\n' + self.sso +
                                   'credential_process = sensitive-helper\n')
            self.reject_profile('CREDENTIAL_PREFLIGHT_REQUIRED')

    def test_unusual_prefix_duplicate_rejected(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
            f'[profile-other {PROFILE}]\ncredential_process = sensitive-helper\n')
        self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_invalid_profile_headers_fail_closed(self):
        for header in ('profile', 'profile "unterminated', 'profile a b', 'profile ""'):
            self.config.write_text(f'[profile {PROFILE}]\n' + self.sso + f'[{header}]\n')
            self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_unrelated_standard_profile_preserved(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
                               '[profile unrelated]\ncredential_process = sensitive-helper\n')
        self.update()
        self.assertEqual(len(self.proc.calls), 1)

    def test_duplicate_unrelated_normalized_profile_rejected(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
                               '[profile unrelated]\nregion=us-east-1\n'
                               '[profile\tunrelated]\nregion=us-east-1\n')
        self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_default_profile_alias_duplicate_rejected(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
                               '[default]\nregion=us-east-1\n'
                               '[profile "default"]\nregion=us-east-1\n')
        self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_alternate_header_cross_file_merge_is_not_duplicate(self):
        self.config.write_text(f'[profile\t"{PROFILE}"]\n' +
                               self.sso.replace('302154194958', '000000000000'))
        self.credentials.write_text(f'[{PROFILE}]\nsso_account_id=302154194958\n')
        self.update()
        self.assertEqual(len(self.proc.calls), 1)

    def test_tab_sso_session_supported(self):
        self.config.write_text(f'[profile {PROFILE}]\nsso_session=synthetic\n'
            'sso_account_id=302154194958\nsso_role_name=SyntheticRole\n'
            '[sso-session\tsynthetic]\nsso_region=us-east-1\n'
            'sso_start_url=https://synthetic.awsapps.com/start\n')
        self.update()
        self.assertEqual(len(self.proc.calls), 1)

    def test_duplicate_sso_session_alias_rejected(self):
        self.config.write_text(f'[profile {PROFILE}]\n' + self.sso +
            'sso_session=synthetic\n[sso-session synthetic]\nsso_region=us-east-1\n'
            '[sso-session\t"synthetic"]\nsso_region=us-east-1\n')
        self.reject_profile('INVALID_CREDENTIAL_CONFIGURATION')

    def test_synthetic_botocore_normalization_equivalence(self):
        # In-memory reference of inspected configloader build_profile_map and
        # _parse_section recognition; no Botocore dependency or live config.
        import configparser
        import shlex
        from cli_executor import _section_map
        headers = [f'profile {PROFILE}', f'profile\t{PROFILE}',
                   f'profile   "{PROFILE}"', f"profile '{PROFILE}'",
                   f'profile-other {PROFILE}', f'profiles {PROFILE}',
                   'default', 'profile "name with spaces"']
        for header in headers:
            parser = configparser.RawConfigParser()
            parser.read_string(f'[{header}]\nregion=us-east-1\n')
            reference = {}
            for section in parser.sections():
                if section.startswith('profile'):
                    parts = shlex.split(section)
                    if len(parts) == 2:
                        reference[parts[1]] = section
                elif section == 'default':
                    reference['default'] = section
            self.assertEqual(_section_map(parser, 'profile'), reference)
        self.assertEqual(len(self.proc.calls), 0)

    def test_external_io_tripwires(self):
        for action in (lambda: socket.socket(), lambda: subprocess.run(['aws'])):
            with self.assertRaisesRegex(AssertionError, 'REAL_IO_FORBIDDEN'):
                action()


@unittest.skipUnless(os.name == 'posix', 'POSIX process-group supervision required')
class LocalProcessTests(unittest.TestCase):
    """Only isolated Python children; never instantiate/invoke an AWS CLI executor."""
    def setUp(self):
        for target in ('socket.socket', 'socket.create_connection'):
            block = patch(target, side_effect=AssertionError('NETWORK_FORBIDDEN'))
            block.start()
            self.addCleanup(block.stop)

    def run_child(self, code, seconds=2, limit=4096):
        ops = PosixProcesses()
        child = ops.launch([sys.executable, '-I', '-c', code], {'PATH': '/usr/bin:/bin'})
        try:
            return child, ops.collect(child, OperationBudget(monotonic_ns()+int(seconds*NS), monotonic_ns), limit)
        finally:
            ops.cleanup(child)
            self.assertIsNotNone(child.returncode)

    def test_local_success_and_direct_child_reaped(self):
        child, result = self.run_child('print("local-only")')
        self.assertEqual(result[0], 0)
        self.assertEqual(result[1], b'local-only\n')
        with self.assertRaises(ChildProcessError):
            os.waitpid(child.pid, os.WNOHANG)

    def test_local_deadline_terminates_waiting_child(self):
        with self.assertRaises(TimeoutError):
            self.run_child('import time; time.sleep(5)', seconds=0.15)

    def test_local_term_ignoring_child_requires_kill(self):
        ops = PosixProcesses()
        child = ops.launch([sys.executable, '-I', '-c',
            'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print("ready",flush=True); time.sleep(5)'],
            {'PATH': '/usr/bin:/bin'})
        try:
            with self.assertRaises(TimeoutError):
                ops.collect(child, OperationBudget(monotonic_ns()+500_000_000, monotonic_ns), 4096)
        finally:
            ops.cleanup(child)
        self.assertEqual(child.returncode, -signal.SIGKILL)
        with self.assertRaises(ChildProcessError):
            os.waitpid(child.pid, os.WNOHANG)

    def test_local_output_limit_terminates_child(self):
        with self.assertRaises(ExecutorError) as caught:
            self.run_child('import sys; sys.stdout.write("x"*100000); sys.stdout.flush()', limit=64)
        self.assertEqual(caught.exception.category, 'OUTPUT_LIMIT')


if __name__ == '__main__':
    unittest.main()
