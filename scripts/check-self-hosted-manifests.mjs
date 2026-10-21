import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
const resumeExtractorUrl = 'http://iolaus-resume-import-extraction:8080';
const paddleOcrUrl = 'http://paddleocr-vl.paddleocr-vl.svc.cluster.local';
for (const workload of ['web-deployment.yaml', 'task-worker-deployment.yaml']) {
  const manifest = readFileSync(resolve(base, workload), 'utf8');
  if (!manifest.includes(`name: IOLAUS_RESUME_EXTRACTION_URL\n              value: ${resumeExtractorUrl}`)) {
    throw new Error(`${workload} must use the private resume extraction service.`);
  }
  if (!manifest.includes(`name: HAVE_PDF_PADDLEOCR_URL\n              value: ${paddleOcrUrl}`)) {
    throw new Error(`${workload} must use the approved private PaddleOCR service.`);
  }
}
const namespaceManifest = readFileSync(resolve(base, 'namespace.yaml'), 'utf8');
if (!namespaceManifest.includes("happyvertical.com/paddleocr-client: 'true'")) {
  throw new Error('The Iolaus namespace must be allowlisted as a PaddleOCR client.');
}

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
  resolve(root, 'package.json'),
  resolve(root, 'apps/site/package.json'),
].map((path) => ({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) }));
const releaseClosurePath = resolve(
  root,
  'vendor/release/release-closure.json',
);
const releaseClosure = existsSync(releaseClosurePath)
  ? JSON.parse(readFileSync(releaseClosurePath, 'utf8'))
  : { packages: [], localSupplements: [] };
const embeddedReleaseClosure = new Map(
  [...(releaseClosure.packages ?? []), ...(releaseClosure.localSupplements ?? [])].map(
    (pkg) => [pkg.name, `file:vendor/release/${pkg.tarball}`],
  ),
);

for (const { path: manifestPath, manifest } of dependencyManifests) {
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    const embeddedArchive = embeddedReleaseClosure.get(name);
    if (typeof version === 'string' && version.startsWith('file:')) {
      const expectedArchive = embeddedArchive && resolve(root, embeddedArchive.slice('file:'.length));
      const declaredArchive = resolve(dirname(manifestPath), version.slice('file:'.length));
      if (!expectedArchive || expectedArchive !== declaredArchive) {
        throw new Error(
          `${name} must use the tarball recorded in vendor/release/release-closure.json.`,
        );
      }
      const archivePath = resolve(root, embeddedArchive.slice('file:'.length));
      if (!existsSync(archivePath)) {
        throw new Error(`${name} qualified embedded archive is missing.`);
      }
      continue;
    }
    if (!name.startsWith('@happyvertical/smrt')) continue;
    if (!/^\d+\.\d+\.\d+$/u.test(version)) {
      throw new Error(`${name} must be pinned to a released semantic version.`);
    }
  }
}

for (const supplement of releaseClosure.localSupplements ?? []) {
  if (supplement.provenance !== 'local-compatibility-repack') {
    throw new Error(`${supplement.name} must declare its local compatibility provenance.`);
  }
  execFileSync(
    'node',
    ['scripts/verify-ingestion-archive.mjs', '--provenance', supplement.provenanceFile],
    { cwd: root, stdio: 'inherit' },
  );
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
  requireText(rendered, 'name: iolaus-resume-import-extraction');
  requireText(rendered, 'scripts/smrt-worker-heartbeat.mjs');
  requireText(rendered, 'name: iolaus-queue-provider-monitor');
  requireText(rendered, 'automountServiceAccountToken: false');
  if (count(rendered, 'automountServiceAccountToken: false') !== 5) {
    throw new Error('Every self-hosted workload must disable service-account token automounting.');
  }
  requireText(rendered, 'path: /live');
  if (count(rendered, 'runAsNonRoot: true') < 5 || count(rendered, 'runAsUser: 10001') < 5) {
    throw new Error('Every self-hosted workload must run as the fixed non-root image user.');
  }
  requireText(rendered, 'type: RuntimeDefault');
  if (
    count(rendered, '- ALL') < 9 ||
    count(rendered, 'readOnlyRootFilesystem: true') < 9 ||
    count(rendered, 'mountPath: /tmp') < 9
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
  !/npm install --global pnpm@11\.25\.0/u.test(runnerDockerfile) ||
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
// The retry callback may await readiness and vocabulary loading; only awaiting
// the retry loop itself from ServerInit would block the liveness endpoint.
if (
  !/void startRuntimeThenPrime\(/u.test(serverHooks) ||
  /await startRuntimeThenPrime\(/u.test(serverHooks)
) {
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
