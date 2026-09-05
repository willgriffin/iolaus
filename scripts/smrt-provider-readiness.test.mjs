import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderReadinessProbe } from './smrt-provider-readiness.mjs';

const hostedEnvironment = {
  DATABASE_URL: 'postgresql://operator:private@database.example.invalid/career_hub',
  IOLAUS_OIDC_ADMIN_EMAILS: 'owner@example.com',
  IOLAUS_OIDC_CLIENT_ID: 'career-hub',
  IOLAUS_OIDC_REALM: 'career',
  IOLAUS_OIDC_SERVER_URL: 'https://identity.example.invalid',
  IOLAUS_PUBLIC_URL: 'https://jobs.example.invalid',
  SMRT_APP_ID: 'career-hub',
  SMRT_RUNTIME_PROFILE: 'self-hosted',
};

const validDiscovery = {
  authorization_endpoint: 'https://identity.example.invalid/realms/career/protocol/openid-connect/auth',
  issuer: 'https://identity.example.invalid/realms/career',
  jwks_uri: 'https://identity.example.invalid/realms/career/protocol/openid-connect/certs',
  token_endpoint: 'https://identity.example.invalid/realms/career/protocol/openid-connect/token',
};

test('uses the released Keycloak discovery API for the default self-hosted OIDC provider', async () => {
  const calls = [];
  await createProviderReadinessProbe(
    'authentication',
    { profile: 'self-hosted', provider: 'oidc' },
    {
      dependencies: {
        async getAuth(options) {
          calls.push(options);
          return { getDiscoveryDocument: async () => validDiscovery };
        },
      },
      environment: hostedEnvironment,
    },
  )();
  assert.deepEqual(calls, [
    {
      clientId: 'career-hub',
      maxRetries: 0,
      realm: 'career',
      serverUrl: 'https://identity.example.invalid',
      timeout: 3_000,
      type: 'keycloak',
    },
  ]);
});

test('accepts the validated root issuer SDK adapter only when discovery issuer matches', async () => {
  const seen = [];
  await createProviderReadinessProbe(
    'authentication',
    { profile: 'self-hosted', provider: 'oidc' },
    {
      dependencies: {
        async getAuth(options) {
          seen.push(options);
          return {
            getDiscoveryDocument: async () => ({
              ...validDiscovery,
              authorization_endpoint: 'https://identity.example.invalid/protocol/openid-connect/auth',
              issuer: 'https://identity.example.invalid',
              jwks_uri: 'https://identity.example.invalid/protocol/openid-connect/certs',
              token_endpoint: 'https://identity.example.invalid/protocol/openid-connect/token',
            }),
          };
        },
      },
      environment: {
        ...hostedEnvironment,
        IOLAUS_OIDC_ISSUER_MODE: 'root',
        IOLAUS_OIDC_REALM: undefined,
      },
    },
  )();
  assert.equal(seen[0].realm, '..');

  await assert.rejects(
    createProviderReadinessProbe(
      'authentication',
      {
        oidc: {
          clientId: 'career-hub',
          issuer: 'https://identity.example.invalid',
          realm: '..',
          serverUrl: 'https://identity.example.invalid',
        },
        profile: 'self-hosted',
        provider: 'oidc',
      },
      {
        dependencies: {
          getAuth: async () => ({
            getDiscoveryDocument: async () => ({
              ...validDiscovery,
              issuer: 'https://other-issuer.example.invalid',
            }),
          }),
        },
        environment: hostedEnvironment,
      },
    )(),
    /authentication provider readiness failed\./u,
  );
});

test('fails closed and redacts invalid OIDC configuration and discovery failures', async () => {
  for (const environment of [
    { ...hostedEnvironment, IOLAUS_OIDC_REALM: '..' },
    { ...hostedEnvironment, IOLAUS_OIDC_CLIENT_ID: 'secret/invalid' },
  ]) {
    await assert.rejects(
      createProviderReadinessProbe(
        'authentication',
        { profile: 'self-hosted', provider: 'oidc' },
        {
          dependencies: { getAuth: async () => ({ getDiscoveryDocument: async () => validDiscovery }) },
          environment,
        },
      )(),
      (error) =>
        error.message === 'authentication provider readiness failed.' &&
        !error.message.includes('secret/invalid'),
    );
  }
});

test('fails closed and redacts OIDC upstream failures', async () => {
  for (const getAuth of [
    async () => {
      throw new Error('upstream credential detail');
    },
    async () => ({
      getDiscoveryDocument: async () => {
        throw new Error('upstream discovery detail');
      },
    }),
  ]) {
    await assert.rejects(
      createProviderReadinessProbe(
        'authentication',
        { profile: 'self-hosted', provider: 'oidc' },
        { dependencies: { getAuth }, environment: hostedEnvironment, timeoutMs: 20 },
      )(),
      (error) =>
        error.message === 'authentication provider readiness failed.' &&
        !error.message.includes('upstream credential detail') &&
        !error.message.includes('upstream discovery detail'),
    );
  }
});

test('performs one bounded, read-only HeadBucket probe for S3-compatible assets', async () => {
  const calls = [];
  class S3Client {
    constructor(options) {
      calls.push({ kind: 'client', options });
    }
    async send(command, options) {
      calls.push({ kind: 'send', command, options });
    }
    destroy() {
      calls.push({ kind: 'destroy' });
    }
  }
  class HeadBucketCommand {
    constructor(input) {
      this.input = input;
    }
  }
  await createProviderReadinessProbe(
    'assets',
    { profile: 'self-hosted', provider: 's3-compatible' },
    {
      dependencies: { HeadBucketCommand, S3Client },
      environment: {
        ...hostedEnvironment,
        RESUME_FILES_CONFIG_JSON: JSON.stringify({
          accessKeyId: 'access-key',
          bucket: 'resume-assets',
          endpoint: 'https://garage.example.invalid',
          forcePathStyle: true,
          region: 'garage',
          secretAccessKey: 'secret-key',
          type: 's3',
        }),
      },
    },
  )();
  assert.deepEqual(calls[1].command.input, { Bucket: 'resume-assets' });
  assert.ok(calls[1].options.abortSignal instanceof AbortSignal);
  assert.equal(calls[2].kind, 'destroy');
});

test('fails closed for malformed assets, unsupported defaults, and invalid environment secrets', async () => {
  await assert.rejects(
    createProviderReadinessProbe(
      'assets',
      { profile: 'self-hosted', provider: 's3-compatible' },
      {
        dependencies: {},
        environment: { ...hostedEnvironment, RESUME_FILES_CONFIG_JSON: '{not json' },
      },
    )(),
    /assets provider readiness failed\./u,
  );
  await assert.rejects(
    createProviderReadinessProbe(
      'assets',
      { profile: 'self-hosted', provider: 'local-files' },
      { environment: hostedEnvironment },
    )(),
    /assets provider readiness failed\./u,
  );
  await assert.rejects(
    createProviderReadinessProbe(
      'secrets',
      { profile: 'self-hosted', provider: 'environment' },
      { environment: { ...hostedEnvironment, DATABASE_URL: undefined } },
    )(),
    /secrets provider readiness failed\./u,
  );
});

test('fails closed for S3 upstream errors and destroys the client', async () => {
  let destroyed = false;
  class S3Client {
    send() {
      return Promise.reject(new Error('upstream S3 detail'));
    }
    destroy() {
      destroyed = true;
    }
  }
  class HeadBucketCommand {}
  await assert.rejects(
    createProviderReadinessProbe(
      'assets',
      { profile: 'self-hosted', provider: 's3-compatible' },
      {
        dependencies: { HeadBucketCommand, S3Client },
        environment: {
          ...hostedEnvironment,
          RESUME_FILES_CONFIG_JSON: JSON.stringify({
            accessKeyId: 'access-key',
            bucket: 'resume-assets',
            endpoint: 'https://garage.example.invalid',
            region: 'garage',
            secretAccessKey: 'secret-key',
            type: 's3',
          }),
        },
        timeoutMs: 20,
      },
    )(),
    (error) =>
      error.message === 'assets provider readiness failed.' &&
      !error.message.includes('upstream S3 detail'),
  );
  assert.equal(destroyed, true);
});

test('preserves explicit operator readiness module overrides', async () => {
  const seen = [];
  await createProviderReadinessProbe(
    'authentication',
    { profile: 'cloud', provider: 'hosted-identity' },
    {
      environment: { SMRT_AUTH_READINESS_MODULE: 'operator-readiness' },
      async importModule(specifier) {
        seen.push(specifier);
        return { checkReadiness: async () => ({ ready: true }) };
      },
    },
  )();
  assert.deepEqual(seen, ['operator-readiness']);
});
