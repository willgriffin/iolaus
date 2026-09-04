import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = resolve(root, 'deploy/self-hosted/base');
const production = resolve(root, 'deploy/self-hosted/production');

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
  requireText(rendered, 'value: self-hosted');
  requireText(rendered, 'name: migrate');
  requireText(rendered, 'pnpm --filter @willgriffin/iolaus-site db:migrate');
  requireText(rendered, 'name: iolaus-task-worker');
  requireText(rendered, 'name: iolaus-schedule-worker');
  requireText(rendered, 'scripts/smrt-worker-heartbeat.mjs');
  requireText(rendered, 'name: iolaus-queue-provider-monitor');
  if (rendered.includes(':latest') || rendered.includes('ghcr.io/willgriffin/iolaus/site:')) {
    throw new Error('Self-hosted topology must not use a mutable application image tag.');
  }
  if (count(rendered, '@sha256:REPLACE_WITH_RELEASED_IMAGE_DIGEST') < 7) {
    throw new Error('Every executable workload must require an immutable release digest.');
  }
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
