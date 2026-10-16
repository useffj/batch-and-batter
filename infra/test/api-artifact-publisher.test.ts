import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const api = require(
  resolve(__dirname, '../../../scripts/publish-api-artifact.cjs'),
);
const policy = require(
  resolve(__dirname, '../../../config/artifact-protection-policy.json'),
);
function fixture(versionId = 'version-1') {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-contract-'));
  const data = Buffer.from('exports.handler = async () => {};');
  const local = Buffer.alloc(40);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(api.crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(10, 26);
  local.write('handler.js', 30);
  const central = Buffer.alloc(56);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(api.crc32(data), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(10, 28);
  central.write('handler.js', 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(56, 12);
  end.writeUInt32LE(40 + data.length, 16);
  const bytes = Buffer.concat([local, data, central, end]);
  const input = {
    operationId: '12345678-1234-4234-8234-123456789abc',
    artifactId: 'approved-api',
    approvalReference: 'owner:synthetic',
    sourceCommit: 'a'.repeat(40),
    sha256: api.hash(bytes),
    bytes: bytes.length,
    buildEvidence: {
      handler: 'handler.handler',
      files: ['handler.js'],
      sha256: api.hash(bytes),
      bytes: bytes.length,
      lockSha256: 'b'.repeat(64),
      node: 'v24.19.0',
    },
  };
  type ObjectRecord = {
    Key: string;
    VersionId: string;
    IsLatest: boolean;
    Body: Buffer;
    Metadata: Record<string, string>;
    ServerSideEncryption: string;
    SSEKMSKeyId: string;
    BucketKeyEnabled: boolean;
  };
  let object: ObjectRecord | undefined;
  const state = {
    puts: 0,
    mode: '',
    markers: false,
    extra: false,
    complete: true,
    readFail: false,
    corrupt: false,
    wrongCurrent: false,
    wrongReturned: false,
  };
  const rolePolicy = require(
    resolve(__dirname, '../../../config/api-artifact-publisher-policy.json'),
  );
  const config = {
    identityPolicy: api.materializeIdentityPolicy(
      `api-releases/${input.operationId}/${input.sha256}.zip`,
    ),
    permissionsBoundary: rolePolicy.permissionsBoundary,
    trustPolicy: rolePolicy.trustPolicy,
    verifiedAt: new Date().toISOString(),
    approvalReference: input.approvalReference,
    sha256: input.sha256,
    sourceCommit: input.sourceCommit,
    key: `api-releases/${input.operationId}/${input.sha256}.zip`,
    account: api.ACCOUNT,
    region: 'us-east-2',
    bucket: api.BUCKET,
    publisherArn: api.ROLE,
    publicationAuthorized: true,
    active: true,
    policy,
    versioning: 'Enabled',
    currentOnlyRetention: true,
    noncurrentDays: 30,
    abortMultipartDays: 1,
    currentExpiration: false,
    kmsKey: api.KMS,
    bucketKeyEnabled: false,
  };
  const deps = {
    mode: 'mock-only',
    bytes,
    journal: api.createJournal(directory),
    adapters: {
      kind: 'mock',
      protection: { inspect: async () => config },
      kms: {
        inspect: async () => ({
          enabled: true,
          manager: 'AWS',
          viaService: 's3.us-east-2.amazonaws.com',
          callerAccount: api.ACCOUNT,
          contextArn: `arn:aws:s3:::${api.BUCKET}/api-releases/${input.operationId}/${input.sha256}.zip`,
        }),
      },
      s3: {
        history: async () => ({
          complete: state.complete,
          versions: [
            ...(object ? [object] : []),
            ...(state.extra
              ? [{ Key: 'history', VersionId: 'old', IsLatest: false }]
              : []),
          ],
          deleteMarkers: state.markers ? [{}] : [],
        }),
        put: async (r: {
          Key: string;
          Body: Buffer;
          Metadata: Record<string, string>;
          IfNoneMatch: string;
          ChecksumSHA256: string;
          ExpectedBucketOwner: string;
          ServerSideEncryption: string;
          SSEKMSKeyId: string;
          BucketKeyEnabled: boolean;
        }) => {
          state.puts++;
          assert.equal(r.IfNoneMatch, '*');
          assert.equal(r.ExpectedBucketOwner, api.ACCOUNT);
          assert.equal(
            r.ChecksumSHA256,
            Buffer.from(input.sha256, 'hex').toString('base64'),
          );
          assert.equal(r.SSEKMSKeyId, api.KMS);
          assert.equal(r.ServerSideEncryption, 'aws:kms');
          assert.equal(r.BucketKeyEnabled, false);
          assert.ok(!('ACL' in r));
          assert.ok(!('Tagging' in r));
          if (state.mode === '409' || state.mode === '412')
            throw Object.assign(Error('private error must not escape'), {
              statusCode: Number(state.mode),
            });
          object = {
            ...r,
            Body: Buffer.from(r.Body),
            VersionId: versionId,
            IsLatest: true,
          };
          if (state.mode === 'lost') throw Error('private transport details');
          return {
            VersionId: state.wrongReturned ? 'wrong-version' : versionId,
          };
        },
        get: async (r: { VersionId: string }) => {
          assert.equal(r.VersionId, versionId);
          if (state.readFail) throw Error('READ_FAILED');
          return {
            ...object,
            Body: state.corrupt ? Buffer.from('bad') : object?.Body,
          };
        },
        head: async () => ({
          VersionId: state.wrongCurrent ? 'unexpected' : versionId,
        }),
      },
    },
  };
  return {
    input,
    deps,
    state,
    config,
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test('successful request, durable receipt and repeated operation only read back', async () => {
  const f = fixture();
  try {
    const r = await api.publish(f.input, f.deps);
    assert.equal(r.state, 'VERIFIED');
    assert.equal(r.deploymentAuthorized, false);
    assert.equal(r.simulated, true);
    assert.equal(
      r.key,
      `api-releases/${f.input.operationId}/${f.input.sha256}.zip`,
    );
    assert.equal(
      JSON.parse(
        readFileSync(join(f.directory, f.input.operationId + '.json'), 'utf8'),
      ).versionId,
      'version-1',
    );
    await api.publish(f.input, f.deps);
    assert.equal(f.state.puts, 1);
    await assert.rejects(
      api.publish({ ...f.input, approvalReference: 'different' }, f.deps),
      /OPERATION_IDENTITY_CHANGED/,
    );
  } finally {
    f.cleanup();
  }
});
for (const mode of ['lost', '409', '412'])
  test(`safe ${mode} recovery preserves identity`, async () => {
    const f = fixture();
    try {
      f.state.mode = mode;
      await assert.rejects(
        api.publish(f.input, f.deps),
        /ACKNOWLEDGEMENT_UNCERTAIN|CONFLICT_RECONCILIATION_REQUIRED|PRECONDITION_FAILED/,
      );
      const before = f.deps.journal.load(f.input.operationId);
      if (mode === 'lost')
        assert.equal((await api.publish(f.input, f.deps)).state, 'VERIFIED');
      else
        await assert.rejects(
          api.publish(f.input, f.deps),
          /RECONCILIATION_REQUIRED|OPERATION_REJECTED/,
        );
      assert.equal(f.state.puts, 1);
      assert.equal(f.deps.journal.load(f.input.operationId).key, before.key);
    } finally {
      f.cleanup();
    }
  });
for (const failure of [
  'readFail',
  'corrupt',
  'wrongCurrent',
  'wrongReturned',
] as const)
  test(`${failure} blocks verification without another write`, async () => {
    const f = fixture();
    try {
      f.state[failure] = true;
      await assert.rejects(api.publish(f.input, f.deps));
      assert.equal(f.deps.journal.load(f.input.operationId).state, 'UNCERTAIN');
      f.state[failure] = false;
      if (failure === 'wrongReturned')
        await assert.rejects(api.publish(f.input, f.deps), /VERSION_MISMATCH/);
      else assert.equal((await api.publish(f.input, f.deps)).state, 'VERIFIED');
      assert.equal(f.state.puts, 1);
    } finally {
      f.cleanup();
    }
  });
for (const problem of [
  'markers',
  'extra',
  'incomplete',
  'approval',
  'source',
  'protection',
  'principal',
  'kms',
  'retention',
  'policy',
])
  test(`reject ${problem} before writing`, async () => {
    const f = fixture();
    try {
      if (problem === 'markers') f.state.markers = true;
      if (problem === 'extra') f.state.extra = true;
      if (problem === 'incomplete') f.state.complete = false;
      if (problem === 'approval') f.input.approvalReference = '';
      if (problem === 'source') f.deps.bytes[5] ^= 1;
      if (problem === 'protection') f.config.active = false;
      if (problem === 'principal') f.config.publisherArn = 'wrong';
      if (problem === 'kms') f.config.bucketKeyEnabled = true;
      if (problem === 'retention') f.config.currentExpiration = true;
      if (problem === 'policy') f.config.policy = {};
      await assert.rejects(api.publish(f.input, f.deps));
      assert.equal(f.state.puts, 0);
    } finally {
      f.cleanup();
    }
  });
test('existing object collision is never adopted by a new journal', async () => {
  const f = fixture();
  try {
    await api.publish(f.input, f.deps);
    const other = mkdtempSync(join(tmpdir(), 'other-journal-'));
    try {
      await assert.rejects(
        api.publish(f.input, { ...f.deps, journal: api.createJournal(other) }),
        /EXISTING_KEY_COLLISION/,
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    assert.equal(f.state.puts, 1);
  } finally {
    f.cleanup();
  }
});
test('concurrent invocation and stale journal lock fail closed', async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([
      api.publish(f.input, f.deps),
      api.publish(f.input, f.deps),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(f.state.puts, 1);
    const release = f.deps.journal.acquire(f.input.operationId);
    await assert.rejects(api.publish(f.input, f.deps), /EEXIST/);
    release();
  } finally {
    f.cleanup();
  }
});
test('journal failure occurs before any PUT', async () => {
  const f = fixture();
  try {
    f.deps.journal.save = () => {
      throw Error('DISK_FULL');
    };
    await assert.rejects(api.publish(f.input, f.deps), /DISK_FULL/);
    assert.equal(f.state.puts, 0);
  } finally {
    f.cleanup();
  }
});
test('CLI and nonmock mode cannot perform AWS operations', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      api.publish(f.input, { ...f.deps, mode: 'live' }),
      /LIVE_PUBLISHING_DISABLED/,
    );
    const result = spawnSync(
      process.execPath,
      [resolve(__dirname, '../../../scripts/publish-api-artifact.cjs')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LIVE_PUBLISHING_DISABLED/);
    assert.equal(f.state.puts, 0);
  } finally {
    f.cleanup();
  }
});
test('fixed builder evidence is required by local loader', () => {
  const f = fixture();
  try {
    const dir = join(f.directory, 'backend/dist/api-release');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'api.zip'), f.deps.bytes);
    writeFileSync(
      join(dir, 'evidence.json'),
      JSON.stringify(f.input.buildEvidence),
    );
    assert.deepEqual(api.loadCandidate(f.input, f.directory), f.deps.bytes);
    writeFileSync(join(dir, 'api.zip'), Buffer.from('changed'));
    assert.throws(
      () => api.loadCandidate(f.input, f.directory),
      /SOURCE_HASH_MISMATCH/,
    );
  } finally {
    f.cleanup();
  }
});

test('unique operation IDs and immutable captured bytes', async () => {
  const f = fixture();
  try {
    assert.notEqual(api.newOperationId(), api.newOperationId());
    f.deps.adapters.protection.inspect = async () => {
      f.deps.bytes.fill(0);
      return f.config;
    };
    assert.equal((await api.publish(f.input, f.deps)).state, 'VERIFIED');
  } finally {
    f.cleanup();
  }
});
test('stale approval evidence blocks PUT', async () => {
  const f = fixture();
  try {
    f.config.verifiedAt = '2000-01-01T00:00:00Z';
    await assert.rejects(
      api.publish(f.input, f.deps),
      /FRESH_APPROVAL_EVIDENCE_REQUIRED/,
    );
    assert.equal(f.state.puts, 0);
  } finally {
    f.cleanup();
  }
});

test('missing permissions boundary and changed lifecycle fail closed', async () => {
  const f = fixture();
  try {
    f.config.permissionsBoundary = {};
    await assert.rejects(
      api.publish(f.input, f.deps),
      /PUBLISHER_BOUNDARY_REQUIRED/,
    );
    assert.equal(f.state.puts, 0);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    g.config.noncurrentDays = 1;
    await assert.rejects(api.publish(g.input, g.deps), /RETENTION_INVALID/);
    assert.equal(g.state.puts, 0);
  } finally {
    g.cleanup();
  }
});
test('missing returned version cannot verify but original identity can reconcile', async () => {
  const f = fixture();
  try {
    const put = f.deps.adapters.s3.put;
    f.deps.adapters.s3.put = async (request) => {
      await put(request);
      return { VersionId: '' };
    };
    await assert.rejects(api.publish(f.input, f.deps), /VERSION_REQUIRED/);
    assert.equal((await api.publish(f.input, f.deps)).state, 'VERIFIED');
    assert.equal(f.state.puts, 1);
  } finally {
    f.cleanup();
  }
});
test('actual independent builder output satisfies the publisher loader', () => {
  const root = resolve(__dirname, '../../../..');
  const evidence = JSON.parse(
    readFileSync(join(root, 'backend/dist/api-release/evidence.json'), 'utf8'),
  );
  const input = {
    operationId: api.newOperationId(),
    artifactId: 'api',
    approvalReference: 'synthetic-local-test',
    sourceCommit: 'a'.repeat(40),
    sha256: evidence.sha256,
    bytes: evidence.bytes,
    buildEvidence: evidence,
  };
  assert.equal(api.loadCandidate(input, root).length, evidence.bytes);
});

const opaqueVersions = [
  ['300-byte opaque ID', 'a'.repeat(300)],
  ['non-label characters preserved', ' _+/=.%:Version ID '],
  ['multibyte and decomposed text preserved', '版本-🍪-e\u0301'],
  ['1024-byte ASCII boundary', 'x'.repeat(1024)],
  ['1024-byte multibyte boundary', '🍪'.repeat(256)],
];
for (const [name, version] of opaqueVersions)
  test(`opaque VersionId: ${name}, including reopened journal`, async () => {
    const f = fixture(version);
    try {
      const first = await api.publish(f.input, f.deps);
      assert.equal(first.state, 'VERIFIED');
      assert.equal(first.versionId, version);
      assert.deepEqual(
        Buffer.from(first.versionId, 'utf8'),
        Buffer.from(version, 'utf8'),
      );
      // Journal has no persistent open handles. Discard and recreate its adapter.
      f.deps.journal = api.createJournal(f.directory);
      assert.equal(f.deps.journal.load(f.input.operationId).versionId, version);
      const recovered = await api.publish(f.input, f.deps);
      assert.equal(recovered.versionId, version);
      assert.deepEqual(recovered.identity, first.identity);
      assert.equal(recovered.key, first.key);
      assert.equal(recovered.deploymentAuthorized, false);
      assert.equal(f.state.puts, 1);
    } finally {
      f.cleanup();
    }
  });

for (const [name, version] of [
  ['over byte limit ASCII', 'x'.repeat(1025)],
  ['over byte limit multibyte', '🍪'.repeat(257)],
  ['empty', ''],
  ['unversioned literal', 'null'],
  ['unpaired high surrogate', '\ud800'],
  ['unpaired low surrogate', '\udc00'],
])
  test(`invalid VersionId: ${name} cannot be published or reconciled`, async () => {
    const f = fixture(version);
    try {
      await assert.rejects(api.publish(f.input, f.deps), /VERSION_REQUIRED/);
      const original = f.deps.journal.load(f.input.operationId);
      assert.equal(original.state, 'UNCERTAIN');
      f.deps.journal = api.createJournal(f.directory);
      await assert.rejects(
        api.publish(f.input, f.deps),
        /UNSAFE_VERSION_HISTORY/,
      );
      assert.equal(f.deps.journal.load(f.input.operationId).key, original.key);
      assert.equal(f.state.puts, 1);
    } finally {
      f.cleanup();
    }
  });

for (const missing of [undefined, null])
  test(`missing/nonstring VersionId ${String(missing)} fails safely`, async () => {
    const f = fixture();
    try {
      const put = f.deps.adapters.s3.put;
      f.deps.adapters.s3.put = async (request) => {
        await put(request);
        return { VersionId: missing as unknown as string };
      };
      await assert.rejects(api.publish(f.input, f.deps), /VERSION_REQUIRED/);
      assert.equal(f.deps.journal.load(f.input.operationId).state, 'UNCERTAIN');
      assert.equal(f.state.puts, 1);
    } finally {
      f.cleanup();
    }
  });

test('lost acknowledgement with long opaque ID recovers after journal reopening without PUT', async () => {
  const version = '_+' + '界'.repeat(100);
  const f = fixture(version);
  try {
    f.state.mode = 'lost';
    await assert.rejects(
      api.publish(f.input, f.deps),
      /ACKNOWLEDGEMENT_UNCERTAIN/,
    );
    const original = f.deps.journal.load(f.input.operationId);
    assert.equal(original.state, 'UNCERTAIN');
    f.deps.journal = api.createJournal(f.directory);
    const result = await api.publish(f.input, f.deps);
    assert.equal(result.versionId, version);
    assert.equal(result.state, 'VERIFIED');
    assert.deepEqual(result.identity, original.identity);
    assert.equal(result.key, original.key);
    assert.equal(result.deploymentAuthorized, false);
    assert.equal(f.state.puts, 1);
  } finally {
    f.cleanup();
  }
});

test('different valid opaque history ID preserves fail-closed exact comparison', async () => {
  const f = fixture('a'.repeat(300));
  try {
    await api.publish(f.input, f.deps);
    f.deps.journal = api.createJournal(f.directory);
    const history = f.deps.adapters.s3.history;
    f.deps.adapters.s3.history = async () => {
      const h = await history();
      return {
        ...h,
        versions: h.versions.map((v) => ({ ...v, VersionId: 'b'.repeat(300) })),
      };
    };
    await assert.rejects(api.publish(f.input, f.deps), /VERSION_MISMATCH/);
    assert.equal(f.state.puts, 1);
  } finally {
    f.cleanup();
  }
});

for (const version of ['', 'null', '\ud800', 'x'.repeat(1025)])
  test(`invalid journal VersionId is rejected before adapter access: ${JSON.stringify(version).slice(0, 40)}`, async () => {
    const f = fixture();
    try {
      await api.publish(f.input, f.deps);
      const receipt = f.deps.journal.load(f.input.operationId);
      receipt.versionId = version;
      f.deps.journal.save(receipt);
      f.deps.journal = api.createJournal(f.directory);
      f.deps.adapters.protection.inspect = async () => {
        throw Error('MUST_NOT_INSPECT');
      };
      await assert.rejects(
        api.publish(f.input, f.deps),
        /INVALID_RECEIPT_VERSION/,
      );
      assert.equal(f.state.puts, 1);
    } finally {
      f.cleanup();
    }
  });

test('uncertain 300-byte version recovers in a fresh Node process without another PUT', async () => {
  const version = 'v'.repeat(300);
  const f = fixture(version);
  try {
    f.state.mode = 'lost';
    await assert.rejects(
      api.publish(f.input, f.deps),
      /ACKNOWLEDGEMENT_UNCERTAIN/,
    );
    const original = f.deps.journal.load(f.input.operationId);
    const script = `
      const fs = require('node:fs');
      const p = JSON.parse(fs.readFileSync(0, 'utf8'));
      const api = require(p.modulePath);
      let puts = 0;
      const object = { Key:p.config.key, VersionId:p.version, IsLatest:true };
      api.publish(p.input, {
        mode:'mock-only', bytes:Buffer.from(p.bytes,'base64'),
        journal:api.createJournal(p.directory),
        adapters:{ kind:'mock',
          protection:{inspect:async()=>p.config},
          kms:{inspect:async()=>({enabled:true,manager:'AWS',viaService:'s3.us-east-2.amazonaws.com',callerAccount:api.ACCOUNT,contextArn:'arn:aws:s3:::'+api.BUCKET+'/'+p.config.key})},
          s3:{
            put:async()=>{ puts++; throw Error('UNEXPECTED_PUT'); },
            history:async()=>({complete:true,versions:[object],deleteMarkers:[]}),
            get:async r=>{if(r.VersionId!==p.version)throw Error('VERSION_CHANGED');return {...object,Body:Buffer.from(p.bytes,'base64'),Metadata:{operation:p.input.operationId,source:p.input.sourceCommit},ServerSideEncryption:'aws:kms',SSEKMSKeyId:api.KMS,BucketKeyEnabled:false};},
            head:async()=>object
          }
        }
      }).then(receipt=>process.stdout.write(JSON.stringify({receipt,puts}))).catch(()=>{process.exitCode=1});
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      input: JSON.stringify({
        modulePath: resolve(
          __dirname,
          '../../../scripts/publish-api-artifact.cjs',
        ),
        input: f.input,
        config: f.config,
        bytes: f.deps.bytes.toString('base64'),
        directory: f.directory,
        version,
      }),
      env: { PATH: process.env.PATH },
      timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.receipt.state, 'VERIFIED');
    assert.equal(result.receipt.versionId, version);
    assert.equal(result.receipt.key, original.key);
    assert.deepEqual(result.receipt.identity, original.identity);
    assert.equal(result.receipt.deploymentAuthorized, false);
    assert.equal(result.puts, 0);
    assert.equal(f.state.puts, 1);
  } finally {
    f.cleanup();
  }
});

for (const artifactType of ['api', 'isolated-catalog']) {
  test(`${artifactType}: fixed path, verified bytes and durable type-bound receipt`, async () => {
    const f = fixture();
    try {
      const input = { ...f.input, artifactType };
      const dir = join(
        f.directory,
        'backend/dist',
        artifactType === 'api' ? 'api-release' : 'isolated-catalog-release',
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'api.zip'), f.deps.bytes);
      writeFileSync(
        join(dir, 'evidence.json'),
        JSON.stringify(input.buildEvidence),
      );
      assert.deepEqual(api.loadCandidate(input, f.directory), f.deps.bytes);
      const receipt = await api.publish(input, f.deps);
      assert.equal(receipt.identity.artifactType, artifactType);
      assert.equal(
        (await api.publish(input, f.deps)).versionId,
        receipt.versionId,
      );
      assert.equal(f.state.puts, 1);
      await assert.rejects(
        api.publish(
          {
            ...input,
            artifactType: artifactType === 'api' ? 'isolated-catalog' : 'api',
          },
          f.deps,
        ),
        /OPERATION_IDENTITY_CHANGED/,
      );
      assert.equal(f.state.puts, 1);
    } finally {
      f.cleanup();
    }
  });
}
test('unknown artifact types and caller-selected paths fail before loading or publication', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { artifactType: 'worker' },
      { artifactType: '../api-release' },
      { artifactType: '__proto__' },
      { zipPath: '/tmp/other.zip' },
      { artifactPath: 'backend/dist/api-release/api.zip' },
      { path: 'api.zip' },
    ]) {
      const input = { ...f.input, ...patch };
      assert.throws(
        () => api.loadCandidate(input, f.directory),
        /UNSUPPORTED_ARTIFACT_TYPE|UNEXPECTED_ARTIFACT_PATH/,
      );
      await assert.rejects(
        api.publish(input, f.deps),
        /UNSUPPORTED_ARTIFACT_TYPE|UNEXPECTED_ARTIFACT_PATH/,
      );
    }
    assert.equal(f.state.puts, 0);
  } finally {
    f.cleanup();
  }
});
test('actual isolated builder output is accepted only through its fixed path', () => {
  const root = resolve(__dirname, '../../../..');
  const built = spawnSync(
    process.execPath,
    ['scripts/build-api.mjs', '--isolated-catalog'],
    { cwd: join(root, 'backend'), encoding: 'utf8' },
  );
  assert.equal(built.status, 0, built.stderr);
  const evidence = JSON.parse(
    readFileSync(
      join(root, 'backend/dist/isolated-catalog-release/evidence.json'),
      'utf8',
    ),
  );
  const input = {
    artifactType: 'isolated-catalog',
    operationId: api.newOperationId(),
    artifactId: 'isolated-catalog',
    approvalReference: 'synthetic-test',
    sourceCommit: 'a'.repeat(40),
    sha256: evidence.sha256,
    bytes: evidence.bytes,
    buildEvidence: evidence,
  };
  assert.equal(api.loadCandidate(input, root).length, evidence.bytes);
  assert.throws(
    () => api.loadCandidate({ ...input, artifactType: 'api' }, root),
    /BUILD_EVIDENCE_CHANGED/,
  );
});
test('isolated parameters preserve opaque VersionIds and reject invalid UTF-8 byte lengths', () => {
  const key =
    'api-releases/12345678-1234-4234-8234-123456789abc/' +
    'a'.repeat(64) +
    '.zip';
  for (const [, value] of opaqueVersions)
    assert.deepEqual(api.isolatedArtifactParameters(key, value), {
      ArtifactKey: key,
      ArtifactVersion: value,
    });
  for (const value of [
    undefined,
    null,
    '',
    'null',
    'x'.repeat(1025),
    '🍪'.repeat(257),
    '\ud800',
  ])
    assert.throws(
      () => api.isolatedArtifactParameters(key, value),
      /INVALID_ARTIFACT_VERSION/,
    );
  assert.throws(() =>
    api.isolatedArtifactParameters('accepted-worker.zip', 'version'),
  );
});

test('isolated artifact uncertain write recovers the original typed operation without another PUT', async () => {
  const f = fixture();
  try {
    const input = { ...f.input, artifactType: 'isolated-catalog' };
    f.state.mode = 'lost';
    await assert.rejects(
      api.publish(input, f.deps),
      /ACKNOWLEDGEMENT_UNCERTAIN/,
    );
    const before = f.deps.journal.load(input.operationId);
    const recovered = await api.publish(input, f.deps);
    assert.equal(recovered.state, 'VERIFIED');
    assert.equal(recovered.key, before.key);
    assert.deepEqual(recovered.identity, before.identity);
    assert.equal(recovered.identity.artifactType, 'isolated-catalog');
    assert.equal(f.state.puts, 1);
  } finally {
    f.cleanup();
  }
});

function liveFixture(version = 'original-version') {
  const f = fixture(version);
  const root = resolve(__dirname, '../../../..');
  const evidence = JSON.parse(
    readFileSync(
      join(root, 'backend/dist/isolated-catalog-release/evidence.json'),
      'utf8',
    ),
  );
  Object.assign(f.input, api.ISOLATED_APPROVAL, { buildEvidence: evidence });
  const deps: any = f.deps;
  deps.bytes = api.loadCandidate(f.input, root);
  deps.mode = 'approved-1n-d';
  deps.publisherArn = api.ROLE;
  deps.adapters.kind = 'verified-publisher-role';
  deps.adapters.s3.kind = 'aws-dormant';
  const key = `api-releases/${f.input.operationId}/${f.input.sha256}.zip`;
  Object.assign(f.config, {
    key,
    identityPolicy: api.materializeIdentityPolicy(key),
    approvalReference: f.input.approvalReference,
    sha256: f.input.sha256,
    sourceCommit: f.input.sourceCommit,
  });
  return { ...f, deps };
}
for (const mode of [
  '',
  'lost',
  '409',
  '412',
  'corrupt',
  'malformed',
  'crash',
]) {
  test(`approved live operation ${mode || 'success'} preserves identity and never repeats PUT`, async () => {
    const f = liveFixture(mode === 'malformed' ? 'null' : 'original-version');
    try {
      if (['lost', '409', '412'].includes(mode)) f.state.mode = mode;
      if (mode === 'corrupt') f.state.corrupt = true;
      if (mode === 'crash') {
        const save = f.deps.journal.save;
        let once = true;
        f.deps.journal.save = (record: any) => {
          if (record.state === 'WRITTEN' && once) {
            once = false;
            throw Error('simulated process failure');
          }
          save(record);
        };
      }
      if (mode)
        await assert.rejects(
          api.publishApprovedIsolatedCatalog(f.input, f.deps),
        );
      else {
        const receipt = await api.publishApprovedIsolatedCatalog(
          f.input,
          f.deps,
        );
        assert.equal(receipt.simulated, false);
        assert.equal(receipt.state, 'VERIFIED');
        assert.equal(receipt.versionId, 'original-version');
      }
      // Reopen journal as after restart. No alternate operation or second PUT.
      f.deps.journal = api.createJournal(f.directory);
      if (['', 'lost', 'crash'].includes(mode)) {
        const receipt = await api.publishApprovedIsolatedCatalog(
          f.input,
          f.deps,
        );
        assert.equal(receipt.state, 'VERIFIED');
        assert.equal(receipt.simulated, false);
      } else
        await assert.rejects(
          api.publishApprovedIsolatedCatalog(f.input, f.deps),
        );
      assert.equal(f.state.puts, 1);
      await assert.rejects(
        api.publish(f.input, {
          ...f.deps,
          mode: 'mock-only',
          adapters: { ...f.deps.adapters, kind: 'mock' },
        }),
        /INVALID_RECEIPT/,
      );
      assert.equal(f.state.puts, 1);
    } finally {
      f.cleanup();
    }
  });
}
test('live publication rejects alternate identity, mock receipts, credentials and transport substitutions', async () => {
  const f = liveFixture();
  try {
    for (const change of [
      { operationId: api.newOperationId() },
      { sha256: 'a'.repeat(64) },
      { artifactType: 'api' },
      { sourceCommit: 'a'.repeat(40) },
      { path: '/tmp/any.zip' },
    ])
      await assert.rejects(
        api.publishApprovedIsolatedCatalog({ ...f.input, ...change }, f.deps),
        /APPROVED_ARTIFACT_REQUIRED/,
      );
    await assert.rejects(
      api.publishApprovedIsolatedCatalog(f.input, {
        ...f.deps,
        publisherArn: 'wrong',
      }),
      /EXPLICIT_PUBLISHER_ROLE_REQUIRED/,
    );
    await assert.rejects(
      api.publishApprovedIsolatedCatalog(f.input, {
        ...f.deps,
        adapters: { ...f.deps.adapters, kind: 'mock' },
      }),
      /EXPLICIT_PUBLISHER_ROLE_REQUIRED/,
    );
    await assert.rejects(
      api.publish(f.input, f.deps),
      /LIVE_PUBLISHING_DISABLED/,
    );
    assert.equal(f.state.puts, 0);
    await api.publish(f.input, {
      ...f.deps,
      mode: 'mock-only',
      adapters: { ...f.deps.adapters, kind: 'mock' },
    });
    await assert.rejects(
      api.publishApprovedIsolatedCatalog(f.input, f.deps),
      /INVALID_RECEIPT/,
    );
    assert.equal(f.state.puts, 1);
  } finally {
    f.cleanup();
  }
});
test('live prepared operation rejects an existing key instead of claiming it', async () => {
  const f = liveFixture();
  try {
    await api.publishApprovedIsolatedCatalog(f.input, f.deps);
    const record = f.deps.journal.load(f.input.operationId);
    record.state = 'PREPARED';
    record.versionId = null;
    f.deps.journal.save(record);
    await assert.rejects(
      api.publishApprovedIsolatedCatalog(f.input, f.deps),
      /EXISTING_KEY_COLLISION/,
    );
    assert.equal(f.state.puts, 1);
  } finally {
    f.cleanup();
  }
});
test('live entrypoint is inert on import and rejects invocation without explicit approval', () => {
  const file = resolve(
    __dirname,
    '../../../scripts/publish-isolated-catalog-1n-d.cjs',
  );
  const imported = spawnSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(file)})`],
    { encoding: 'utf8', env: { PATH: process.env.PATH } },
  );
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  const invoked = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(invoked.status, 1);
  assert.match(invoked.stderr, /PUBLICATION_STOPPED/);
});

test('real publication journal enforces owner-only directory and entry permissions', () => {
  const { chmodSync, realpathSync } = require('node:fs');
  const entry = require(
    resolve(__dirname, '../../../scripts/publish-isolated-catalog-1n-d.cjs'),
  );
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'private-publication-')));
  try {
    chmodSync(dir, 0o755);
    assert.throws(
      () => entry.ownerOnlyJournal(dir),
      /OWNER_ONLY_JOURNAL_REQUIRED/,
    );
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'unexpected.json'), '{}', { mode: 0o644 });
    assert.throws(() => entry.ownerOnlyJournal(dir), /UNSAFE_JOURNAL_ENTRY/);
    rmSync(join(dir, 'unexpected.json'));
    const journal = entry.ownerOnlyJournal(dir);
    const release = journal.acquire(api.ISOLATED_APPROVAL.operationId);
    assert.throws(
      () =>
        entry.ownerOnlyJournal(dir).acquire(api.ISOLATED_APPROVAL.operationId),
      /EEXIST/,
    );
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('temporary role verification uses only explicit in-memory credentials and rejects wrong identities', () => {
  const entry = require(
    resolve(__dirname, '../../../scripts/publish-isolated-catalog-1n-d.cjs'),
  );
  const credentials = {
    accessKeyId: 'synthetic-key',
    secretAccessKey: 'synthetic-secret',
    sessionToken: 'synthetic-session',
  };
  const execute = (file: string, args: string[], options: any) => {
    assert.equal(file, 'aws');
    assert.deepEqual(args, [
      'sts',
      'get-caller-identity',
      '--region',
      'us-east-2',
      '--output',
      'json',
    ]);
    assert.equal(options.env.AWS_ACCESS_KEY_ID, credentials.accessKeyId);
    assert.equal(
      options.env.AWS_SECRET_ACCESS_KEY,
      credentials.secretAccessKey,
    );
    assert.equal(options.env.AWS_SESSION_TOKEN, credentials.sessionToken);
    assert.equal(options.env.AWS_PROFILE, undefined);
    assert.equal(options.env.AWS_CONFIG_FILE, '/dev/null');
    assert.equal(options.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
    assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    return JSON.stringify({
      Account: api.ACCOUNT,
      Arn: 'arn:aws:sts::302154194958:assumed-role/batch-and-batter-dev-api-artifact-publisher/isolated-catalog-1n-d',
    });
  };
  entry.verifyTemporaryIdentity(credentials, execute);
  assert.throws(
    () => entry.verifyTemporaryIdentity({}, execute),
    /TEMPORARY_SESSION_REQUIRED/,
  );
  assert.throws(
    () =>
      entry.verifyTemporaryIdentity(credentials, () =>
        JSON.stringify({ Account: 'wrong' }),
      ),
    /ASSUMED_ROLE_MISMATCH/,
  );
  assert.throws(
    () =>
      entry.verifyTemporaryIdentity(credentials, () => {
        throw Error('must not disclose secret');
      }),
    /^Error: TEMPORARY_IDENTITY_UNVERIFIED$/,
  );
});
