import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildScenarioEnvironment,
  candidateImageInvocation,
  evidenceDigest,
  invalidateEvidence,
  inspectCandidateImageFilesystem,
  isolatedInvocation,
  sourceFingerprint,
  validateCandidateImageMetadata,
  validateImageReference,
  validateInstalledSmrtDependencies,
  validateLocalCandidateImageMetadata,
  validateLocalImageId,
} from './deployed-parity.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');

function writeTarString(header, start, length, value) {
  Buffer.from(value, 'utf8').copy(header, start, 0, length);
}

function writeTarOctal(header, start, length, value) {
  writeTarString(
    header,
    start,
    length,
    `${value.toString(8).padStart(length - 1, '0')}\0`,
  );
}

function tarEntry(path, type, content = Buffer.alloc(0), linkname = '') {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeTarString(header, 157, 100, linkname);
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return !result.error && result.status === 0;
}

test('fingerprints exact source bytes with path framing', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'iolaus-parity-source-test-'));
  try {
    writeFileSync(resolve(root, 'a'), 'bc');
    writeFileSync(resolve(root, 'ab'), 'c');
    assert.equal(
      sourceFingerprint(root, ['ab', 'a']),
      sourceFingerprint(root, ['a', 'ab']),
    );
    assert.notEqual(
      sourceFingerprint(root, ['a']),
      sourceFingerprint(root, ['ab']),
    );
    assert.throws(() => sourceFingerprint(root, ['../outside']), /within/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  'rejects a symlinked tracked path through the Docker export inspection boundary',
  { skip: !dockerAvailable() },
  async () => {
    const image = `iolaus-parity-malicious-link-test:${process.pid}`;
    const archive = Buffer.concat([
      tarEntry('app', '5'),
      tarEntry('outside', '0', Buffer.from('reviewed bytes')),
      tarEntry('app/package.json', '2', Buffer.alloc(0), '../outside'),
      Buffer.alloc(1024),
    ]);
    const imported = spawnSync('docker', ['import', '-', image], {
      encoding: 'utf8',
      input: archive,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    assert.equal(imported.status, 0, imported.stdout);
    const imageId = imported.stdout.trim();
    try {
      await assert.rejects(
        inspectCandidateImageFilesystem(
          imageId,
          ['package.json'],
          sourceFingerprint(repositoryRoot, ['package.json']),
        ),
        /unsupported source entry type/u,
      );
    } finally {
      spawnSync('docker', ['image', 'rm', '--force', imageId], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    }
  },
);

test(
  'hashes raw regular-file bytes through the Docker export inspection boundary',
  { skip: !dockerAvailable() },
  async () => {
    const image = `iolaus-parity-regular-file-test:${process.pid}`;
    const content = readFileSync(resolve(repositoryRoot, 'package.json'));
    const archive = Buffer.concat([
      tarEntry('app', '5'),
      tarEntry('app/package.json', '0', content),
      Buffer.alloc(1024),
    ]);
    const imported = spawnSync('docker', ['import', '-', image], {
      encoding: 'utf8',
      input: archive,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    assert.equal(imported.status, 0, imported.stdout);
    const imageId = imported.stdout.trim();
    try {
      const expectedSha256 = sourceFingerprint(repositoryRoot, ['package.json']);
      assert.deepEqual(
        await inspectCandidateImageFilesystem(
          imageId,
          ['package.json'],
          expectedSha256,
        ),
        { sourceTreeSha256: expectedSha256 },
      );
    } finally {
      spawnSync('docker', ['image', 'rm', '--force', imageId], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    }
  },
);

test('uses a read-only filesystem for candidate-image scenarios', () => {
  const imageRef = `ghcr.io/willgriffin/iolaus/site@sha256:${'a'.repeat(64)}`;
  const result = candidateImageInvocation(imageRef, ['node', '--test', 'x']);
  assert.ok(result.args.includes('--read-only'));
  assert.equal(result.args.includes('--env'), true);
});

test('runs candidate scenarios from the immutable image without networking', () => {
  const imageRef = `ghcr.io/willgriffin/iolaus/site@sha256:${'a'.repeat(64)}`;
  const result = candidateImageInvocation(imageRef, ['node', '--test', 'x']);
  assert.equal(result.backend, 'docker-network-none');
  assert.equal(result.binary, 'docker');
  assert.deepEqual(result.args.slice(0, 6), [
    'run',
    '--rm',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
  ]);
  assert.ok(result.args.includes('no-new-privileges'));
  assert.ok(result.args.includes('--read-only'));
  assert.ok(result.args.includes('SMRT_RUNTIME_PROFILE=local'));
  assert.ok(result.args.includes(imageRef));
  assert.deepEqual(result.args.slice(-3), ['node', '--test', 'x']);
});

test('runs CI candidate scenarios from an immutable local image ID', () => {
  const imageId = `sha256:${'d'.repeat(64)}`;
  const result = candidateImageInvocation(imageId, ['node', '--test', 'x']);
  assert.ok(result.args.includes(imageId));
  assert.equal(validateLocalImageId(imageId), imageId);
  assert.throws(() => validateLocalImageId('iolaus:latest'), /exact sha256/u);
});

test('accepts only the exact released Iolaus image reference', () => {
  const digest = 'a'.repeat(64);
  assert.equal(
    validateImageReference(
      `ghcr.io/willgriffin/iolaus/site@sha256:${digest}`,
    ),
    `ghcr.io/willgriffin/iolaus/site@sha256:${digest}`,
  );
  assert.equal(validateImageReference(undefined), null);
  for (const invalid of [
    'ghcr.io/willgriffin/iolaus/site:latest',
    `ghcr.io/other/iolaus/site@sha256:${digest}`,
    'ghcr.io/willgriffin/iolaus/site@sha256:REPLACE_WITH_RELEASED_IMAGE_DIGEST',
  ]) {
    assert.throws(() => validateImageReference(invalid), /exact released/u);
  }
});

test('binds a candidate image digest to source and dependency provenance', () => {
  const imageRef = `ghcr.io/willgriffin/iolaus/site@sha256:${'a'.repeat(64)}`;
  const revision = 'b'.repeat(40);
  const lockfileSha256 = 'c'.repeat(64);
  const metadata = {
    imageRef,
    labels: {
      'dev.happyvertical.iolaus.pnpm-lock.sha256': lockfileSha256,
      'org.opencontainers.image.revision': revision,
    },
    repoDigests: [imageRef],
  };

  assert.deepEqual(
    validateCandidateImageMetadata(metadata, revision, lockfileSha256),
    { dependencyLockSha256: lockfileSha256, sourceRevision: revision },
  );
  assert.throws(
    () =>
      validateCandidateImageMetadata(
        { ...metadata, repoDigests: [] },
        revision,
        lockfileSha256,
      ),
    /not bound/u,
  );
  assert.throws(
    () =>
      validateCandidateImageMetadata(
        metadata,
        'd'.repeat(40),
        lockfileSha256,
      ),
    /source revision/u,
  );
  assert.throws(
    () => validateCandidateImageMetadata(metadata, revision, 'd'.repeat(64)),
    /dependency lock/u,
  );
});

test('binds a local candidate image ID to source and dependency provenance', () => {
  const imageId = `sha256:${'a'.repeat(64)}`;
  const revision = 'b'.repeat(40);
  const lockfileSha256 = 'c'.repeat(64);
  const metadata = {
    actualImageId: imageId,
    imageId,
    labels: {
      'dev.happyvertical.iolaus.pnpm-lock.sha256': lockfileSha256,
      'org.opencontainers.image.revision': revision,
    },
  };
  assert.deepEqual(
    validateLocalCandidateImageMetadata(metadata, revision, lockfileSha256),
    { dependencyLockSha256: lockfileSha256, sourceRevision: revision },
  );
  assert.throws(
    () =>
      validateLocalCandidateImageMetadata(
        { ...metadata, actualImageId: `sha256:${'d'.repeat(64)}` },
        revision,
        lockfileSha256,
      ),
    /not bound/u,
  );
});

test('compares independently inspected installed s-m-r-t dependencies', () => {
  const expected = {
    '@happyvertical/smrt-core': '0.45.0',
    '@happyvertical/smrt-web': '0.45.0',
  };
  assert.deepEqual(validateInstalledSmrtDependencies(expected, expected), expected);
  assert.throws(
    () =>
      validateInstalledSmrtDependencies(
        { ...expected, '@happyvertical/smrt-web': '0.44.0' },
        expected,
      ),
    /do not match/u,
  );
});

test('creates a deterministic evidence digest without secret inputs', () => {
  const evidence = {
    schema: 'iolaus-deployed-parity-contract:v1',
    status: 'passed',
    secretValuesIncluded: false,
  };
  assert.match(evidenceDigest(evidence), /^[a-f0-9]{64}$/u);
  assert.equal(evidenceDigest(evidence), evidenceDigest({ ...evidence }));
});

test('sanitizes scenario environment and installs an outbound-network denial', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'iolaus-parity-env-test-'));
  try {
    const environment = buildScenarioEnvironment(root, {
      PATH: '/safe/bin',
      PNPM_HOME: '/runtime/pnpm',
      HOME: '/runtime-home',
      DATABASE_URL: 'postgres://production.invalid/private',
      PROVIDER_API_KEY: 'must-not-pass-through',
      NODE_OPTIONS: '--require=/untrusted/hook.cjs',
    });
    assert.equal(environment.PATH, '/safe/bin');
    assert.equal(environment.PNPM_HOME, '/runtime/pnpm');
    assert.equal(environment.DATABASE_URL, undefined);
    assert.equal(environment.PROVIDER_API_KEY, undefined);
    assert.match(environment.NODE_OPTIONS, /deny-outbound-network\.cjs$/u);
    assert.equal(environment.SMRT_RUNTIME_PROFILE, 'local');
    assert.equal(environment.SMRT_APP_ID, undefined);
    assert.equal(environment.HOME, resolve(root, 'home'));
    assert.equal(
      environment.COREPACK_HOME,
      '/runtime-home/.cache/node/corepack',
    );
    const denied = spawnSync(
      process.execPath,
      ['-e', "fetch('https://example.invalid')"],
      { encoding: 'utf8', env: environment },
    );
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Outbound networking is disabled/u);
    const localIpc = spawnSync(
      process.execPath,
      [
        '-e',
        "require('node:net').createConnection('/tmp/iolaus-parity-missing.sock').on('error', error => process.exit(error.message.includes('Outbound networking') ? 2 : 0))",
      ],
      { encoding: 'utf8', env: environment },
    );
    assert.equal(localIpc.status, 0);
    if (process.platform === 'darwin') {
      for (const script of [
        "fetch('https://example.invalid')",
        "require('node:dns').lookup('example.invalid', error => process.exit(error ? 0 : 2))",
        "require('node:dgram').createSocket('udp4').send('x', 53, '127.0.0.1', error => process.exit(error ? 0 : 2))",
        "require('node:child_process').spawnSync('/usr/bin/curl', ['https://example.invalid']).status === 0 && process.exit(2)",
      ]) {
        const isolated = isolatedInvocation(process.execPath, ['-e', script]);
        const result = spawnSync(isolated.binary, isolated.args, {
          encoding: 'utf8',
          env: environment,
        });
        assert.notEqual(result.status, 2);
      }
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('selects a fail-closed OS network-isolation backend', () => {
  if (process.platform === 'darwin') {
    assert.deepEqual(isolatedInvocation('node', ['script.mjs']), {
      backend: 'darwin-sandbox-exec-deny-remote-ip',
      binary: '/usr/bin/sandbox-exec',
      args: [
        '-p',
        '(version 1) (allow default) (deny network-outbound (remote ip))',
        'node',
        'script.mjs',
      ],
    });
  }
  assert.throws(
    () => isolatedInvocation('node', [], 'unsupported'),
    /OS-enforced outbound-network isolation/u,
  );
});

test('invalidates previous evidence before a rerun', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'iolaus-parity-evidence-test-'));
  const path = resolve(root, 'evidence.json');
  try {
    writeFileSync(path, '{"status":"passed"}\n', { mode: 0o600 });
    invalidateEvidence(path);
    assert.throws(() => readFileSync(path), /ENOENT/u);
    assert.doesNotThrow(() => invalidateEvidence(path));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
