"""Bounded POSIX AWS CLI transport. Construction/import never invokes AWS.

The caller supplies an approved executable and separately authorizes operations.
This module does not establish account authorization or orchestrate acceptance.
"""

import configparser
from contextlib import contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import selectors
import shlex
import signal
import stat
import subprocess
import tempfile

from admission_window import FUNCTION, SANDBOX, LEDGER_NAMESPACE
from transport import OperationBudget

PROFILE = 'batch-and-batter-dev'
REGION = 'us-east-2'
FUNCTION_ARN = f'arn:aws:lambda:{REGION}:302154194958:function:{FUNCTION}'
OUTPUT_LIMIT = 256 * 1024  # Per stream; raw output never enters exceptions.


class ExecutorError(RuntimeError):
    def __init__(self, category, *, ambiguous=False):
        self.category = category
        self.ambiguous = ambiguous
        super().__init__(f'{category}; outcome={"ambiguous" if ambiguous else "not_verified"}')


@contextmanager
def protected_input(parameters):
    """Random private directory/file; no request data in argv or persistent logs."""
    with tempfile.TemporaryDirectory(prefix='bb-relock-') as directory:
        os.chmod(directory, 0o700)
        fd, path = tempfile.mkstemp(prefix='request-', suffix='.json', dir=directory)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                fd = None
                json.dump(parameters, stream, allow_nan=False)
            yield path
        finally:
            if fd is not None:
                os.close(fd)


class PosixProcesses:
    """Injectable launch/collection/cleanup implementation; no shell or AWS logic."""
    def launch(self, argv, env):
        return subprocess.Popen(argv, env=env, shell=False, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True, close_fds=True)

    def collect(self, process, budget, limit):
        output = [bytearray(), bytearray()]
        with selectors.DefaultSelector() as selector:
            for index, stream in enumerate((process.stdout, process.stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, index)
            while selector.get_map():
                remaining = budget.remaining_seconds()
                for key, _ in selector.select(min(remaining, 0.05)):
                    data = os.read(key.fileobj.fileno(), min(65536, limit + 1))
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    output[key.data].extend(data)
                    if len(output[key.data]) > limit:
                        raise ExecutorError('OUTPUT_LIMIT', ambiguous=True)
            process.wait(timeout=budget.remaining_seconds())
            budget.remaining_seconds()
        return process.returncode, bytes(output[0]), bytes(output[1])

    def cleanup(self, process):
        """TERM group, bounded wait, KILL group, bounded reap. Never unbounded wait.

        Kill the group even when the leader exited: descendants may retain pipes.
        Group membership/escaped descendants cannot be conclusively audited here.
        """
        failed = False
        for sig, interval in ((signal.SIGTERM, 0.2), (signal.SIGKILL, 0.5)):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
            except OSError:
                failed = True
            try:
                process.wait(timeout=interval)
            except subprocess.TimeoutExpired:
                if sig == signal.SIGKILL:
                    failed = True
            except OSError:
                failed = True
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except OSError:
                failed = True
        if failed or process.returncode is None:
            raise ExecutorError('TERMINATION_OR_REAP_FAILED', ambiguous=True)


# Direct IAM Identity Center is the sole approved credential mechanism here.
# Unknown settings fail closed rather than silently enabling another provider.
SSO_FIELDS = {'sso_session', 'sso_account_id', 'sso_role_name', 'sso_start_url',
              'sso_region', 'sso_registration_scopes'}
PROFILE_FIELDS = SSO_FIELDS | {'region', 'output', 'cli_history', 'retry_mode', 'max_attempts'}
PROHIBITED_PROVIDERS = {'credential_process', 'credential_source', 'web_identity_token_file'}


def _profile_file(env, variable, filename):
    raw = env.get(variable, str(Path(env.get('HOME', '')) / '.aws' / filename))
    # Avoid ambient expansion differing between validation and child execution.
    if raw.startswith('~/'):
        raw = str(Path(env.get('HOME', '')) / raw[2:])
    path = Path(raw)
    if not path.is_absolute() or '$' in raw or '~' in raw:
        raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION')
    parser = configparser.RawConfigParser()
    try:
        with path.open(encoding='utf-8') as stream:
            parser.read_file(stream)
    except FileNotFoundError:
        if variable in env:
            raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION') from None
    except (OSError, UnicodeError, configparser.Error):
        raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION') from None
    if parser.defaults():
        raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION')
    env[variable] = str(path)
    return parser


def _section_map(parser, kind):
    """Botocore prefix/shlex recognition, but reject ambiguous aliases.

    build_profile_map accepts any header starting with the kind, including
    unusual first tokens. _parse_section uses its second token as the name.
    Unlike Botocore's last-definition-wins behavior, duplicates fail closed.
    """
    names = {}
    for section in parser.sections():
        if kind == 'profile' and section == 'default':
            name = 'default'
        elif section.startswith(kind):
            try:
                parts = shlex.split(section)
            except ValueError:
                raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION') from None
            if len(parts) != 2 or not parts[1]:
                raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION')
            name = parts[1]
        else:
            continue
        if name in names:
            raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION')
        names[name] = section
    return names


def _safe_settings(parser, section):
    settings = dict(parser.items(section))
    if any(not value or '\n' in value for value in settings.values()):
        raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION')
    if ('endpoint_url' in settings or
            any('endpoint_url' in value for value in settings.values()) or
            settings.get('cli_history', 'disabled') != 'disabled'):
        raise ExecutorError('UNAPPROVED_CLI_CONFIGURATION')
    return settings


def validate_profiles(env):
    """Validate only selected/referenced profile metadata; never resolve credentials.

    Botocore Session.full_config merges credentials sections over config profiles.
    Config profile/session names use shlex; credentials section names are literal.
    No role chaining or alternate providers are authorized by this DEV policy.
    """
    config = _profile_file(env, 'AWS_CONFIG_FILE', 'config')
    credentials = _profile_file(env, 'AWS_SHARED_CREDENTIALS_FILE', 'credentials')
    profiles = _section_map(config, 'profile')
    sessions = _section_map(config, 'sso-session')
    # Preserve global plugin/endpoint/history rejection, including services blocks.
    for parser in (config, credentials):
        for section in parser.sections():
            if section == 'plugins':
                raise ExecutorError('UNAPPROVED_CLI_CONFIGURATION')
            for key, value in parser.items(section):
                if (key == 'endpoint_url' or 'endpoint_url' in value or
                        (key == 'cli_history' and value.strip() != 'disabled')):
                    raise ExecutorError('UNAPPROVED_CLI_CONFIGURATION')

    def effective(name):
        section = profiles.get(name)
        if section is None and not credentials.has_section(name):
            raise ExecutorError('CREDENTIAL_PROFILE_MISSING')
        settings = _safe_settings(config, section) if section is not None else {}
        if credentials.has_section(name):
            settings.update(_safe_settings(credentials, name))
        return settings

    name, visited, chain = PROFILE, set(), []
    while True:
        if name in visited:
            raise ExecutorError('CREDENTIAL_PROFILE_CYCLE')
        visited.add(name)
        settings = effective(name)
        chain.append(settings)
        if PROHIBITED_PROVIDERS & settings.keys():
            raise ExecutorError('CREDENTIAL_PREFLIGHT_REQUIRED')
        if 'source_profile' not in settings:
            break
        name = settings['source_profile']
    if len(chain) != 1 or 'role_arn' in chain[0]:
        raise ExecutorError('UNAPPROVED_PROFILE_CHAIN')
    settings = chain[0]
    if set(settings) - PROFILE_FIELDS:
        raise ExecutorError('UNAPPROVED_CREDENTIAL_MECHANISM')
    if 'sso_session' in settings:
        section = sessions.get(settings['sso_session'])
        if section is None:
            raise ExecutorError('CREDENTIAL_PREFLIGHT_REQUIRED')
        session = _safe_settings(config, section)
        if set(session) - {'sso_start_url', 'sso_region', 'sso_registration_scopes'}:
            raise ExecutorError('UNAPPROVED_CREDENTIAL_MECHANISM')
        for key, value in session.items():
            if key in settings and settings[key] != value:
                raise ExecutorError('CONFLICTING_SSO_CONFIGURATION')
            settings[key] = value
    if not {'sso_account_id', 'sso_role_name', 'sso_start_url', 'sso_region'} <= settings.keys():
        raise ExecutorError('CREDENTIAL_PREFLIGHT_REQUIRED')
    if settings['sso_account_id'] != '302154194958':
        raise ExecutorError('UNAPPROVED_SSO_ACCOUNT')
    if not settings['sso_start_url'].startswith('https://'):
        raise ExecutorError('INVALID_CREDENTIAL_CONFIGURATION')


def controlled_environment(inherited):
    """Retain profile files, not ambient credentials/endpoints/proxy/debug settings."""
    if any(k.startswith('AWS_ENDPOINT_URL') and v for k, v in inherited.items()):
        raise ExecutorError('ENDPOINT_OVERRIDE')
    env = {k: inherited[k] for k in ('HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL',
                                    'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE')
           if k in inherited}
    env.update(AWS_PROFILE=PROFILE, AWS_DEFAULT_PROFILE=PROFILE,
               AWS_REGION=REGION, AWS_DEFAULT_REGION=REGION,
               AWS_MAX_ATTEMPTS='1', AWS_RETRY_MODE='standard',
               AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off', AWS_EC2_METADATA_DISABLED='true',
               AWS_IGNORE_CONFIGURED_ENDPOINT_URLS='true')
    validate_profiles(env)
    return env


class AwsCliExecutor:
    def __init__(self, executable, *, processes=None, input_factory=protected_input,
                 environment=None):
        try:
            path = Path(executable)
            if not path.is_absolute() or path.name != 'aws':
                raise ValueError()
            resolved = path.resolve(strict=True)
            mode = resolved.stat().st_mode
            if (not stat.S_ISREG(mode) or not os.access(resolved, os.X_OK)
                    or mode & (stat.S_IWGRP | stat.S_IWOTH) or os.name != 'posix'):
                raise ValueError()
        except (OSError, ValueError, TypeError):
            raise ExecutorError('INVALID_EXECUTABLE') from None
        self.executable = str(resolved)
        self.processes = processes if processes is not None else PosixProcesses()
        self.input_factory = input_factory
        self.environment = dict(os.environ if environment is None else environment)

    def update_function_configuration(self, parameters, *, budget, max_attempts, on_dispatch):
        return self._execute('update-function-configuration', parameters, budget,
                             max_attempts, on_dispatch)

    def get_function_configuration(self, parameters, *, budget, max_attempts):
        return self._execute('get-function-configuration', parameters, budget, max_attempts, None)

    @staticmethod
    def _request(operation, parameters, max_attempts):
        update = operation == 'update-function-configuration'
        wanted = {'FunctionName', 'RevisionId', 'Environment'} if update else {'FunctionName'}
        if (type(max_attempts) is not int or max_attempts != 1
                or not isinstance(parameters, dict) or set(parameters) != wanted
                or parameters.get('FunctionName') != FUNCTION):
            raise ExecutorError('INVALID_REQUEST')
        if update:
            revision = parameters['RevisionId']
            env = parameters['Environment']
            if (not isinstance(revision, str) or not revision.strip()
                    or not isinstance(env, dict) or set(env) != {'Variables'}
                    or not isinstance(env['Variables'], dict)
                    or any(not isinstance(k, str) or not isinstance(v, str)
                           for k, v in env['Variables'].items())):
                raise ExecutorError('INVALID_REQUEST')
            variables = env['Variables']
            if (variables.get('PAYMENT_START_ENABLED') != 'false'
                    or variables.get('STRIPE_ACCOUNT_ID') != SANDBOX
                    or variables.get('STRIPE_LEDGER_ACCOUNT_ID') != SANDBOX
                    or variables.get('STRIPE_LEDGER_NAMESPACE') != LEDGER_NAMESPACE):
                raise ExecutorError('IDENTITY_OR_ADMISSION_MISMATCH')
        return deepcopy(parameters)

    @staticmethod
    def _response(stdout, parameters, update):
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        def invalid_constant(value):
            raise ValueError()
        try:
            response = json.loads(stdout.decode('utf-8'), object_pairs_hook=unique,
                                  parse_constant=invalid_constant)
            if not isinstance(response, dict):
                raise ValueError()
            for key in ('RevisionId', 'FunctionName', 'FunctionArn', 'CodeSha256', 'State', 'LastUpdateStatus'):
                if not isinstance(response[key], str) or not response[key].strip():
                    raise ValueError()
            if response['FunctionName'] != FUNCTION or response['FunctionArn'] != FUNCTION_ARN:
                raise ValueError()
            if response['State'] not in ('Pending', 'Active', 'Inactive', 'Failed'):
                raise ValueError()
            if response['LastUpdateStatus'] not in ('Successful', 'InProgress', 'Failed'):
                raise ValueError()
            env = response['Environment']
            if not isinstance(env, dict) or set(env) != {'Variables'} or not isinstance(env['Variables'], dict):
                raise ValueError()
            if any(not isinstance(k, str) or not isinstance(v, str) for k, v in env['Variables'].items()):
                raise ValueError()
            if update and (env != parameters['Environment'] or response['RevisionId'] == parameters['RevisionId']):
                raise ValueError()
            return response  # Preserve optional fields, never fill from baseline.
        except (ValueError, KeyError, TypeError, UnicodeError, RecursionError):
            raise ExecutorError('INVALID_RESPONSE', ambiguous=update) from None

    def _execute(self, operation, parameters, budget: OperationBudget, max_attempts, callback):
        update = operation == 'update-function-configuration'
        process = None
        try:
            budget.remaining_seconds()
            request = self._request(operation, parameters, max_attempts)
            if update and not callable(callback):
                raise ExecutorError('INVALID_CALLBACK')
            budget.remaining_seconds()
            env = controlled_environment(self.environment)
            budget.remaining_seconds()
            with self.input_factory(request) as path:
                budget.remaining_seconds()
                argv = [self.executable, 'lambda', operation, '--profile', PROFILE,
                        '--region', REGION, '--no-cli-pager', '--no-cli-auto-prompt',
                        '--no-paginate', '--output', 'json', '--color', 'off',
                        '--cli-connect-timeout', '1', '--cli-read-timeout', '1',
                        '--cli-input-json', 'file://' + str(path)]
                launch = self.processes.launch
                budget.remaining_seconds()
                if update:
                    try:
                        callback()
                    except BaseException:
                        raise ExecutorError('CALLBACK_FAILED') from None
                # Callback records intent, not launch. Never start with an expired budget.
                budget.remaining_seconds()
                try:
                    process = launch(argv, env)
                except BaseException:
                    # A launcher exception cannot prove no request was transmitted.
                    raise ExecutorError('LAUNCH_FAILED', ambiguous=update) from None
                try:
                    budget.remaining_seconds()
                    code, stdout, stderr = self.processes.collect(process, budget, OUTPUT_LIMIT)
                    budget.remaining_seconds()
                    if not isinstance(stdout, bytes) or not isinstance(stderr, bytes):
                        raise ExecutorError('INVALID_OUTPUT', ambiguous=update)
                    if len(stdout) > OUTPUT_LIMIT or len(stderr) > OUTPUT_LIMIT:
                        raise ExecutorError('OUTPUT_LIMIT', ambiguous=update)
                    if code != 0:
                        category = 'REVISION_CONFLICT' if b'PreconditionFailedException' in stderr else 'CLI_FAILED'
                        raise ExecutorError(category, ambiguous=update)
                    if stderr.strip():
                        raise ExecutorError('UNEXPECTED_STDERR', ambiguous=update)
                    response = self._response(stdout, request, update)
                    budget.remaining_seconds()
                finally:
                    self.processes.cleanup(process)
                budget.remaining_seconds()
            budget.remaining_seconds()
            return response
        except ExecutorError as error:
            raise ExecutorError(error.category, ambiguous=error.ambiguous) from None
        except (TimeoutError, subprocess.TimeoutExpired):
            raise ExecutorError('OPERATION_TIMEOUT', ambiguous=process is not None and update) from None
        except BaseException:
            raise ExecutorError('EXECUTOR_FAILED', ambiguous=process is not None and update) from None
