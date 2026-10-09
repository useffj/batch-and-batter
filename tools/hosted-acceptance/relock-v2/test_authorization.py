"""Synthetic local SQLite tests; children only test claims and process death."""
from contextlib import closing
import multiprocessing as mp
import os
from pathlib import Path
import socket
import sqlite3
import tempfile
from threading import Barrier, Thread
import unittest
from unittest.mock import patch

from authorization import AuthorizationStore, AuthorizationError

DIGEST = 'a' * 64


def store(path):
    return AuthorizationStore(path, store_id='synthetic-store', host_id='synthetic-host')


def claim(s, aid='auth', eid='exec'):
    return s.claim(aid, scope_digest=DIGEST, resource_key='resource', execution_id=eid, owner_id='owner-gone')


def child_claim(path, barrier, output, index, die=False):
    # Child processes cannot use network or SDKs either.
    import sys
    sys.modules.update(boto3=None, botocore=None, stripe=None)
    with patch('socket.socket', side_effect=AssertionError('NETWORK_FORBIDDEN')):
        if barrier:
            barrier.wait(5)
        try:
            result = claim(store(path), eid='exec' + str(index))
            if die:
                os._exit(17)  # Deliberate abrupt exit AFTER committed claim.
            output.put(('won', result))
        except AuthorizationError as error:
            output.put(('lost', error.code))


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'authority.db'
        os.chmod(self.temp.name, 0o700)
        self.s = store(self.path)
        for target in ('socket.socket', 'socket.create_connection', 'subprocess.Popen', 'os.system'):
            patcher = patch(target, side_effect=AssertionError('EXTERNAL_IO_FORBIDDEN'))
            patcher.start(); self.addCleanup(patcher.stop)

    def fixture(self):
        self.s.initialize()
        self.s.provision_test_fixture('auth', DIGEST, 'resource')

    def rejected(self, operation):
        with self.assertRaises(AuthorizationError) as caught:
            operation()
        self.assertNotIn(str(self.path), str(caught.exception))
        return caught.exception.code

    def test_explicit_initialization_and_reopen(self):
        self.s.initialize()
        self.assertEqual(store(self.path).inspect()['metadata'], [(1, 1, 'synthetic-store', 'synthetic-host')])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.rejected(self.s.initialize)

    def test_missing_reopen_never_creates(self):
        self.rejected(self.s.inspect)
        self.assertFalse(self.path.exists())

    def test_unknown_authorization(self):
        self.s.initialize()
        self.assertEqual(self.rejected(lambda: claim(self.s)), 'UNKNOWN_AUTHORIZATION')
        self.assertEqual(self.s.inspect()['executions'], [])

    def test_schema_version_mismatch(self):
        self.fixture()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE metadata SET version=99')
        self.rejected(lambda: claim(self.s))

    def test_store_and_host_identity_mismatch(self):
        self.fixture()
        for sid, hid in [('other', 'synthetic-host'), ('synthetic-store', 'other')]:
            s = AuthorizationStore(self.path, store_id=sid, host_id=hid)
            self.rejected(lambda: claim(s))

    def test_duplicate_fixture_rejected(self):
        self.fixture()
        before = self.s.inspect()
        self.rejected(lambda: self.s.provision_test_fixture('auth', DIGEST, 'resource'))
        self.assertEqual(before, self.s.inspect())

    def test_claim_once_and_restart(self):
        self.fixture()
        self.assertEqual(claim(self.s), 'exec')
        reopened = store(self.path)
        before = reopened.inspect()
        self.assertEqual(before['ownership'], [('resource', 'exec')])
        self.assertEqual(before['authorizations'][0][3:5], (1, 'exec'))
        self.rejected(lambda: claim(reopened, eid='replacement'))
        self.assertEqual(before, reopened.inspect())

    def test_different_authorization_same_resource(self):
        self.fixture()
        self.s.provision_test_fixture('other', DIGEST, 'resource')
        claim(self.s)
        self.assertEqual(self.rejected(lambda: claim(self.s, 'other', 'exec2')), 'RESOURCE_OWNED')
        self.assertEqual(len(self.s.inspect()['executions']), 1)

    def test_wrong_scope_or_resource(self):
        self.fixture()
        for digest, resource in [('b' * 64, 'resource'), (DIGEST, 'other')]:
            self.rejected(lambda: self.s.claim('auth', scope_digest=digest, resource_key=resource,
                                             execution_id='exec', owner_id='owner'))
        self.assertEqual(self.s.inspect()['executions'], [])

    def test_thread_claims_exactly_one_winner(self):
        self.fixture()
        barrier = Barrier(3)
        results = []
        def compete(index):
            barrier.wait(3)
            try:
                claim(store(self.path), eid='exec' + str(index))
                results.append('won')
            except AuthorizationError:
                results.append('lost')
        threads = [Thread(target=compete, args=(i,), daemon=True) for i in range(2)]
        for thread in threads: thread.start()
        barrier.wait(3)
        for thread in threads:
            thread.join(4)
            self.assertFalse(thread.is_alive())
        self.assertCountEqual(results, ['won', 'lost'])
        self.assertEqual(len(self.s.inspect()['executions']), 1)
        self.assertEqual(len(self.s.inspect()['events']), 2)

    def test_independent_process_claims_exactly_one_winner(self):
        self.fixture()
        ctx = mp.get_context('spawn')
        barrier, output = ctx.Barrier(3), ctx.Queue()
        children = [ctx.Process(target=child_claim, args=(str(self.path), barrier, output, i)) for i in range(2)]
        try:
            for child in children: child.start()
            barrier.wait(8)
            results = [output.get(timeout=8) for _ in children]
            for child in children:
                child.join(8)
                self.assertEqual(child.exitcode, 0)
            self.assertCountEqual([r[0] for r in results], ['won', 'lost'])
            snapshot = self.s.inspect()
            self.assertEqual(len(snapshot['executions']), 1)
            self.assertEqual(len(snapshot['ownership']), 1)
            self.assertEqual(len(snapshot['events']), 2)
        finally:
            for child in children:
                if child.is_alive(): child.terminate()
                child.join(3)
            output.close(); output.join_thread()

    def test_abrupt_owner_death_preserves_claim(self):
        self.fixture()
        ctx = mp.get_context('spawn')
        child = ctx.Process(target=child_claim, args=(str(self.path), None, None, 1, True))
        try:
            child.start(); child.join(8)
            self.assertEqual(child.exitcode, 17)
            reopened = store(self.path)
            self.rejected(lambda: claim(reopened))
            self.assertEqual(reopened.inspect()['executions'][0][3:5], ('owner-gone', 'CLAIMED'))
        finally:
            if child.is_alive(): child.terminate()
            child.join(3)

    def test_corruption_fails_closed(self):
        self.fixture()
        self.path.write_bytes(b'corrupt synthetic database')
        before = self.path.read_bytes()
        self.rejected(lambda: claim(self.s))
        self.assertEqual(self.path.read_bytes(), before)

    def test_ambiguous_records_fail_closed(self):
        self.fixture(); claim(self.s)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('DELETE FROM ownership')
        self.rejected(self.s.inspect)
        self.rejected(lambda: claim(self.s))

    def test_malformed_fixture_fails_closed(self):
        self.fixture()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE authorizations SET scope_digest='TEST_SECRET_INVALID'")
        code = self.rejected(lambda: claim(self.s))
        self.assertNotIn('TEST_SECRET', code)

    def test_commit_failure_rolls_back_complete_claim(self):
        self.fixture()
        before = self.s.inspect()
        original = sqlite3.connect
        class Failure(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('TEST_SECRET_COMMIT')
        with patch('authorization.sqlite3.connect', side_effect=lambda *a, **kw: original(*a, factory=Failure, **kw)):
            code = self.rejected(lambda: claim(self.s))
        self.assertNotIn('TEST_SECRET', code)
        self.assertEqual(self.s.inspect(), before)

    def test_constraint_failure_rolls_back_event(self):
        self.fixture(); claim(self.s)
        self.s.provision_test_fixture('other', DIGEST, 'different')
        before = self.s.inspect()
        self.rejected(lambda: self.s.claim('other', scope_digest=DIGEST, resource_key='different',
                                         execution_id='exec', owner_id='owner'))
        self.assertEqual(before, self.s.inspect())

    def test_busy_database_denies_claim(self):
        self.fixture()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('BEGIN IMMEDIATE')
            self.rejected(lambda: claim(self.s))
        self.assertEqual(self.s.inspect()['executions'], [])

    def test_unsafe_permissions(self):
        self.fixture()
        for path, safe, unsafe in [(self.path, 0o600, 0o644), (self.path.parent, 0o700, 0o755)]:
            os.chmod(path, unsafe)
            try: self.rejected(lambda: claim(self.s))
            finally: os.chmod(path, safe)

    def test_symlink_rejected(self):
        self.fixture()
        alias = self.path.parent / 'alias'
        alias.symlink_to(self.path)
        self.rejected(lambda: store(alias).inspect())

    def test_auxiliary_permissions_rejected(self):
        self.fixture()
        auxiliary = Path(str(self.path) + '-journal')
        auxiliary.write_bytes(b'')
        os.chmod(auxiliary, 0o644)
        self.rejected(lambda: claim(self.s))

    def test_unsupported_storage_policy(self):
        def unsupported(path): raise AuthorizationError('UNSUPPORTED_STORAGE')
        s = AuthorizationStore(self.path, store_id='s', host_id='h', storage_check=unsupported)
        self.rejected(s.initialize)
        self.assertFalse(self.path.exists())

    def test_no_release_or_live_api(self):
        for name in ('release', 'close_execution', 'enable', 'run', 'publish_pay'):
            self.assertFalse(hasattr(self.s, name))
        with self.assertRaises(AssertionError): socket.socket()

    def test_commit_acknowledgement_failure_retains_consumption(self):
        self.fixture()
        original = sqlite3.connect
        class Ambiguous(sqlite3.Connection):
            def commit(self):
                super().commit()
                raise sqlite3.OperationalError('TEST_SECRET_AFTER_COMMIT')
        with patch('authorization.sqlite3.connect', side_effect=lambda *a, **kw: original(*a, factory=Ambiguous, **kw)):
            self.assertIn('UNCERTAIN', self.rejected(lambda: claim(self.s)))
        self.assertEqual(len(self.s.inspect()['executions']), 1)
        self.assertEqual(self.rejected(lambda: claim(store(self.path))), 'AUTHORIZATION_CONSUMED')

    def test_distinct_authorizations_compete_for_resource(self):
        self.fixture()
        self.s.provision_test_fixture('other', DIGEST, 'resource')
        barrier, results = Barrier(3), []
        def compete(aid):
            barrier.wait(3)
            try:
                claim(store(self.path), aid, 'exec-' + aid)
                results.append('won')
            except AuthorizationError:
                results.append('lost')
        threads = [Thread(target=compete, args=(aid,), daemon=True) for aid in ('auth', 'other')]
        for thread in threads: thread.start()
        barrier.wait(3)
        for thread in threads:
            thread.join(4)
            self.assertFalse(thread.is_alive())
        self.assertCountEqual(results, ['won', 'lost'])
        snapshot = self.s.inspect()
        self.assertEqual(sum(row[3] for row in snapshot['authorizations']), 1)
        self.assertEqual(len(snapshot['ownership']), 1)

    def test_missing_after_initialization_does_not_replace(self):
        self.fixture()
        self.path.unlink()
        self.rejected(lambda: claim(self.s))
        self.assertFalse(self.path.exists())

    def test_schema_definition_change_rejected(self):
        self.fixture()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE unexpected (value TEXT)')
        self.rejected(lambda: claim(self.s))

    def test_hardlink_rejected(self):
        self.fixture()
        os.link(self.path, self.path.parent / 'hardlink')
        self.rejected(lambda: claim(self.s))

    def test_wrong_owner_rejected(self):
        self.fixture()
        with patch('authorization.os.getuid', return_value=os.getuid() + 1):
            self.rejected(lambda: claim(self.s))

    def test_sequence_corruption_rejected(self):
        self.fixture()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE authorizations SET sequence=999')
        self.rejected(lambda: claim(self.s))

    def raw_snapshot(self):
        with closing(sqlite3.connect(self.path)) as db:
            return {table: db.execute('SELECT * FROM ' + table + ' ORDER BY rowid').fetchall()
                    for table in ('metadata', 'authorizations', 'executions',
                                  'ownership', 'events', 'sqlite_sequence')}

    def assert_corruption_blocks_writes(self):
        before = self.raw_snapshot()
        for operation in (lambda: claim(self.s),
                          lambda: self.s.provision_test_fixture('new', DIGEST, 'new-resource'),
                          store(self.path).inspect):
            self.assertEqual(self.rejected(operation), 'AMBIGUOUS_ALLOCATOR')
            self.assertEqual(before, self.raw_snapshot())
        self.assertEqual(before['executions'], [])
        self.assertEqual(before['ownership'], [])
        self.assertEqual(before['authorizations'][0][3:5], (0, None))
        self.assertEqual(len(before['events']), 1)

    def test_allocator_original_high_counter_bypass_closed(self):
        self.fixture()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE sqlite_sequence SET seq=100 WHERE name='events'")
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
        self.assert_corruption_blocks_writes()

    def test_allocator_low_missing_duplicate_and_unexpected_rows(self):
        for statement in (
            "UPDATE sqlite_sequence SET seq=0",
            "DELETE FROM sqlite_sequence",
            "INSERT INTO sqlite_sequence VALUES('events',1)",
            "INSERT INTO sqlite_sequence VALUES('unexpected',1)",
            "UPDATE sqlite_sequence SET name='unexpected'",
        ):
            with self.subTest(statement=statement):
                # Independent synthetic store for each corruption case.
                self.path = self.path.parent / ('case' + str(len(list(self.path.parent.iterdir()))) + '.db')
                self.s = store(self.path)
                self.fixture()
                with closing(sqlite3.connect(self.path)) as db, db:
                    db.execute(statement)
                self.assert_corruption_blocks_writes()

    def test_allocator_invalid_types_and_integer_boundaries(self):
        for index, value in enumerate((None, -1, -(2**63), 2**63-1, 1.0,
                                       '1', 'TEST_SECRET_COUNTER', b'1', float(2**63))):
            with self.subTest(index=index):
                self.path = self.path.parent / ('invalid' + str(index) + '.db')
                self.s = store(self.path)
                self.fixture()
                with closing(sqlite3.connect(self.path)) as db, db:
                    db.execute('UPDATE sqlite_sequence SET seq=?', (value,))
                self.assert_corruption_blocks_writes()

    def test_allocator_empty_and_valid_progression(self):
        self.s.initialize()
        self.assertEqual(self.raw_snapshot()['sqlite_sequence'], [])
        self.s.inspect()
        self.s.provision_test_fixture('auth', DIGEST, 'resource')
        claim(self.s)
        self.s.provision_test_fixture('other', DIGEST, 'different')
        self.s.claim('other', scope_digest=DIGEST, resource_key='different',
                     execution_id='other-exec', owner_id='owner')
        self.assertEqual([r[0] for r in self.raw_snapshot()['events']], [1, 2, 3, 4])
        self.assertEqual(self.raw_snapshot()['sqlite_sequence'], [('events', 4)])
        store(self.path).inspect()

    def test_allocator_empty_store_with_counter_is_rejected(self):
        self.s.initialize()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("INSERT INTO sqlite_sequence VALUES('events',0)")
        before = self.raw_snapshot()
        self.assertEqual(self.rejected(lambda: self.s.provision_test_fixture('auth', DIGEST, 'resource')),
                         'AMBIGUOUS_ALLOCATOR')
        self.assertEqual(before, self.raw_snapshot())

    def test_post_mutation_validation_rolls_back_claim_and_provision(self):
        self.fixture()
        for operation in (lambda: claim(self.s),
                          lambda: self.s.provision_test_fixture('other', DIGEST, 'different')):
            with self.subTest(operation=operation):
                before = self.raw_snapshot()
                original = self.s._validate
                calls = []
                def inject(db):
                    calls.append(db)
                    if len(calls) == 2:
                        self.assertTrue(db.in_transaction)
                        self.assertGreater(db.execute('SELECT COUNT(*) FROM events').fetchone()[0],
                                           len(before['events']))
                        db.execute('UPDATE sqlite_sequence SET seq=100')
                    original(db)
                with patch.object(self.s, '_validate', side_effect=inject):
                    self.assertEqual(self.rejected(operation), 'AMBIGUOUS_ALLOCATOR')
                self.assertEqual(len(calls), 2)
                self.assertIs(calls[0], calls[1])
                self.assertEqual(before, self.raw_snapshot())
                self.s.inspect()

    def test_first_provision_rollback_restores_empty_allocator(self):
        self.s.initialize()
        before = self.raw_snapshot()
        original = self.s._validate
        count = 0
        def inject(db):
            nonlocal count
            count += 1
            if count == 2:
                db.execute('UPDATE sqlite_sequence SET seq=100')
            original(db)
        with patch.object(self.s, '_validate', side_effect=inject):
            self.rejected(lambda: self.s.provision_test_fixture('auth', DIGEST, 'resource'))
        self.assertEqual(before, self.raw_snapshot())
        self.s.provision_test_fixture('auth', DIGEST, 'resource')
        self.assertEqual(self.raw_snapshot()['sqlite_sequence'], [('events', 1)])
