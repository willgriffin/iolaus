#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveApplicationId,
  resolveApplicationStateRoot,
} from './smrt-runtime-identity.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
const appId = resolveApplicationId({
  sourceRoot,
  packageName: packageJson.name,
  explicitId: process.env.SMRT_APP_ID || 'iolaus',
});
const markerName = '.iolaus-demo-root.json';
const markerSchema = 'iolaus-demo-root:v1';
const command = process.argv[2] || 'status';

function canonicalExistingOrResolved(path) {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
  return resolve(canonicalAncestor, relative(ancestor, absolute));
}

export function defaultDemoRoot() {
  // Interactive recursive reset is restricted to this fixed app-owned child.
  // Environment-selected deletion targets would make markers forgeable scope.
  return canonicalExistingOrResolved(join(homedir(), '.iolaus-demo'));
}

export function assertSafeDemoRoot(root, checkout = sourceRoot) {
  if (!isAbsolute(root)) throw new Error('The demo data directory must be absolute.');
  const canonicalRoot = canonicalExistingOrResolved(root);
  const protectedRoots = [
    canonicalExistingOrResolved(checkout),
    canonicalExistingOrResolved(homedir()),
    canonicalExistingOrResolved(tmpdir()),
  ];
  if (protectedRoots.includes(canonicalRoot)) {
    throw new Error('Refusing to use a broad or source-controlled demo data directory.');
  }
  const sourceRelative = relative(canonicalExistingOrResolved(checkout), canonicalRoot);
  if (sourceRelative && !sourceRelative.startsWith('..') && !isAbsolute(sourceRelative)) {
    throw new Error('The demo data directory must remain outside the source checkout.');
  }
  return canonicalRoot;
}

function markerPath(root) {
  return join(root, markerName);
}

function markerPayload(root) {
  return {
    schema: markerSchema,
    appId,
    root,
    sourceFingerprint: createHash('sha256').update(sourceRoot).digest('hex'),
  };
}

function validMarker(marker, root) {
  const expected = markerPayload(root);
  return (
    marker?.schema === expected.schema &&
    marker?.appId === expected.appId &&
    marker?.root === expected.root &&
    marker?.sourceFingerprint === expected.sourceFingerprint
  );
}

export function initializeDemoRoot(root) {
  const safeRoot = assertSafeDemoRoot(root);
  const marker = markerPath(safeRoot);
  if (existsSync(safeRoot) && !existsSync(marker) && readdirSync(safeRoot).length > 0) {
    throw new Error(`Refusing to adopt non-empty unmarked directory: ${safeRoot}`);
  }
  mkdirSync(safeRoot, { recursive: true, mode: 0o700 });
  if (existsSync(marker)) {
    const existing = JSON.parse(readFileSync(marker, 'utf8'));
    if (!validMarker(existing, safeRoot)) {
      throw new Error(`Invalid demo ownership marker at ${marker}.`);
    }
  } else {
    writeFileSync(marker, `${JSON.stringify(markerPayload(safeRoot), null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return safeRoot;
}

export function assertOwnedDemoRoot(root) {
  const safeRoot = assertSafeDemoRoot(root);
  const marker = markerPath(safeRoot);
  if (!existsSync(marker)) throw new Error(`Refusing to reset unmarked directory: ${safeRoot}`);
  const existing = JSON.parse(readFileSync(marker, 'utf8'));
  if (!validMarker(existing, safeRoot)) {
    throw new Error(`Refusing to reset directory with an invalid marker: ${safeRoot}`);
  }
  return safeRoot;
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: sourceRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error || result.status !== 0) {
    const details = options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(
      `${options.label || binary} failed with exit code ${result.status ?? 1}.${details}`,
      { cause: result.error },
    );
  }
  return result;
}

function pnpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && basename(npmExecPath).toLowerCase().startsWith('pnpm')) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, options);
}

function demoEnvironment(root, overrides = {}) {
  return {
    ...process.env,
    ...overrides,
    SMRT_APP_ID: appId,
    // Keep the demo ownership marker outside the runtime-owned data root. The
    // s-m-r-t runtime quite correctly refuses any pre-populated, unowned root.
    SMRT_DATA_DIR: join(root, 'runtime'),
    SMRT_RUNTIME_PROFILE: 'local',
    IOLAUS_ENABLE_DEMO_FIXTURES: '1',
    // Generated manifests are ignored build artifacts. A shared Turbo cache
    // can replay logs without materializing them into a fresh checkout, so the
    // demo install always performs its own deterministic build.
    TURBO_FORCE: 'true',
    HOST: '127.0.0.1',
    PORT: overrides.PORT || process.env.IOLAUS_DEMO_PORT || process.env.PORT || '5173',
  };
}

function app(commandName, environment, options = {}) {
  return run(process.execPath, [join(sourceRoot, 'scripts', 'smrt-app.mjs'), commandName], {
    ...options,
    env: environment,
    label: `app:${commandName}`,
  });
}

function seedFixture(environment) {
  const result = pnpm(
    ['--filter', '@willgriffin/iolaus-site', 'exec', 'tsx', 'scripts/demo-fixture.ts'],
    { capture: true, env: environment, label: 'synthetic demo fixture' },
  );
  return JSON.parse(result.stdout);
}

function seedDemoOwnerPermissions(environment) {
  pnpm(
    [
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'tsx',
      'scripts/demo-permissions.ts',
    ],
    { capture: true, env: environment, label: 'demo owner permissions' },
  );
}

function browserWebMcpRegistration(environment) {
  // The registration spec mounts a fake document.modelContext and verifies
  // page-native registration. The inventory script reads the same exported
  // definitions that the authenticated command-center layout registers.
  pnpm(
    [
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'vitest',
      'run',
      'src/lib/webmcp.spec.ts',
    ],
    { capture: true, env: environment, label: 'browser WebMCP registration' },
  );
}

function authenticatedBrowserWebMcp(environment, cookie, fixture, screenshotPath) {
  const result = pnpm(
    [
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'tsx',
      'scripts/demo-live-webmcp.ts',
    ],
    {
      capture: true,
      env: {
        ...environment,
        IOLAUS_DEMO_APPLICATION_ID: fixture.applicationId,
        IOLAUS_DEMO_CRAWL_ID: fixture.crawlId,
        IOLAUS_DEMO_OPPORTUNITY_ID: fixture.opportunityId,
        IOLAUS_DEMO_SOURCE_ID: fixture.sourceId,
        IOLAUS_DEMO_TRIAGE_OPPORTUNITY_ID: fixture.triageOpportunityId,
        IOLAUS_DEMO_ORIGIN: `http://127.0.0.1:${environment.PORT}`,
        IOLAUS_DEMO_SCREENSHOT: screenshotPath,
        IOLAUS_DEMO_SESSION_COOKIE: cookie,
      },
      label: 'authenticated browser WebMCP proof',
    },
  );
  return JSON.parse(result.stdout);
}

function readOnboardingUrl(root) {
  const stateRoot = resolveApplicationStateRoot({
    appId,
    dataDirectory: join(root, 'runtime'),
    sourceRoot,
  });
  const payload = JSON.parse(readFileSync(join(stateRoot, 'onboarding.json'), 'utf8'));
  const url = new URL(payload.url);
  if (
    payload.schemaVersion !== 1 || url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' || url.pathname !== '/setup' ||
    !url.searchParams.get('token')
  ) throw new Error('The private onboarding handoff is invalid.');
  return url;
}

function cookieFrom(response) {
  const first = (response.headers.get('set-cookie') || '').split(';', 1)[0];
  if (!first.includes('=')) throw new Error('Owner setup did not establish a session.');
  return first;
}

async function authenticatedProof(root, fixture, environment, screenshotPath) {
  const setupUrl = readOnboardingUrl(root);
  const form = new URLSearchParams({
    token: setupUrl.searchParams.get('token'),
    name: 'Jordan Example',
    email: 'jordan.example@demo.invalid',
  });
  const setupOptions = {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: setupUrl.origin,
      'user-agent': 'iolaus-demo-smoke/1',
    },
    body: form,
  };
  let setup = await fetch(setupUrl, setupOptions);
  if (setup.status === 307 || setup.status === 308) {
    const location = setup.headers.get('location');
    if (!location) throw new Error('Owner setup redirect omitted its destination.');
    setup = await fetch(new URL(location, setupUrl), setupOptions);
  }
  let cookie;
  try {
    cookie = cookieFrom(setup);
  } catch {
    throw new Error(
      `Owner setup failed closed with HTTP ${setup.status} (${setup.headers.get('location') || 'no redirect'}).`,
    );
  }
  const origin = `http://127.0.0.1:${environment.PORT}`;
  const headers = { cookie };
  const commandCenter = await fetch(`${origin}/admin/`, { headers });
  if (commandCenter.status !== 200) {
    throw new Error(`Authenticated command center returned ${commandCenter.status}.`);
  }

  browserWebMcpRegistration(environment);
  const webmcp = authenticatedBrowserWebMcp(
    environment,
    cookie,
    fixture,
    screenshotPath,
  );
  const names = Array.isArray(webmcp.toolNames)
    ? webmcp.toolNames.map(String).filter(Boolean)
    : [];
  for (const required of [
    'job_search_browse_opportunities',
    'job_search_list_source_health',
    'job_search_source_crawl_status',
    'job_search_next_triage_candidate',
    'job_search_record_decision',
    'job_search_inspect_opportunity',
    'job_search_inspect_application',
  ]) {
    if (!names.includes(required)) throw new Error(`Authenticated tool inventory is missing ${required}.`);
  }

  const browse = webmcp.browse;
  const serializedBrowse = JSON.stringify(browse);
  if (!serializedBrowse.includes(fixture.opportunityId)) {
    throw new Error('The deterministic opportunity was not returned by browse.');
  }
  const inspect = webmcp.application;
  const serializedInspect = JSON.stringify(inspect);
  const preparation = webmcp.preparation;
  const serializedPreparation = JSON.stringify(preparation);
  if (
    preparation?.application?.id !== fixture.applicationId ||
    preparation?.application?.status !== 'awaiting_user'
  ) {
    throw new Error(
      'Browser WebMCP did not prepare the synthetic application at the approval boundary.',
    );
  }
  if (!serializedInspect.includes(fixture.applicationId)) {
    throw new Error('The deterministic application was not returned by inspect.');
  }
  const sourceHealth = JSON.stringify(webmcp.sourceHealth);
  const crawlStatus = JSON.stringify(webmcp.crawlStatus);
  if (!sourceHealth.includes(fixture.sourceId) || !sourceHealth.includes('ashby')) {
    throw new Error('Browser WebMCP did not expose the fictional provider health.');
  }
  if (
    !crawlStatus.includes(fixture.crawlId) ||
    !crawlStatus.includes(fixture.sourceId) ||
    !crawlStatus.includes('completed')
  ) {
    throw new Error('Browser WebMCP did not expose the terminal fictional crawl.');
  }
  if (webmcp.triage?.candidate?.id !== fixture.triageOpportunityId) {
    throw new Error('Browser WebMCP did not return the fictional triage candidate.');
  }
  if (!JSON.stringify(webmcp.triageInspection).includes(fixture.triageOpportunityId)) {
    throw new Error('Browser WebMCP did not inspect the triage candidate.');
  }
  const persistedTriage = JSON.stringify(webmcp.persistedTriage);
  if (
    !persistedTriage.includes('Fictional demo review note') ||
    !JSON.stringify(webmcp.decision).includes('maybe') ||
    webmcp.advancedTriage?.candidate !== null
  ) {
    throw new Error('Browser WebMCP did not persist and advance the local triage decision.');
  }
  if (webmcp.triageModalVisible !== true) {
    throw new Error('The authenticated browser did not open the existing triage modal.');
  }
  if (inspect?.application?.status !== 'awaiting_user') {
    throw new Error('Application inspection did not expose the human approval boundary.');
  }
  for (const privateValue of [
    'jordan.example@demo.invalid',
    'Jordan Example',
    'Fictional demo answer only',
    'iolaus-demo-fictional-candidate',
  ]) {
    if (
      serializedBrowse.includes(privateValue) ||
      serializedInspect.includes(privateValue) ||
      serializedPreparation.includes(privateValue)
    ) {
      throw new Error(`Browser WebMCP exposed private fixture data: ${privateValue}.`);
    }
  }

  const browserToolNames = names.filter((name) => name.startsWith('job_search_'));
  if (browserToolNames.some((name) => /submit|approve/iu.test(name))) {
    throw new Error('The agent tool surface unexpectedly exposes approval or submission.');
  }
  return {
    applicationId: fixture.applicationId,
    approvalBoundary: 'awaiting_user; no approval or submission tool exposed',
    authenticatedCommandCenter: true,
    browserToolNames,
    crawlId: fixture.crawlId,
    opportunityId: fixture.opportunityId,
    privateCandidateDataExposed: false,
    screenshotPath: webmcp.screenshotPath,
    sourceId: fixture.sourceId,
    triageDecisionPersisted: true,
    triageModalVisible: true,
  };
}

async function prepare(root, options = {}) {
  const ownedRoot = initializeDemoRoot(root);
  const environment = demoEnvironment(ownedRoot, options.environment);
  app('setup', environment);
  seedDemoOwnerPermissions(environment);
  const fixture = seedFixture(environment);
  app('start', environment);
  if (options.open !== false) app('open', environment);
  return {
    schema: 'iolaus-demo-prepare:v1', status: 'ready', dataRoot: ownedRoot,
    applicationId: fixture.applicationId, opportunityId: fixture.opportunityId,
    origin: `http://127.0.0.1:${environment.PORT}`,
    next: 'Complete the private owner handoff, then open /admin/ in a WebMCP-capable browser.',
    externalTransmissionPerformed: false,
  };
}

async function stopAndReset(root) {
  const ownedRoot = assertOwnedDemoRoot(root);
  const environment = demoEnvironment(ownedRoot);
  // Keep the marked profile if authenticated process shutdown cannot be
  // confirmed; never remove a database beneath a possibly live process.
  app('stop', environment, { capture: true });
  rmSync(ownedRoot, { recursive: true, force: true });
  return { schema: 'iolaus-demo-reset:v1', status: 'reset', dataRoot: ownedRoot };
}

async function smoke() {
  const root = initializeDemoRoot(mkdtempSync(join(tmpdir(), 'iolaus-demo-smoke-')));
  const evidencePath = resolve(
    process.env.IOLAUS_DEMO_EVIDENCE || join(sourceRoot, '.omo', 'evidence', 'issue-7', 'demo-smoke.json'),
  );
  const environment = demoEnvironment(root, {
    PORT: process.env.IOLAUS_DEMO_SMOKE_PORT || '5797',
    SMRT_OPEN_STUB: join(root, 'browser-open.txt'),
  });
  const evidence = {
    schema: 'iolaus-demo-smoke:v1', status: 'failed',
    revision: run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim(),
    startedAt: new Date().toISOString(), checks: [], externalTransmissionPerformed: false,
  };
  try {
    app('setup', environment);
    evidence.checks.push('clean SQLite setup and private owner handoff');
    seedDemoOwnerPermissions(environment);
    evidence.checks.push('local demo owner permission catalog');
    const fixture = seedFixture(environment);
    evidence.checks.push('deterministic production-disabled synthetic fixture');
    app('start', environment);
    evidence.checks.push('loopback application start and health readiness');
    evidence.proof = await authenticatedProof(
      root,
      fixture,
      environment,
      join(dirname(evidencePath), 'browser-command-center.png'),
    );
    evidence.checks.push(
      'authenticated browser WebMCP browse and application inspect with fail-closed approval boundary',
    );
    evidence.status = 'passed';
    evidence.completedAt = new Date().toISOString();
    return evidence;
  } catch (error) {
    evidence.completedAt = new Date().toISOString();
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    let stopped = false;
    try {
      app('stop', environment, { capture: true });
      stopped = true;
    } finally {
      // A failed ownership check leaves an explicitly marked recovery artifact
      // instead of deleting live process state.
      if (stopped) rmSync(root, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
  }
}

async function main() {
  if (command === 'prepare') console.log(JSON.stringify(await prepare(defaultDemoRoot()), null, 2));
  else if (command === 'smoke') await smoke();
  else if (command === 'reset') console.log(JSON.stringify(await stopAndReset(defaultDemoRoot()), null, 2));
  else if (command === 'status') {
    const root = defaultDemoRoot();
    console.log(JSON.stringify({
      schema: 'iolaus-demo-status:v1',
      status: existsSync(markerPath(root)) ? 'initialized' : 'not_initialized',
      dataRoot: root,
      recovery: existsSync(markerPath(root))
        ? 'Run pnpm demo:prepare to repair/start, or pnpm demo:reset for a clean demo.'
        : 'Run pnpm demo:prepare.',
    }, null, 2));
  } else throw new Error(`Unknown demo command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
