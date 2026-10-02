import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalRuntimePaths } from '@happyvertical/smrt-app-runtime';
import { chromium, request } from '@playwright/test';
import { resolveApplicationStateRoot } from '../../../scripts/smrt-runtime-identity.mjs';
import { startSourceCoverageProvider } from './source-coverage-provider.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export default async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'iolaus-mobile-e2e-')));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const coverageProvider =
    process.env.IOLAUS_E2E_SOURCE_COVERAGE === '1'
      ? await startSourceCoverageProvider(root)
      : undefined;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'SYSTEMROOT',
    'XDG_STATE_HOME',
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    SMRT_APP_ID: 'iolaus-e2e',
    SMRT_DATA_DIR: join(root, 'runtime'),
    SMRT_RUNTIME_PROFILE: 'local',
    SMRT_BACKGROUND_JOBS: 'false',
    IOLAUS_ENABLE_DEMO_FIXTURES: '1',
    IOLAUS_E2E_FIXTURE: join(root, 'fixture.json'),
    IOLAUS_DEMO_OWNER_EMAIL: 'mobile-qa@example.invalid',
    IOLAUS_E2E_FOREIGN_AUTH: join(root, 'foreign-auth.json'),
    HOST: '127.0.0.1',
    PORT: String(port),
    ORIGIN: origin,
    TURBO_FORCE: 'true',
    CI: 'true',
    pnpm_config_verify_deps_before_run: 'false',
    // Exercise the upstream PDF renderer with the existing test browser.
    PUPPETEER_EXECUTABLE_PATH: chromium.executablePath(),
  });
  if (coverageProvider) {
    // Only this disposable test opt-in supplies fictional local transports.
    // Native governance, principal checks and job execution stay enabled.
    Object.assign(environment, {
      IOLAUS_E2E_SOURCE_COVERAGE: '1',
      HAVE_AI_BASE_URL: coverageProvider.baseUrl,
      HAVE_AI_OPPORTUNITY_INTELLIGENCE_EXTRACTION_BASE_URL:
        coverageProvider.baseUrl,
      HAVE_AI_OPPORTUNITY_INTELLIGENCE_EXTRACTION_API_KEY:
        'fictional-local-provider-key',
      HAVE_AI_OPPORTUNITY_INTELLIGENCE_EXTRACTION_MODEL: 'openai/gpt-6-luna',
      TYPESAFE_API_KEY: 'fictional-local-provider-key',
      OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED: 'true',
      OPPORTUNITY_INTELLIGENCE_ENABLED: 'true',
      OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT: '4',
      OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT: '80000',
      OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS: '100000',
      OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT: '100',
      OPPORTUNITY_INTELLIGENCE_CRAWL_INPUT_TOKEN_LIMIT: '1000000',
      OPPORTUNITY_INTELLIGENCE_CRAWL_SPEND_LIMIT_MICROS: '1000000',
      OPPORTUNITY_INTELLIGENCE_CIRCUIT_REQUEST_THRESHOLD: '100',
      OPPORTUNITY_INTELLIGENCE_CIRCUIT_INPUT_TOKEN_THRESHOLD: '1000000',
      OPPORTUNITY_INTELLIGENCE_INPUT_COST_MICROS_PER_MILLION: '100000',
      OPPORTUNITY_INTELLIGENCE_OUTPUT_COST_MICROS_PER_MILLION: '500000',
      OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION: '100000',
      OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION: '500000',
    });
  }
  const stateRoot = resolveApplicationStateRoot({
    appId: 'iolaus-e2e',
    dataDirectory: environment.SMRT_DATA_DIR,
    sourceRoot: repository,
  });
  const logPath = join(root, 'setup.log');
  async function run(binary: string, args: string[]) {
    const log = openSync(logPath, 'a', 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: repository,
          env: environment,
          stdio: ['ignore', log, log],
          timeout: 600_000,
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(`E2E setup command failed (${code}); see ${logPath}`),
            );
        });
      });
    } finally {
      closeSync(log);
    }
  }
  const app = (command: string) =>
    run(process.execPath, ['scripts/smrt-app.mjs', command]);
  const site = (script: string) =>
    run('pnpm', [
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'tsx',
      script,
    ]);
  let server: ChildProcess | undefined;
  async function startServer() {
    const paths = resolveLocalRuntimePaths({
      appId: 'iolaus-e2e',
      dataDirectory: environment.SMRT_DATA_DIR,
      sourceRoot: repository,
    });
    const log = openSync(logPath, 'a', 0o600);
    try {
      server = spawn(process.execPath, ['build/index.js'], {
        cwd: join(repository, 'apps/site'),
        env: {
          ...environment,
          DATABASE_TYPE: 'sqlite',
          DATABASE_URL: paths.database,
          SMRT_ASSETS_DIR: paths.assets,
        },
        stdio: ['ignore', log, log],
      });
    } finally {
      closeSync(log);
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error(`E2E server exited; see ${logPath}`);
      try {
        const response = await fetch(origin, {
          redirect: 'manual',
          signal: AbortSignal.timeout(1_000),
        });
        if (response.status < 500) return;
      } catch {
        /* Wait for the owned server to bind. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`E2E server did not become ready; see ${logPath}`);
  }
  async function cleanup(removeData: boolean) {
    if (server && server.exitCode === null && server.signalCode === null) {
      const child = server;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`E2E shutdown timed out; retained ${root}`));
        }, 10_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    await coverageProvider?.close();
    if (removeData) {
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
  try {
    await app('setup');
    await run('pnpm', [
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'smrt',
      'db:status',
    ]);
    await site('scripts/demo-permissions.ts');
    await startServer();
    const handoff = JSON.parse(
      readFileSync(join(stateRoot, 'onboarding.json'), 'utf8'),
    );
    const url = new URL(handoff.url);
    if (url.origin !== origin || url.pathname !== '/setup')
      throw new Error('Unexpected onboarding origin');
    const api = await request.newContext({ baseURL: origin });
    try {
      const response = await api.post('/setup/', {
        headers: { origin, accept: 'text/html' },
        form: {
          token: url.searchParams.get('token') ?? '',
          name: 'Fictional Mobile QA Owner',
          email: 'mobile-qa@example.invalid',
        },
        maxRedirects: 0,
      });
      if (response.status() !== 303)
        throw new Error(`Owner setup failed (${response.status()})`);
      const ownerStorage = await api.storageState({
        path: join(root, 'auth.json'),
      });
      const sessionCookies = ownerStorage.cookies.filter(
        (cookie) => cookie.httpOnly && cookie.path === '/',
      );
      if (sessionCookies.length !== 1)
        throw new Error('Expected exactly one native owner session cookie');
      // Use the runtime fingerprint minted by the running server, whose
      // database environment can differ from the seed CLI process.
      environment.IOLAUS_E2E_SESSION_COOKIE_NAME = sessionCookies[0].name;
      chmodSync(join(root, 'auth.json'), 0o600);
    } finally {
      await api.dispose();
    }
    // Owner setup and native membership must exist before private fixtures.
    await site('e2e/seed.ts');
    const health = await fetch(`${origin}/api/admin-resources/tasks`, {
      headers: {
        cookie: JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8'))
          .cookies.map(
            (cookie: { name: string; value: string }) =>
              `${cookie.name}=${cookie.value}`,
          )
          .join('; '),
      },
    });
    if (!health.ok)
      throw new Error(
        `Task fixture endpoint returned ${health.status}; see ${logPath}`,
      );
    console.log(
      'E2E runtime ready: build, db:migrate, db:status, synthetic seed and authenticated task data passed.',
    );
    process.env.IOLAUS_E2E_LOG = logPath;
    process.env.IOLAUS_E2E_ORIGIN = origin;
    process.env.IOLAUS_E2E_FOREIGN_AUTH = environment.IOLAUS_E2E_FOREIGN_AUTH;
    process.env.IOLAUS_E2E_AUTH = join(root, 'auth.json');
    process.env.IOLAUS_E2E_FIXTURE = environment.IOLAUS_E2E_FIXTURE;
    if (coverageProvider) {
      const environmentPath = join(
        root,
        'source-coverage-runtime-environment.json',
      );
      writeFileSync(environmentPath, JSON.stringify(environment), {
        mode: 0o600,
      });
      chmodSync(environmentPath, 0o600);
      process.env.IOLAUS_E2E_RUNTIME_ENVIRONMENT = environmentPath;
      process.env.IOLAUS_E2E_PROVIDER_EVENTS = coverageProvider.eventsPath;
    }
    return () => cleanup(true);
  } catch (error) {
    try {
      await cleanup(false);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `E2E setup/cleanup failed; see ${logPath}`,
      );
    }
    throw error;
  }
}
