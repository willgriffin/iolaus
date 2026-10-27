import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  candidateRuntime,
  actorSecretData,
  authenticationKeys,
  syntheticAuthContract,
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
  const runtime = candidateRuntime(images, syntheticAuthContract);
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
    assert.throws(() =>
      candidateRuntime({ ...images, site }, syntheticAuthContract),
    );
  }
  const prereqs = JSON.parse(
    readFileSync(
      new URL(
        '../deploy/self-hosted/adoption/prerequisites.json',
        import.meta.url,
      ),
    ),
  );
  assert.equal(requirePublishedPrerequisites(prereqs), prereqs);
  for (const [section, key, error] of [
    ['chart', 'ociDigest', /Public chart OCI digest required/],
    ['chart', 'packageSha256', /Public packaged chart digest required/],
    ['runner', 'revision', /Public runner source commit required/],
  ]) {
    const missing = structuredClone(prereqs);
    missing[section][key] = null;
    assert.throws(() => requirePublishedPrerequisites(missing), error);
  }
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
    const contractFile = join(directory, 'contract.json');
    writeFileSync(contractFile, JSON.stringify(syntheticAuthContract));
    writeFileSync(input, JSON.stringify(images));
    execFileSync(process.execPath, [
      fileURLToPath(new URL('./adoption-candidate.mjs', import.meta.url)),
      input,
      contractFile,
      output,
    ]);
    const bytes = readFileSync(output, 'utf8');
    assert.equal(bytes.at(-1), '\n');
    assert.deepEqual(
      JSON.parse(bytes),
      candidateRuntime(images, syntheticAuthContract),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('candidate requires explicit reviewed auth and preserves private OIDC key shape', () => {
  assert.throws(() => candidateRuntime(images), /Explicit reviewed/);
  assert.throws(
    () =>
      authenticationKeys({ authMode: 'magic-link', workspaceMode: 'private' }),
    /shared/,
  );
  assert.throws(() =>
    authenticationKeys({ ...syntheticAuthContract, unknown: true }),
  );
  const contract = {
    authMode: 'oidc',
    workspaceMode: 'private',
    oidcIssuerMode: 'realm',
    optionalOidcKeys: [
      'IOLAUS_OIDC_CLIENT_SECRET',
      'IOLAUS_OIDC_IMPORTED_OWNER_BINDINGS',
    ],
  };
  const runtime = candidateRuntime(images, contract);
  const keys = runtime.workloads.web.env.map(({ name }) => name);
  for (const key of [
    'IOLAUS_PUBLIC_URL',
    'IOLAUS_WORKSPACE_MODE',
    'ADDRESS_HEADER',
    'IOLAUS_OIDC_SERVER_URL',
    'IOLAUS_OIDC_REALM',
    'IOLAUS_OIDC_CLIENT_ID',
    'IOLAUS_OIDC_ADMIN_EMAILS',
    ...contract.optionalOidcKeys,
  ])
    assert.ok(keys.includes(key), key);
  for (const key of ['IOLAUS_MAGIC_LINK_SECRET', 'SMTP_PASSWORD', 'SMTP_USER'])
    assert.ok(!keys.includes(key), key);
  const root = candidateRuntime(images, {
    ...contract,
    oidcIssuerMode: 'root',
    optionalOidcKeys: [],
  });
  assert.ok(
    !root.workloads.web.env.some(({ name }) => name === 'IOLAUS_OIDC_REALM'),
  );
  assert.throws(() =>
    candidateRuntime(images, {
      ...contract,
      optionalOidcKeys: ['SMTP_PASSWORD'],
    }),
  );
});

test('shared auth modes preserve explicit operator allowlists across runtime actors', () => {
  for (const contract of [
    syntheticAuthContract,
    {
      authMode: 'oidc',
      workspaceMode: 'shared',
      oidcIssuerMode: 'root',
      optionalOidcKeys: [],
    },
  ]) {
    const runtime = candidateRuntime(images, contract);
    for (const name of ['web', 'task', 'schedule'])
      assert.ok(runtime.workloads[name].env.some(
        ({ name }) => name === 'IOLAUS_OIDC_ADMIN_EMAILS',
      ));
    const values = Object.fromEntries(runtime.workloads.web.env.concat(
      runtime.workloads.task.env, runtime.workloads.schedule.env,
    ).map(({ name }) => [name, 'fixture-value']));
    Object.assign(values, {
      IOLAUS_DEPLOYMENT_PROTOCOL: 'smrt-release-v1',
      IOLAUS_WORKSPACE_MODE: 'shared',
      IOLAUS_OIDC_ADMIN_EMAILS: 'owner@example.invalid,operator@example.invalid',
    });
    assert.equal(actorSecretData(runtime, values, 'runtime').IOLAUS_OIDC_ADMIN_EMAILS,
      values.IOLAUS_OIDC_ADMIN_EMAILS);
    assert.throws(() => actorSecretData(runtime,
      { ...values, IOLAUS_OIDC_ADMIN_EMAILS: undefined }, 'runtime'), /Required/);
    assert.equal(actorSecretData(runtime,
      { ...values, IOLAUS_OIDC_ADMIN_EMAILS: '' }, 'runtime').IOLAUS_OIDC_ADMIN_EMAILS, '');
    assert.throws(() => actorSecretData(runtime,
      { ...values, IOLAUS_WORKSPACE_MODE: 'private', IOLAUS_OIDC_ADMIN_EMAILS: '' }, 'runtime'), /empty/);
  }
});

test('monitor and migration Secrets and env exclude runtime authentication and asset authority', () => {
  const runtime = candidateRuntime(images, syntheticAuthContract);
  const allKeys = new Set(
    [...Object.values(runtime.workloads), runtime.migration].flatMap(
      ({ env }) => env.map(({ name }) => name),
    ),
  );
  const values = Object.fromEntries(
    [...allKeys].map((key) => [key, 'fixture-value']),
  );
  values.IOLAUS_DEPLOYMENT_PROTOCOL = 'smrt-release-v1';
  for (const role of ['monitor', 'migration']) {
    const environment =
      role === 'monitor'
        ? runtime.workloads.monitor.env
        : runtime.migration.env;
    const data = actorSecretData(runtime, values, role);
    assert.deepEqual(
      Object.keys(data).sort(),
      environment.map(({ name }) => name).sort(),
    );
    for (const key of Object.keys(data))
      assert.doesNotMatch(
        key,
        /^(SMTP_|IOLAUS_(AUTH_|MAGIC_LINK_|OIDC_|PUBLIC_URL)|ADDRESS_HEADER|RESUME_FILES_)/,
      );
    assert.throws(
      () =>
        actorSecretData(runtime, { ...values, DATABASE_URL: undefined }, role),
      /Required/,
    );
  }
  assert.ok(
    runtime.migration.env.some(({ name }) => name === 'IOLAUS_WORKSPACE_MODE'),
  );
  assert.ok(
    !runtime.workloads.monitor.env.some(
      ({ name }) => name === 'IOLAUS_WORKSPACE_MODE',
    ),
  );
});

test('adoption requires explicit protocol while actual helper retains legacy mode only for undefined', async () => {
  const { releaseDeploymentProtocolEnabled } = await import(
    './smrt-deployment-schema.mjs'
  );
  const { syntheticRuntimeValues } = await import(
    './adoption-kind-fixture.mjs'
  );
  assert.equal(releaseDeploymentProtocolEnabled({}), false);
  assert.equal(
    releaseDeploymentProtocolEnabled({
      IOLAUS_DEPLOYMENT_PROTOCOL: 'smrt-release-v1',
    }),
    true,
  );
  const runtime = candidateRuntime(images, syntheticAuthContract);
  const values = {
    ...syntheticRuntimeValues('a'.repeat(48)),
    DATABASE_URL: 'postgresql://fixture/iolaus_qualification',
    IOLAUS_MAINTENANCE_OBSERVER_POLICY: '{}',
  };
  for (const actor of ['runtime', 'monitor', 'migration']) {
    const data = actorSecretData(runtime, values, actor);
    assert.equal(data.IOLAUS_DEPLOYMENT_PROTOCOL, 'smrt-release-v1');
    const missing = { ...values };
    delete missing.IOLAUS_DEPLOYMENT_PROTOCOL;
    assert.throws(
      () => actorSecretData(runtime, missing, actor),
      /Adoption requires explicit/,
    );
    for (const invalid of [
      '',
      'legacy',
      'smrt-release-v2',
      ' smrt-release-v1 ',
    ]) {
      assert.throws(() =>
        releaseDeploymentProtocolEnabled({
          IOLAUS_DEPLOYMENT_PROTOCOL: invalid,
        }),
      );
      assert.throws(() =>
        actorSecretData(
          runtime,
          { ...values, IOLAUS_DEPLOYMENT_PROTOCOL: invalid },
          actor,
        ),
      );
    }
  }
  for (const name of ['web', 'task', 'schedule'])
    assert.ok(
      runtime.workloads[name].env.some(
        (entry) =>
          entry.name === 'IOLAUS_DEPLOYMENT_PROTOCOL' &&
          entry.valueFrom.secretKeyRef.name === 'iolaus-runtime-v1' &&
          entry.valueFrom.secretKeyRef.key === 'IOLAUS_DEPLOYMENT_PROTOCOL',
      ),
    );
});
