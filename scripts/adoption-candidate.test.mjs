import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  candidateRuntime,
  requirePublishedPrerequisites,
} from './adoption-candidate.mjs';
import {
  assertImageMetadata,
  resolvePlatformManifest,
  sha256,
} from './adoption-images.mjs';

const images = {
  site: `ghcr.io/willgriffin/iolaus/site@sha256:${'a'.repeat(64)}`,
  extractor: `ghcr.io/willgriffin/iolaus/resume-import-extraction@sha256:${'b'.repeat(64)}`,
};

test('inactive candidate preserves actual entrypoints, restricted identities, singleton and drain', () => {
  const runtime = candidateRuntime(images);
  assert.deepEqual(Object.keys(runtime.workloads), [
    'web',
    'task',
    'schedule',
    'extractor',
    'monitor',
  ]);
  assert.equal(runtime.workloads.task.terminationGracePeriodSeconds, 270);
  assert.equal(runtime.workloads.schedule.replicas, 1);
  assert.equal(runtime.workloads.monitor.schedule, '*/5 * * * *');
  assert.equal(runtime.migration.observerAccess, true);
  assert.equal(
    runtime.migration.serviceAccountName,
    'iolaus-migration-observer',
  );
  for (const entry of [
    ...Object.values(runtime.workloads),
    runtime.migration,
  ]) {
    assert.equal(entry.podSecurityContext.runAsUser, 10001);
    assert.equal(entry.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(entry.securityContext.capabilities.drop, ['ALL']);
    assert.ok(entry.scratch.some(({ mountPath }) => mountPath === '/tmp'));
    for (const env of entry.env) {
      assert.deepEqual(Object.keys(env), ['name', 'valueFrom']);
      assert.match(env.valueFrom.secretKeyRef.name, /-v1$/);
      assert.ok(env.valueFrom.secretKeyRef.key);
    }
    if (entry !== runtime.migration)
      assert.equal(entry.observerAccess, undefined);
  }
  assert.notEqual(
    runtime.migration.env[0].valueFrom.secretKeyRef.name,
    runtime.workloads.web.env[0].valueFrom.secretKeyRef.name,
  );
  assert.notEqual(
    runtime.workloads.monitor.env[0].valueFrom.secretKeyRef.name,
    runtime.workloads.web.env[0].valueFrom.secretKeyRef.name,
  );
});

test('mutable, local, wrong repository and absent artifacts fail closed', () => {
  for (const site of [
    'site:latest',
    'sha256:abcd',
    images.extractor,
    undefined,
  ]) {
    assert.throws(() => candidateRuntime({ ...images, site }));
  }
  const prereqs = JSON.parse(
    readFileSync(
      new URL(
        '../deploy/self-hosted/adoption/prerequisites.json',
        import.meta.url,
      ),
    ),
  );
  assert.throws(
    () => requirePublishedPrerequisites(prereqs),
    /Public chart OCI digest required/,
  );
});

test('platform resolution verifies registry bytes and rejects ambiguous or wrong architectures', () => {
  const manifest = JSON.stringify({
    manifests: [
      {
        digest: `sha256:${'c'.repeat(64)}`,
        platform: { os: 'linux', architecture: 'amd64' },
      },
    ],
  });
  const ref = `ghcr.io/test/image@sha256:${sha256(manifest)}`;
  assert.equal(
    resolvePlatformManifest(ref, manifest),
    `ghcr.io/test/image@sha256:${'c'.repeat(64)}`,
  );
  assert.throws(
    () => resolvePlatformManifest(images.site, manifest),
    /Registry bytes/,
  );
  assert.throws(
    () => resolvePlatformManifest(ref, manifest, 'arm64'),
    /Exactly one/,
  );
  const repeated = JSON.stringify({
    manifests: [
      ...JSON.parse(manifest).manifests,
      ...JSON.parse(manifest).manifests,
    ],
  });
  assert.throws(
    () =>
      resolvePlatformManifest(
        `ghcr.io/test/image@sha256:${sha256(repeated)}`,
        repeated,
      ),
    /Exactly one/,
  );
});

test('actual image metadata must bind source, lock, platform, user and public digest', () => {
  const metadata = {
    RepoDigests: [images.site],
    Os: 'linux',
    Architecture: 'amd64',
    Config: {
      User: '10001:10001',
      Labels: {
        'org.opencontainers.image.revision': 'revision',
        'dev.happyvertical.iolaus.pnpm-lock.sha256': 'lock',
      },
    },
  };
  assertImageMetadata(metadata, images.site, 'revision', 'lock');
  for (const change of [
    (m) => {
      m.Architecture = 'arm64';
    },
    (m) => {
      m.Config.User = '0';
    },
    (m) => {
      m.RepoDigests = [];
    },
    (m) => {
      m.Config.Labels['org.opencontainers.image.revision'] = 'wrong';
    },
  ]) {
    const altered = structuredClone(metadata);
    change(altered);
    assert.throws(() =>
      assertImageMetadata(altered, images.site, 'revision', 'lock'),
    );
  }
});

test('candidate CLI produces parseable JSON with a real trailing newline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'iolaus-candidate-contract-'));
  try {
    const input = join(directory, 'images.json');
    const output = join(directory, 'target.json');
    writeFileSync(input, JSON.stringify(images));
    execFileSync(process.execPath, [
      fileURLToPath(new URL('./adoption-candidate.mjs', import.meta.url)),
      input,
      output,
    ]);
    const bytes = readFileSync(output, 'utf8');
    assert.equal(bytes.at(-1), '\n');
    assert.deepEqual(JSON.parse(bytes), candidateRuntime(images));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
