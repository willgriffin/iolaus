import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = resolve(root, 'deploy/self-hosted/base');
const production = resolve(root, 'deploy/self-hosted/production');
const monitorManifest = readFileSync(
  resolve(base, 'queue-provider-monitor.yaml'),
  'utf8',
);
const runnerDockerfile = readFileSync(resolve(root, 'apps/site/Dockerfile'), 'utf8');
const taskWorkerEntrypoint = readFileSync(
  resolve(root, 'apps/site/scripts/jobs-worker.ts'),
  'utf8',
);
const serverHooks = readFileSync(resolve(root, 'apps/site/src/hooks.server.ts'), 'utf8');

function render(path) {
  return execFileSync('kubectl', ['kustomize', path], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requireText(rendered, text) {
  if (!rendered.includes(text)) throw new Error(`Rendered topology is missing ${text}.`);
}

function count(rendered, text) {
  return rendered.split(text).length - 1;
}

const baseRendered = render(base);
const productionRendered = render(production);
const dependencyManifests = [
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')),
  JSON.parse(readFileSync(resolve(root, 'apps/site/package.json'), 'utf8')),
];

for (const manifest of dependencyManifests) {
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    if (!name.startsWith('@happyvertical/smrt')) continue;
    if (!/^\d+\.\d+\.\d+$/u.test(version)) {
      throw new Error(`${name} must be pinned to a released semantic version.`);
    }
  }
}

for (const rendered of [baseRendered, productionRendered]) {
  requireText(rendered, 'name: iolaus-runtime');
  requireText(rendered, 'name: iolaus-migration-runtime');
  requireText(rendered, 'name: iolaus-monitor-runtime');
  requireText(rendered, 'value: self-hosted');
  requireText(rendered, 'name: migrate');
  requireText(rendered, 'node --import tsx apps/site/scripts/db-migrate.ts');
  requireText(rendered, 'name: iolaus-task-worker');
  requireText(rendered, 'name: iolaus-schedule-worker');
  requireText(rendered, 'scripts/smrt-worker-heartbeat.mjs');
  requireText(rendered, 'name: iolaus-queue-provider-monitor');
  requireText(rendered, 'automountServiceAccountToken: false');
  if (count(rendered, 'automountServiceAccountToken: false') !== 4) {
    throw new Error('Every self-hosted workload must disable service-account token automounting.');
  }
  requireText(rendered, 'path: /live');
  if (count(rendered, 'runAsNonRoot: true') < 4 || count(rendered, 'runAsUser: 10001') < 4) {
    throw new Error('Every self-hosted workload must run as the fixed non-root image user.');
  }
  requireText(rendered, 'type: RuntimeDefault');
  if (
    count(rendered, '- ALL') < 8 ||
    count(rendered, 'readOnlyRootFilesystem: true') < 8 ||
    count(rendered, 'mountPath: /tmp') < 8
  ) {
    throw new Error('Every self-hosted init and main container must drop privileges and mount only its writable /tmp surface.');
  }
  if (rendered.includes(':latest') || rendered.includes('ghcr.io/willgriffin/iolaus/site:')) {
    throw new Error('Self-hosted topology must not use a mutable application image tag.');
  }
  if (count(rendered, '@sha256:REPLACE_WITH_RELEASED_IMAGE_DIGEST') < 7) {
    throw new Error('Every executable workload must require an immutable release digest.');
  }
  if (rendered.includes('command:\n      - pnpm')) {
    throw new Error('Self-hosted runtime commands must use image-contained direct executables.');
  }
}

if (!/USER 10001:10001/u.test(runnerDockerfile)) {
  throw new Error('The released application image must set its non-root runtime user.');
}
if (!/COPY --from=build --chown=iolaus:iolaus \/app \/app/u.test(runnerDockerfile)) {
  throw new Error('The released application image must be readable by its non-root user.');
}
if (!/test -x \/app\/node_modules\/.bin\/tsx/u.test(runnerDockerfile)) {
  throw new Error('The released image must contain its pinned direct TypeScript loader.');
}
if (!/node --import tsx --eval/u.test(runnerDockerfile)) {
  throw new Error('The released image must smoke its direct worker bootstrap without pnpm.');
}
if (
  !/corepack install --global pnpm@11\.24\.0/u.test(runnerDockerfile) ||
  !/USER 10001:10001[\s\S]*HOME=\/tmp pnpm --version/u.test(runnerDockerfile)
) {
  throw new Error('The released image must carry and smoke its pinned offline pnpm runtime.');
}
if (
  /scheduleRunner\.start\(\)/u.test(taskWorkerEntrypoint) ||
  !/startTaskWorker\(taskRunner\)/u.test(taskWorkerEntrypoint) ||
  !/startWorkerHeartbeat\(\{ kind: 'task' \}\)/u.test(taskWorkerEntrypoint) ||
  !/stopHeartbeat, taskRunner/u.test(taskWorkerEntrypoint)
) {
  throw new Error('The task worker must claim tasks only and retain its required heartbeat through task drain.');
}
if (/await ensureApplicationRuntimeReady\(\)/u.test(serverHooks)) {
  throw new Error('Server initialization must not block liveness on provider readiness.');
}
if (
  !/initContainers:[\s\S]*name: migrate[\s\S]*name: iolaus-migration-runtime[\s\S]*containers:[\s\S]*name: monitor[\s\S]*name: iolaus-monitor-runtime/u.test(
    monitorManifest,
  ) || /name: monitor[\s\S]*name: iolaus-runtime/u.test(monitorManifest)
) {
  throw new Error(
    'The queue/provider monitor must migrate with its scoped writer secret and query with its read-only secret.',
  );
}

requireText(productionRendered, 'kind: Ingress');
requireText(productionRendered, 'cert-manager.io/cluster-issuer');
requireText(productionRendered, 'iolaus.example.invalid');
if (productionRendered.includes('willgriffin.dev')) {
  throw new Error('The generic topology must not take ownership of a live domain.');
}

console.log(
  JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    baseResources: (baseRendered.match(/^kind: /gm) ?? []).length,
    productionResources: (productionRendered.match(/^kind: /gm) ?? []).length,
    immutableImageMode: 'release-digest-required',
  }),
);
