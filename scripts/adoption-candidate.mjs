import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseDeploymentProtocolEnabled } from './smrt-deployment-schema.mjs';

export const podSecurityContext = Object.freeze({
  runAsNonRoot: true,
  runAsUser: 10001,
  runAsGroup: 10001,
  fsGroup: 10001,
  seccompProfile: { type: 'RuntimeDefault' },
});
export const securityContext = Object.freeze({
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
});
const resources = (cpu, memory) => ({
  requests: { cpu: '100m', memory: '256Mi' },
  limits: { cpu, memory },
});
export const secret = (name, key, secretName = 'iolaus-runtime-v1') => ({
  name,
  valueFrom: { secretKeyRef: { name: secretName, key } },
});
const probe = (path, port) => ({ httpGet: { path, port } });
const heartbeat = {
  exec: { command: ['node', 'scripts/smrt-worker-heartbeat.mjs', '--check'] },
};
export const actorBaseKeys = Object.freeze([
  'DATABASE_URL',
  'SMRT_RUNTIME_PROFILE',
  'IOLAUS_DEPLOYMENT_PROTOCOL',
  'SMRT_APP_ID',
  'NODE_ENV',
  'HOME',
  'XDG_CACHE_HOME',
]);
export const syntheticAuthContract = Object.freeze({
  authMode: 'magic-link',
  workspaceMode: 'shared',
});

export function authenticationKeys(contract) {
  assert.ok(
    contract && typeof contract === 'object',
    'Explicit reviewed authentication contract required.',
  );
  assert.ok(['private', 'shared'].includes(contract.workspaceMode));
  if (contract.authMode === 'magic-link') {
    assert.deepEqual(Object.keys(contract).sort(), [
      'authMode',
      'workspaceMode',
    ]);
    assert.equal(
      contract.workspaceMode,
      'shared',
      'Magic-link requires shared workspace mode.',
    );
    return [
      'IOLAUS_AUTH_MODE',
      'IOLAUS_OIDC_ADMIN_EMAILS',
      'IOLAUS_MAGIC_LINK_SECRET',
      'SMTP_HOST',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'SMTP_FROM',
    ];
  }
  assert.equal(
    contract.authMode,
    'oidc',
    'Reviewed authMode must be oidc or magic-link.',
  );
  assert.deepEqual(Object.keys(contract).sort(), [
    'authMode',
    'oidcIssuerMode',
    'optionalOidcKeys',
    'workspaceMode',
  ]);
  assert.ok(['root', 'realm'].includes(contract.oidcIssuerMode));
  assert.ok(Array.isArray(contract.optionalOidcKeys));
  assert.equal(
    new Set(contract.optionalOidcKeys).size,
    contract.optionalOidcKeys.length,
  );
  assert.ok(
    contract.optionalOidcKeys.every((key) =>
      [
        'IOLAUS_OIDC_CLIENT_SECRET',
        'IOLAUS_OIDC_IMPORTED_OWNER_BINDINGS',
      ].includes(key),
    ),
  );
  return [
    'IOLAUS_AUTH_MODE',
    'IOLAUS_OIDC_SERVER_URL',
    'IOLAUS_OIDC_ISSUER_MODE',
    'IOLAUS_OIDC_CLIENT_ID',
    ...(contract.oidcIssuerMode === 'realm' ? ['IOLAUS_OIDC_REALM'] : []),
    'IOLAUS_OIDC_ADMIN_EMAILS',
    ...contract.optionalOidcKeys,
  ];
}

const runtimeEnv = (contract) =>
  [
    ...actorBaseKeys,
    'IOLAUS_PUBLIC_URL',
    'IOLAUS_WORKSPACE_MODE',
    'ADDRESS_HEADER',
    'RESUME_FILES_CONFIG_JSON',
    ...authenticationKeys(contract),
  ].map((name) => secret(name, name));
const workerEnv = (contract) => [
  ...runtimeEnv(contract),
  secret('SMRT_WORKER_HEARTBEAT_FILE', 'SMRT_WORKER_HEARTBEAT_FILE'),
  secret(
    'SMRT_WORKER_HEARTBEAT_MAX_AGE_MS',
    'SMRT_WORKER_HEARTBEAT_MAX_AGE_MS',
  ),
];

// Both manifest references and actual fixture Secret data use this projection.
// A role-specific Secret never contains another actor's credentials.
export function actorSecretData(runtime, values, role) {
  assert.equal(
    releaseDeploymentProtocolEnabled(values),
    true,
    'Adoption requires explicit IOLAUS_DEPLOYMENT_PROTOCOL=smrt-release-v1.',
  );
  const environment =
    role === 'runtime'
      ? runtime.workloads.web.env.concat(
          runtime.workloads.task.env,
          runtime.workloads.schedule.env,
        )
      : role === 'monitor'
        ? runtime.workloads.monitor.env
        : role === 'migration'
          ? runtime.migration.env
          : null;
  assert.ok(environment, 'Unknown Secret actor.');
  return Object.fromEntries(
    [
      ...new Set(environment.map((entry) => entry.valueFrom.secretKeyRef.key)),
    ].map((key) => {
      assert.equal(
        typeof values[key],
        'string',
        `Required ${role} configuration key missing: ${key}`,
      );
      assert.ok(
        values[key].length > 0 ||
          (key === 'IOLAUS_OIDC_ADMIN_EMAILS' &&
            values.IOLAUS_WORKSPACE_MODE === 'shared'),
        `Required ${role} configuration key empty: ${key}`,
      );
      return [key, values[key]];
    }),
  );
}

export function immutableImage(value, repository) {
  assert.match(
    value,
    new RegExp(`^${repository.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`),
  );
  return value;
}

// A target builder, deliberately not a HelmRelease or a GitOps entrypoint.
// Every identity must be supplied from a real published platform artifact.
export function candidateRuntime(images, reviewedContract) {
  authenticationKeys(reviewedContract);
  assert.deepEqual(
    Object.keys(images).sort(),
    ['extractor', 'site'],
    'Only the exact reviewed image pair is accepted.',
  );
  const site = immutableImage(images.site, 'ghcr.io/willgriffin/iolaus/site');
  const extractor = immutableImage(
    images.extractor,
    'ghcr.io/willgriffin/iolaus/resume-import-extraction',
  );
  const hardened = (image, command, role, writer, env) => ({
    image,
    command,
    role,
    writer,
    env,
    replicas: 1,
    serviceAccountName: 'iolaus-runtime',
    podSecurityContext: structuredClone(podSecurityContext),
    securityContext: structuredClone(securityContext),
    nodeSelector: {
      'kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'amd64',
    },
    scratch: [{ name: 'tmp', mountPath: '/tmp', sizeLimit: '1Gi' }],
    resources: resources('1', '1Gi'),
    terminationGracePeriodSeconds: 90,
  });
  const web = hardened(site, ['node', 'apps/site/build'], 'web', true, [
    ...runtimeEnv(reviewedContract),
    ...[
      'HOST',
      'PORT',
      'BODY_SIZE_LIMIT',
      'IOLAUS_RESUME_EXTRACTION_URL',
      'HAVE_PDF_PADDLEOCR_URL',
    ].map((name) => secret(name, name)),
  ]);
  Object.assign(web, {
    replicas: 2,
    port: 3000,
    service: { port: 3000 },
    readinessProbe: probe('/health', 3000),
    startupProbe: {
      ...probe('/health', 3000),
      failureThreshold: 24,
      periodSeconds: 5,
      timeoutSeconds: 3,
    },
    livenessProbe: probe('/live', 3000),
  });
  const task = hardened(
    site,
    ['node', '--import', 'tsx', 'apps/site/scripts/jobs-worker.ts'],
    'task',
    true,
    [
      ...workerEnv(reviewedContract),
      ...[
        'SMRT_WORKER_CONCURRENCY',
        'SMRT_JOBS_WORKER_CONCURRENCY',
        'SMRT_JOBS_WORKER_SHUTDOWN_MS',
        'IOLAUS_RESUME_EXTRACTION_URL',
        'HAVE_PDF_PADDLEOCR_URL',
      ].map((name) => secret(name, name)),
    ],
  );
  Object.assign(task, {
    readinessProbe: heartbeat,
    startupProbe: heartbeat,
    livenessProbe: heartbeat,
    terminationGracePeriodSeconds: 270,
  });
  const schedule = hardened(
    site,
    ['node', 'scripts/smrt-worker.mjs', 'schedule'],
    'schedule',
    true,
    workerEnv(reviewedContract),
  );
  Object.assign(schedule, {
    readinessProbe: heartbeat,
    startupProbe: heartbeat,
    livenessProbe: heartbeat,
  });
  const extraction = hardened(
    extractor,
    ['node', '/app/apps/site/scripts/resume-import-extraction.mjs'],
    'service',
    false,
    [],
  );
  Object.assign(extraction, {
    port: 8080,
    service: { port: 8080 },
    readinessProbe: probe('/health', 8080),
    livenessProbe: probe('/health', 8080),
    resources: resources('1', '512Mi'),
    scratch: [{ name: 'tmp', mountPath: '/tmp', sizeLimit: '32Mi' }],
  });
  const monitor = hardened(
    site,
    ['node', '--import', 'tsx', 'apps/site/scripts/deployment-monitor.ts'],
    'task',
    true,
    actorBaseKeys.map((name) => secret(name, name, 'iolaus-monitor-v1')),
  );
  Object.assign(monitor, {
    serviceAccountName: 'iolaus-monitor',
    schedule: '*/5 * * * *',
    readinessProbe: { exec: { command: ['node', '--version'] } },
    resources: resources('250m', '256Mi'),
  });
  const migration = {
    image: site,
    command: [
      'pnpm',
      '--filter',
      '@willgriffin/iolaus-site',
      'db:release-migrate',
      '--',
      '--maintenance-window',
    ],
    env: [
      ...[...actorBaseKeys, 'IOLAUS_WORKSPACE_MODE'].map((name) =>
        secret(name, name, 'iolaus-migration-v1'),
      ),
      secret(
        'IOLAUS_MAINTENANCE_OBSERVER_POLICY',
        'IOLAUS_MAINTENANCE_OBSERVER_POLICY',
        'iolaus-migration-v1',
      ),
    ],
    guard: 'smrt-release-v1',
    serviceAccountName: 'iolaus-migration-observer',
    observerAccess: true,
    podSecurityContext: structuredClone(podSecurityContext),
    securityContext: structuredClone(securityContext),
    scratch: [{ name: 'tmp', mountPath: '/tmp', sizeLimit: '1Gi' }],
    resources: resources('1', '1Gi'),
    terminationGracePeriodSeconds: 300,
  };
  return {
    workloads: { web, task, schedule, extractor: extraction, monitor },
    migration,
  };
}

export function requirePublishedPrerequisites(input) {
  assert.equal(input.schema, 'iolaus-adoption-prerequisites:v1');
  assert.equal(
    input.rollout,
    'held',
    'Qualification cannot authorize rollout.',
  );
  assert.equal(
    input.chart.reference,
    'oci://ghcr.io/happyvertical/charts/smrt-app',
  );
  assert.equal(input.chart.version, '0.2.1', 'Supported chart version required.');
  assert.match(
    input.chart.ociDigest ?? '',
    /^sha256:[a-f0-9]{64}$/,
    'Public chart OCI digest required.',
  );
  assert.match(
    input.chart.packageSha256 ?? '',
    /^[a-f0-9]{64}$/,
    'Public packaged chart digest required.',
  );
  assert.equal(
    input.runner.repository,
    'https://github.com/happyvertical/smrt.git',
  );
  assert.match(
    input.runner.revision ?? '',
    /^[a-f0-9]{40}$/,
    'Public runner source commit required.',
  );
  return input;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [imageFile, contractFile, output] = process.argv.slice(2);
  assert.ok(
    imageFile && contractFile && output,
    'Usage: node scripts/adoption-candidate.mjs images.json reviewed-contract.json target-runtime.json',
  );
  writeFileSync(
    output,
    `${JSON.stringify(candidateRuntime(JSON.parse(readFileSync(imageFile, 'utf8')), JSON.parse(readFileSync(contractFile, 'utf8'))), null, 2)}\n`,
    { flag: 'wx' },
  );
}
