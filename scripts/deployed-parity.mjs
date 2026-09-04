#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultEvidencePath = resolve(
  repositoryRoot,
  '.omo/evidence/issue-31/deployed-parity-contract.json',
);
const imagePattern =
  /^ghcr\.io\/willgriffin\/iolaus\/site@sha256:[a-f0-9]{64}$/u;

const scenarios = [
  {
    id: 'generated-surfaces',
    invocation: [
      'pnpm',
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'vitest',
      'run',
      'scripts/deployed-parity-inventory.spec.ts',
      'src/lib/server/api-exposure.spec.ts',
      'src/lib/server/api-resources.spec.ts',
      'src/lib/server/resources-discovery.spec.ts',
      'src/lib/server/mcp.spec.ts',
      'src/lib/webmcp.spec.ts',
    ],
    observable:
      'generated REST, MCP, and browser WebMCP match the reviewed snapshot and effect metadata',
  },
  {
    id: 'authentication-redaction-approval',
    invocation: [
      'pnpm',
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'vitest',
      'run',
      'src/lib/server/runtime-diagnostics.spec.ts',
      'src/lib/server/auth.spec.ts',
      'src/lib/server/role-permissions.spec.ts',
      'src/lib/server/application-inspect-webmcp.spec.ts',
      'src/lib/server/resume-webmcp.spec.ts',
      'src/routes/api/[resource]/resource-routes.spec.ts',
      'src/routes/api/job-search/[action]/job-search-route.spec.ts',
      'src/routes/api/mcp/call/mcp-call-route.spec.ts',
    ],
    observable:
      'unauthorized requests fail closed, private fields are projected out, and approval/submission stay human-only',
  },
  {
    id: 'workflow-and-triage',
    invocation: [
      'pnpm',
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'vitest',
      'run',
      'src/lib/server/job-search-webmcp.spec.ts',
      'src/lib/server/opportunity-data-surface-actions.spec.ts',
      'src/lib/opportunity-bulk-workflows.spec.ts',
      'src/lib/server/application-workflow.spec.ts',
      'src/lib/server/application-package.spec.ts',
      'src/lib/server/auto-submit-application-job.spec.ts',
      'src/lib/server/auto-submit-eligibility.spec.ts',
      'src/lib/server/ats/greenhouse.spec.ts',
      'src/lib/server/ats/ashby.spec.ts',
      'src/lib/server/ats/lever.spec.ts',
      'src/routes/api/admin/opportunities/bulk-actions/[phase]/server.spec.ts',
    ],
    observable:
      'synthetic browse, inspect, import, decision, application, resume, bulk, and approval-boundary workflows pass',
  },
  {
    id: 'provider-and-worker',
    invocation: [
      'pnpm',
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'vitest',
      'run',
      'src/lib/server/source-webmcp.spec.ts',
      'src/lib/server/source-crawl-job.spec.ts',
      'src/lib/server/source-crawl-job-schema.spec.ts',
      'src/lib/server/source-crawl-accounting.spec.ts',
      'src/lib/server/source-crawl-watchdog.spec.ts',
      'src/lib/server/opportunity-source-crawler.spec.ts',
      'src/lib/server/source-schedules.spec.ts',
      'src/lib/server/deployment-monitor.spec.ts',
      'src/lib/server/deployment-monitor-query.spec.ts',
      'src/lib/server/job-dispatch-seam.spec.ts',
      'scripts/jobs-worker-config.spec.ts',
      'scripts/jobs-worker-runtime.spec.ts',
      'scripts/jobs-worker-lifecycle.spec.ts',
    ],
    observable:
      'synthetic provider execution, task/schedule separation, fencing, retry, idempotency, recovery, and drain pass',
  },
  {
    id: 'worker-heartbeat',
    invocation: [
      'node',
      '--test',
      'scripts/smrt-worker-heartbeat.test.mjs',
    ],
    observable: 'task and schedule process heartbeat freshness fails closed',
  },
  {
    id: 'self-hosted-topology',
    invocation: ['pnpm', 'deploy:self-hosted:check'],
    observable:
      'web, task worker, schedule worker, and aggregate provider monitor remain separate digest-pinned workloads',
  },
  {
    id: 'inventory-snapshot',
    invocation: [
      'pnpm',
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'tsx',
      'scripts/deployed-parity-inventory.ts',
    ],
    observable:
      'reviewed inventory and released s-m-r-t dependency lock digest match exactly',
  },
];

function argumentValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function validateImageReference(value) {
  if (value === undefined) return null;
  if (!imagePattern.test(value)) {
    throw new Error(
      '--image-ref must be the exact released ghcr.io/willgriffin/iolaus/site sha256 reference.',
    );
  }
  return value;
}

export function validateCandidateImageMetadata(
  metadata,
  expectedRevision,
  expectedLockfileSha256,
) {
  const imageRef = validateImageReference(metadata.imageRef);
  if (
    !Array.isArray(metadata.repoDigests) ||
    !metadata.repoDigests.includes(imageRef)
  ) {
    throw new Error(
      'The locally inspected image is not bound to the requested immutable digest.',
    );
  }
  const labels = metadata.labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new Error(
      'The candidate image has no verifiable build provenance labels.',
    );
  }
  const sourceRevision = labels['org.opencontainers.image.revision'];
  const dependencyLockSha256 =
    labels['dev.happyvertical.iolaus.pnpm-lock.sha256'];
  if (sourceRevision !== expectedRevision) {
    throw new Error(
      'The candidate image source revision does not match this checkout.',
    );
  }
  if (dependencyLockSha256 !== expectedLockfileSha256) {
    throw new Error(
      'The candidate image dependency lock digest does not match this checkout.',
    );
  }
  return { dependencyLockSha256, sourceRevision };
}

function inspectCandidateImage(
  imageRef,
  expectedRevision,
  expectedLockfileSha256,
) {
  const inspect = (format) => {
    const result = spawnSync(
      'docker',
      ['image', 'inspect', '--format', format, imageRef],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        'The exact candidate image must be present locally for provenance verification.',
      );
    }
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new Error('The candidate image returned invalid provenance metadata.');
    }
  };
  return validateCandidateImageMetadata(
    {
      imageRef,
      labels: inspect('{{json .Config.Labels}}'),
      repoDigests: inspect('{{json .RepoDigests}}'),
    },
    expectedRevision,
    expectedLockfileSha256,
  );
}

export function buildScenarioEnvironment(sandboxRoot, source = process.env) {
  const networkDenyHook = resolve(
    repositoryRoot,
    'scripts/deny-outbound-network.cjs',
  );
  const home = resolve(sandboxRoot, 'home');
  const temporary = resolve(sandboxRoot, 'tmp');
  const config = resolve(sandboxRoot, 'config');
  const cache = resolve(sandboxRoot, 'cache');
  const corepackHome =
    source.COREPACK_HOME ||
    (source.HOME ? resolve(source.HOME, '.cache/node/corepack') : undefined);
  for (const path of [home, temporary, config, cache]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return {
    PATH: source.PATH ?? '',
    ...(source.PNPM_HOME ? { PNPM_HOME: source.PNPM_HOME } : {}),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: 'true',
    NODE_ENV: 'test',
    NODE_OPTIONS: `--require=${networkDenyHook}`,
    HOME: home,
    TMPDIR: temporary,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    ...(corepackHome ? { COREPACK_HOME: corepackHome } : {}),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    SMRT_RUNTIME_PROFILE: 'local',
  };
}

function executeScenario(scenario, environment) {
  const [binary, ...args] = scenario.invocation;
  const result = spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${scenario.id} failed with exit code ${result.status ?? 1}; rerun its documented invocation for local diagnostics.`,
      { cause: result.error },
    );
  }
  return {
    id: scenario.id,
    invocation: scenario.invocation.join(' '),
    observable: scenario.observable,
    status: 'passed',
  };
}

function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !/^[a-f0-9]{40}\n?$/u.test(result.stdout)) {
    throw new Error('The exact source revision could not be resolved.');
  }
  return result.stdout.trim();
}

function assertCleanRevision() {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (result.status !== 0 || result.stdout.trim() !== '') {
    throw new Error(
      'The parity contract requires a clean committed revision so its evidence is immutable.',
    );
  }
}

function runtimeVersions() {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((part) => Number(part));
  if (major < 24 || (major === 24 && minor < 18)) {
    throw new Error('The parity contract requires Node 24.18 or newer.');
  }
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
  );
  const requiredPnpm = String(manifest.packageManager || '').replace(
    /^pnpm@/u,
    '',
  );
  const pnpm = spawnSync('pnpm', ['--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const actualPnpm = pnpm.stdout.trim();
  if (pnpm.status !== 0 || actualPnpm !== requiredPnpm) {
    throw new Error(`The parity contract requires pnpm ${requiredPnpm}.`);
  }
  return { node: process.versions.node, pnpm: actualPnpm };
}

function inventorySnapshot(environment) {
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@willgriffin/iolaus-site',
      'exec',
      'tsx',
      'scripts/deployed-parity-inventory.ts',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error('The deployed parity inventory could not be verified.');
  }
  const line = result.stdout
    .trim()
    .split('\n')
    .findLast((candidate) => candidate.startsWith('{'));
  const parsed = JSON.parse(line || '{}');
  if (parsed.status !== 'passed' || parsed.secretValuesIncluded !== false) {
    throw new Error('The deployed parity inventory result is invalid.');
  }
  return parsed;
}

function writeEvidence(path, evidence) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, absolute);
  return absolute;
}

export function invalidateEvidence(path) {
  try {
    unlinkSync(resolve(path));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function evidenceDigest(evidence) {
  return createHash('sha256')
    .update(`${JSON.stringify(evidence)}\n`)
    .digest('hex');
}

async function main() {
  const argv = process.argv.slice(2);
  const evidencePath = argumentValue('--evidence', argv) ?? defaultEvidencePath;
  invalidateEvidence(evidencePath);
  assertCleanRevision();
  const runtime = runtimeVersions();
  const imageRef = validateImageReference(argumentValue('--image-ref', argv));
  const startedAt = new Date().toISOString();
  const revision = gitRevision();
  const sandboxBase = resolve(
    process.env.HOME || tmpdir(),
    '.cache/iolaus-parity-contract',
  );
  mkdirSync(sandboxBase, { recursive: true, mode: 0o700 });
  const sandboxRoot = mkdtempSync(resolve(sandboxBase, 'iolaus-parity-'));
  let checks;
  let inventory;
  try {
    const environment = buildScenarioEnvironment(sandboxRoot);
    checks = scenarios.map((scenario) =>
      executeScenario(scenario, environment),
    );
    inventory = inventorySnapshot(environment);
  } finally {
    rmSync(sandboxRoot, { force: true, recursive: true });
  }
  const candidateImageProvenance = imageRef
    ? inspectCandidateImage(
        imageRef,
        revision,
        inventory.dependencyLockSha256,
      )
    : null;
  if (candidateImageProvenance) {
    checks.push({
      id: 'candidate-image-provenance',
      invocation: 'docker image inspect <candidate-image-ref>',
      observable:
        'the immutable local image digest embeds this exact source revision and dependency lock digest',
      status: 'passed',
    });
  }
  const evidence = {
    schema: 'iolaus-deployed-parity-contract:v1',
    status: 'passed',
    scope: imageRef ? 'candidate-image-source-contract' : 'source-contract',
    revision,
    runtime,
    candidateImageRef: imageRef,
    candidateImageProvenance,
    inventorySha256: inventory.inventorySha256,
    dependencyLockSha256: inventory.dependencyLockSha256,
    smrtDependencies: inventory.smrtDependencies,
    counts: inventory.counts,
    checks,
    startedAt,
    completedAt: new Date().toISOString(),
    isolation: {
      callerEnvironmentInherited: false,
      outboundNetworkDenied: true,
      scenarioRuntimeProfile: 'local',
      temporaryHome: true,
    },
    syntheticDataOnly: true,
    productionAccessPerformed: false,
    externalTransmissionPerformed: false,
    secretValuesIncluded: false,
  };
  const path = writeEvidence(evidencePath, {
    ...evidence,
    evidenceSha256: evidenceDigest(evidence),
  });
  console.log(
    JSON.stringify({
      schema: evidence.schema,
      status: evidence.status,
      scope: evidence.scope,
      revision: evidence.revision,
      candidateImageRef: evidence.candidateImageRef,
      inventorySha256: evidence.inventorySha256,
      dependencyLockSha256: evidence.dependencyLockSha256,
      evidencePath: path,
      secretValuesIncluded: false,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
