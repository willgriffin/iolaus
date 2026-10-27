import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requireIsolatedContext, until } from './adoption-kind-fixture.mjs';

test('qualification refuses arbitrary kube contexts and namespaces', () => {
  requireIsolatedContext('kind-iolaus-236-abc123', 'iolaus-qualification');
  for (const context of [
    'production',
    'kind-production',
    'iolaus-236-abc123',
    '',
  ])
    assert.throws(() =>
      requireIsolatedContext(context, 'iolaus-qualification'),
    );
  assert.throws(() =>
    requireIsolatedContext('kind-iolaus-236-abc123', 'production'),
  );
});

test('polling requires actual successful observation and refuses timeout', async () => {
  let observations = 0;
  await until(
    'real observation',
    () => {
      observations++;
      return true;
    },
    0,
  );
  assert.equal(observations, 1);
  await assert.rejects(
    until('never successful', () => false, 0),
    /timed out/,
  );
});

test('inactive adoption workflow never auto-triggers, promotes or touches GitOps', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/adoption-qualification.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  (push|pull_request|release|schedule):/m);
  assert.doesNotMatch(
    workflow,
    /packages: write|contents: write|git push|imagetools create|kubeconfig.*secrets\./,
  );
  const base = readFileSync(
    new URL('../deploy/self-hosted/base/kustomization.yaml', import.meta.url),
    'utf8',
  );
  const production = readFileSync(
    new URL(
      '../deploy/self-hosted/production/kustomization.yaml',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(`${base}\n${production}`, /adoption/);
});
