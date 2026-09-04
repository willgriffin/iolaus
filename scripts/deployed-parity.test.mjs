import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildScenarioEnvironment,
  evidenceDigest,
  invalidateEvidence,
  isolatedInvocation,
  validateCandidateImageMetadata,
  validateImageReference,
} from './deployed-parity.mjs';

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
