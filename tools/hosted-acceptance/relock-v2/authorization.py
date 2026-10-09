"""Local simulation authority only. No live issuance, execution, or release API.

Requires a trusted, stable, designated local directory. Not a security boundary
against the owning user changing files or initializing another store.
"""
from contextlib import contextmanager
import os
import ctypes
from pathlib import Path
import re
import sqlite3
import stat
import sys


VERSION = 1
SCHEMA = (
    'CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, store_id TEXT NOT NULL, host_id TEXT NOT NULL)',
    "CREATE TABLE authorizations (authorization_id TEXT PRIMARY KEY, scope_digest TEXT NOT NULL, resource_key TEXT NOT NULL, consumed INTEGER NOT NULL CHECK(consumed IN (0,1)), execution_id TEXT UNIQUE, sequence INTEGER NOT NULL, CHECK((consumed=0 AND execution_id IS NULL) OR (consumed=1 AND execution_id IS NOT NULL)))",
    "CREATE TABLE executions (execution_id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL UNIQUE REFERENCES authorizations(authorization_id), resource_key TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state='CLAIMED'), sequence INTEGER NOT NULL)",
    'CREATE TABLE ownership (resource_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id))',
    "CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('PROVISIONED','CLAIMED')), authorization_id TEXT NOT NULL REFERENCES authorizations(authorization_id), execution_id TEXT)",
)


class AuthorizationError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', value):
        raise AuthorizationError('INVALID_IDENTIFIER')


def _digest(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise AuthorizationError('INVALID_SCOPE_DIGEST')


def _local(path):
    # Darwin statvfs translates flags and drops MNT_LOCAL; inspect statfs instead.
    # Darwin's statfs64 fixed prefix ends in f_flags at byte 64 and f_fstypename
    # at byte 72. Oversized storage avoids depending on trailing path arrays.
    if sys.platform != 'darwin':
        raise AuthorizationError('UNSUPPORTED_STORAGE')
    buffer = ctypes.create_string_buffer(4096)
    libc = ctypes.CDLL(None, use_errno=True)
    function = libc.statfs
    function.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
    function.restype = ctypes.c_int
    if function(os.fsencode(path), buffer) != 0:
        raise AuthorizationError('UNSUPPORTED_STORAGE')
    flags = int.from_bytes(buffer.raw[64:68], sys.byteorder)
    filesystem = buffer.raw[72:88].split(b'\0', 1)[0]
    if not flags & 0x1000 or filesystem not in (b'apfs', b'hfs'):
        raise AuthorizationError('UNSUPPORTED_STORAGE')


class AuthorizationStore:
    def __init__(self, path, *, store_id, host_id, storage_check=_local):
        _identifier(store_id)
        _identifier(host_id)
        self.path = Path(path)
        self.store_id, self.host_id = store_id, host_id
        self.storage_check = storage_check  # Trusted policy; not authorization.
        if not self.path.is_absolute():
            raise AuthorizationError('ABSOLUTE_PATH_REQUIRED')

    def _paths(self, *, creating=False):
        # Check all ancestors without resolving away a symlink first.
        for directory in [self.path.parent, *self.path.parent.parents]:
            if directory.is_symlink():
                raise AuthorizationError('UNSAFE_PATH')
        parent = self.path.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
                or stat.S_IMODE(parent.st_mode) != 0o700):
            raise AuthorizationError('UNSAFE_DIRECTORY')
        self.storage_check(self.path.parent)
        for suffix in ('', '-journal', '-wal', '-shm'):
            file = Path(str(self.path) + suffix)
            if not file.exists() and not file.is_symlink():
                if not suffix and not creating:
                    raise AuthorizationError('STORE_MISSING')
                continue
            info = file.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise AuthorizationError('UNSAFE_FILE')
            if suffix in ('-wal', '-shm'):
                raise AuthorizationError('UNSUPPORTED_JOURNAL')

    def initialize(self):
        """Explicit creation only. Parent must already be private and local.

        Failure leaves any created file in place for review; never overwrites it.
        """
        try:
            self._paths(creating=True)
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            with self._connection(validate=False) as db:
                db.execute('BEGIN IMMEDIATE')
                for sql in SCHEMA:
                    db.execute(sql)
                db.execute('INSERT INTO metadata VALUES (1,?,?,?)',
                           (VERSION, self.store_id, self.host_id))
                db.commit()
            directory_fd = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except AuthorizationError:
            raise
        except (OSError, sqlite3.Error):
            raise AuthorizationError('INITIALIZATION_FAILED') from None

    @contextmanager
    def _connection(self, *, validate=True):
        db = None
        try:
            self._paths()
            db = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=0.25,
                                 isolation_level=None)
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('PRAGMA fullfsync=ON')
            if db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
                raise AuthorizationError('UNSUPPORTED_JOURNAL')
            if validate:
                db.execute('BEGIN IMMEDIATE')
                self._validate(db)
            yield db
        except AuthorizationError:
            raise
        except (OSError, sqlite3.Error):
            # A commit failure can be ambiguous: never return a successful claim.
            raise AuthorizationError('STORAGE_FAILURE_OUTCOME_UNCERTAIN') from None
        finally:
            if db is not None:
                try:
                    try:
                        if db.in_transaction:
                            db.rollback()
                    finally:
                        db.close()
                except sqlite3.Error:
                    raise AuthorizationError('STORAGE_CLEANUP_OUTCOME_UNCERTAIN') from None

    def _validate(self, db):
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise AuthorizationError('CORRUPT_STORE')
        definitions = {row[0] for row in db.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")}
        if definitions != set(SCHEMA):
            raise AuthorizationError('INCOMPATIBLE_SCHEMA')
        if db.execute('SELECT * FROM metadata').fetchall() != [(1, VERSION, self.store_id, self.host_id)]:
            raise AuthorizationError('STORE_IDENTITY_OR_VERSION_MISMATCH')
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise AuthorizationError('AMBIGUOUS_STATE')
        auths = db.execute('SELECT * FROM authorizations').fetchall()
        executions = {r[0]: r for r in db.execute('SELECT * FROM executions')}
        ownership = dict(db.execute('SELECT * FROM ownership'))
        events = db.execute('SELECT * FROM events ORDER BY sequence').fetchall()
        if [r[0] for r in events] != list(range(1, len(events) + 1)):
            raise AuthorizationError('AMBIGUOUS_SEQUENCE')
        # This application's append-only, whole-transaction rollback paths use
        # exactly 1..N. AUTOINCREMENT alone does not guarantee gapless numbering.
        # A pristine empty store has no allocator row; every nonempty store has
        # exactly one integer counter equal to its last committed event.
        allocator = db.execute('SELECT name,seq,typeof(seq) FROM sqlite_sequence').fetchall()
        if events:
            if (len(allocator) != 1 or allocator[0][0] != 'events'
                    or allocator[0][2] != 'integer'
                    or type(allocator[0][1]) is not int
                    or not 1 <= allocator[0][1] <= 2**63 - 1
                    or allocator[0][1] != len(events)):
                raise AuthorizationError('AMBIGUOUS_ALLOCATOR')
        elif allocator:
            raise AuthorizationError('AMBIGUOUS_ALLOCATOR')
        expected_events = set()
        for aid, digest, resource, consumed, eid, seq in auths:
            _identifier(aid); _digest(digest); _identifier(resource)
            provision = [r for r in events if r[1:] == ('PROVISIONED', aid, None)]
            if len(provision) != 1:
                raise AuthorizationError('AMBIGUOUS_STATE')
            expected_events.add(provision[0])
            if not consumed:
                if seq != provision[0][0] or eid is not None:
                    raise AuthorizationError('AMBIGUOUS_STATE')
                continue
            _identifier(eid)
            row = executions.get(eid)
            if (not row or row[1:3] != (aid, resource) or row[4:] != ('CLAIMED', seq)
                    or ownership.get(resource) != eid or seq <= provision[0][0]):
                raise AuthorizationError('AMBIGUOUS_STATE')
            _identifier(row[3])
            expected_events.add((seq, 'CLAIMED', aid, eid))
        if (set(events) != expected_events or len(executions) != sum(a[3] for a in auths)
                or len(ownership) != len(executions)):
            raise AuthorizationError('AMBIGUOUS_STATE')

    def inspect(self):
        with self._connection() as db:
            return {table: db.execute('SELECT * FROM ' + table).fetchall()
                    for table in ('metadata', 'authorizations', 'executions', 'ownership', 'events')}

    def provision_test_fixture(self, authorization_id, scope_digest, resource_key):
        """Explicit synthetic fixture provisioning; not human/live approval."""
        _identifier(authorization_id); _digest(scope_digest); _identifier(resource_key)
        with self._connection() as db:
            if db.execute('SELECT 1 FROM authorizations WHERE authorization_id=?', (authorization_id,)).fetchone():
                raise AuthorizationError('AUTHORIZATION_EXISTS')
            # Deferred FK not needed: initial sequence is replaced within transaction.
            db.execute('INSERT INTO authorizations VALUES (?,?,?,0,NULL,0)',
                       (authorization_id, scope_digest, resource_key))
            seq = db.execute("INSERT INTO events(kind,authorization_id) VALUES ('PROVISIONED',?)",
                             (authorization_id,)).lastrowid
            db.execute('UPDATE authorizations SET sequence=? WHERE authorization_id=?', (seq, authorization_id))
            self._validate(db)
            db.commit()

    def claim(self, authorization_id, *, scope_digest, resource_key, execution_id, owner_id):
        for value in (authorization_id, resource_key, execution_id, owner_id):
            _identifier(value)
        _digest(scope_digest)
        with self._connection() as db:
            row = db.execute('SELECT scope_digest,resource_key,consumed FROM authorizations WHERE authorization_id=?',
                             (authorization_id,)).fetchone()
            if row is None:
                raise AuthorizationError('UNKNOWN_AUTHORIZATION')
            if row[:2] != (scope_digest, resource_key):
                raise AuthorizationError('SCOPE_MISMATCH')
            if row[2]:
                raise AuthorizationError('AUTHORIZATION_CONSUMED')
            if db.execute('SELECT 1 FROM ownership WHERE resource_key=?', (resource_key,)).fetchone():
                raise AuthorizationError('RESOURCE_OWNED')
            seq = db.execute("INSERT INTO events(kind,authorization_id,execution_id) VALUES ('CLAIMED',?,?)",
                             (authorization_id, execution_id)).lastrowid
            db.execute('INSERT INTO executions VALUES (?,?,?,?,?,?)',
                       (execution_id, authorization_id, resource_key, owner_id, 'CLAIMED', seq))
            db.execute('INSERT INTO ownership VALUES (?,?)', (resource_key, execution_id))
            db.execute('UPDATE authorizations SET consumed=1,execution_id=?,sequence=? WHERE authorization_id=?',
                       (execution_id, seq, authorization_id))
            self._validate(db)
            db.commit()
            return execution_id
