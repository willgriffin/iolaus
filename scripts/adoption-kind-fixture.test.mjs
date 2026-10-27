import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  fixtureIdentity,
  fixtureDatabaseUrl,
  fixtureDatabaseSql,
  requireIsolatedContext,
  until,
} from './adoption-kind-fixture.mjs';

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

test('synthetic database matches the hosted application namespace and sends real psql lines', () => {
  const url = new URL(fixtureDatabaseUrl('iolaus_runtime', 'a'.repeat(48)));
  assert.equal(
    url.pathname.slice(1),
    fixtureIdentity.applicationId.replaceAll('-', '_'),
  );
  assert.notEqual(url.pathname, '/iolaus');
  assert.deepEqual(fixtureDatabaseSql('SELECT 1;').split('\n'), [
    '\\connect iolaus_qualification',
    'SELECT 1;',
    '',
  ]);
  assert.doesNotMatch(fixtureDatabaseSql('SELECT 1;'), /\\n/);
  assert.throws(() => fixtureDatabaseUrl('postgres', 'a'.repeat(48)));
});

test('synthetic shared magic-link configuration satisfies real application auth contract', async () => {
  const { getAuthConfiguration } = await import(
    '../apps/site/src/lib/server/app-config.ts'
  );
  const { syntheticRuntimeValues } = await import(
    './adoption-kind-fixture.mjs'
  );
  const values = syntheticRuntimeValues('a'.repeat(48));
  assert.equal(getAuthConfiguration(values).kind, 'magic-link');
  assert.equal(values.IOLAUS_WORKSPACE_MODE, 'shared');
  for (const key of [
    'IOLAUS_PUBLIC_URL',
    'IOLAUS_WORKSPACE_MODE',
    'ADDRESS_HEADER',
    'IOLAUS_MAGIC_LINK_SECRET',
    'SMTP_PASSWORD',
  ]) {
    const incomplete = { ...values };
    delete incomplete[key];
    assert.equal(getAuthConfiguration(incomplete).kind, 'invalid', key);
  }
});

test('explicit private OIDC actor data satisfies real resolver without magic-link or SMTP keys', async () => {
  const { getAuthConfiguration } = await import(
    '../apps/site/src/lib/server/app-config.ts'
  );
  const { candidateRuntime, actorSecretData } = await import(
    './adoption-candidate.mjs'
  );
  const { syntheticRuntimeValues, fixtureDatabaseUrl } = await import(
    './adoption-kind-fixture.mjs'
  );
  const images = {
    site: `ghcr.io/willgriffin/iolaus/site@sha256:${'a'.repeat(64)}`,
    extractor: `ghcr.io/willgriffin/iolaus/resume-import-extraction@sha256:${'b'.repeat(64)}`,
  };
  for (const oidcIssuerMode of ['realm', 'root']) {
    const contract = {
      authMode: 'oidc',
      workspaceMode: 'private',
      oidcIssuerMode,
      optionalOidcKeys: [],
    };
    const runtime = candidateRuntime(images, contract);
    const data = actorSecretData(
      runtime,
      {
        ...syntheticRuntimeValues('a'.repeat(48)),
        DATABASE_URL: fixtureDatabaseUrl('iolaus_runtime', 'a'.repeat(48)),
        IOLAUS_AUTH_MODE: 'oidc',
        IOLAUS_WORKSPACE_MODE: 'private',
        IOLAUS_OIDC_SERVER_URL: 'https://id.example.invalid',
        IOLAUS_OIDC_ISSUER_MODE: oidcIssuerMode,
        IOLAUS_OIDC_REALM: 'fixture',
        IOLAUS_OIDC_CLIENT_ID: 'fixture',
        IOLAUS_OIDC_ADMIN_EMAILS: 'operator@example.invalid',
      },
      'runtime',
    );
    const resolved = getAuthConfiguration(data);
    assert.equal(resolved.kind, 'self-hosted', oidcIssuerMode);
    assert.equal(resolved.oidc.issuerMode, oidcIssuerMode);
    assert.equal(data.IOLAUS_MAGIC_LINK_SECRET, undefined);
    assert.equal(data.SMTP_PASSWORD, undefined);
    const incomplete = { ...data };
    delete incomplete.IOLAUS_OIDC_ADMIN_EMAILS;
    assert.equal(getAuthConfiguration(incomplete).kind, 'invalid');
  }
});
