import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const runtimeKeys = [
  'DATABASE_URL',
  'SMRT_RUNTIME_PROFILE',
  'SMRT_APP_ID',
  'NODE_ENV',
  'HOME',
  'XDG_CACHE_HOME',
  'IOLAUS_AUTH_MODE',
  'IOLAUS_MAGIC_LINK_SECRET',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM',
  'RESUME_FILES_CONFIG_JSON',
];
const runtimeEnv = () => runtimeKeys.map((name) => secret(name, name));
const workerEnv = () => [
  ...runtimeEnv(),
  secret('SMRT_WORKER_HEARTBEAT_FILE', 'SMRT_WORKER_HEARTBEAT_FILE'),
  secret(
    'SMRT_WORKER_HEARTBEAT_MAX_AGE_MS',
    'SMRT_WORKER_HEARTBEAT_MAX_AGE_MS',
  ),
];

export function immutableImage(value, repository) {
  assert.match(
    value,
    new RegExp(`^${repository.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`),
  );
  return value;
}

// A target builder, deliberately not a HelmRelease or a GitOps entrypoint.
// Every identity must be supplied from a real published platform artifact.
export function candidateRuntime(images) {
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
    ...runtimeEnv(),
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
      ...workerEnv(),
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
    workerEnv(),
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
    runtimeKeys.map((name) => secret(name, name, 'iolaus-monitor-v1')),
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
      ...runtimeKeys.map((name) => secret(name, name, 'iolaus-migration-v1')),
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
  assert.equal(input.chart.version, '0.2.0');
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
  const [imageFile, output] = process.argv.slice(2);
  assert.ok(
    imageFile && output,
    'Usage: node scripts/adoption-candidate.mjs images.json target-runtime.json',
  );
  writeFileSync(
    output,
    `${JSON.stringify(candidateRuntime(JSON.parse(readFileSync(imageFile, 'utf8'))), null, 2)}\n`,
    { flag: 'wx' },
  );
}
