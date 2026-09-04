#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
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
const localImageIdPattern = /^sha256:[a-f0-9]{64}$/u;
const darwinNetworkSandboxProfile =
  '(version 1) (allow default) (deny network-outbound (remote ip))';

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

export function validateLocalImageId(value) {
  if (value === undefined) return null;
  if (!localImageIdPattern.test(value)) {
    throw new Error('--local-image-id must be an exact sha256 Docker image ID.');
  }
  return value;
}

function validateCandidateReference(value) {
  if (imagePattern.test(value) || localImageIdPattern.test(value)) return value;
  throw new Error('Candidate execution requires an immutable image reference.');
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
  candidateRef,
  expectedRevision,
  expectedLockfileSha256,
  releaseEligible,
) {
  const inspect = (format) => {
    const result = spawnSync(
      'docker',
      ['image', 'inspect', '--format', format, candidateRef],
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
  const labels = inspect('{{json .Config.Labels}}');
  const provenance = releaseEligible
    ? validateCandidateImageMetadata(
        {
          imageRef: candidateRef,
          labels,
          repoDigests: inspect('{{json .RepoDigests}}'),
        },
        expectedRevision,
        expectedLockfileSha256,
      )
    : validateLocalCandidateImageMetadata(
        {
          actualImageId: inspect('{{json .Id}}'),
          imageId: candidateRef,
          labels,
        },
        expectedRevision,
        expectedLockfileSha256,
      );
  return {
    ...provenance,
    binding: releaseEligible ? 'released-repository-digest' : 'local-image-id',
  };
}

export function validateLocalCandidateImageMetadata(
  metadata,
  expectedRevision,
  expectedLockfileSha256,
) {
  const imageId = validateLocalImageId(metadata.imageId);
  if (metadata.actualImageId !== imageId) {
    throw new Error(
      'The locally inspected image is not bound to the requested immutable image ID.',
    );
  }
  const labels = metadata.labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new Error(
      'The local candidate image has no verifiable build provenance labels.',
    );
  }
  const sourceRevision = labels['org.opencontainers.image.revision'];
  const dependencyLockSha256 =
    labels['dev.happyvertical.iolaus.pnpm-lock.sha256'];
  if (sourceRevision !== expectedRevision) {
    throw new Error(
      'The local candidate image source revision does not match this checkout.',
    );
  }
  if (dependencyLockSha256 !== expectedLockfileSha256) {
    throw new Error(
      'The local candidate image dependency lock digest does not match this checkout.',
    );
  }
  return { dependencyLockSha256, sourceRevision };
}

export function candidateImageInvocation(candidateRef, invocation) {
  validateCandidateReference(candidateRef);
  return {
    backend: 'docker-network-none',
    binary: 'docker',
    args: [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=1g,uid=10001,gid=10001',
      '--env',
      'CI=true',
      '--env',
      'NODE_ENV=test',
      '--env',
      'SMRT_RUNTIME_PROFILE=local',
      '--env',
      'HOME=/tmp/home',
      '--env',
      'TMPDIR=/tmp',
      '--env',
      'XDG_CONFIG_HOME=/tmp/config',
      '--env',
      'XDG_CACHE_HOME=/tmp/cache',
      '--env',
      'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
      '--env',
      'NODE_OPTIONS=--require=/app/scripts/deny-outbound-network.cjs',
      '--entrypoint',
      '/usr/bin/env',
      candidateRef,
      ...invocation,
    ],
  };
}

export function sourceFingerprint(root, paths) {
  const hash = createHash('sha256');
  for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
    if (
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      path.includes('\0')
    ) {
      throw new Error('Source fingerprint paths must stay within the repository.');
    }
    const content = readFileSync(resolve(root, path));
    hash.update(`${Buffer.byteLength(path)}:${path}:${content.length}:`);
    hash.update(content);
  }
  return hash.digest('hex');
}

function sourceFingerprintContents(contents, paths) {
  const hash = createHash('sha256');
  for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
    const content = contents.get(path);
    if (!content) {
      throw new Error('The candidate image is missing reviewed tracked source bytes.');
    }
    hash.update(`${Buffer.byteLength(path)}:${path}:${content.length}:`);
    hash.update(content);
  }
  return hash.digest('hex');
}

function archivePath(path) {
  const normalized = path.replace(/^\.\/?/u, '').replace(/\/+$/u, '');
  if (!normalized && path === '.') return '.';
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '..' || part === '') ||
    normalized.includes('\0')
  ) {
    throw new Error('The candidate image archive contains an unsafe path.');
  }
  return normalized;
}

function tarString(header, start, length) {
  const end = header.indexOf(0, start);
  return header
    .subarray(start, end < 0 || end > start + length ? start + length : end)
    .toString('utf8');
}

function tarSize(header) {
  const raw = tarString(header, 124, 12).trim();
  if (!/^[0-7]*$/u.test(raw)) {
    throw new Error('The candidate image archive has an unsupported entry size.');
  }
  const size = Number.parseInt(raw || '0', 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('The candidate image archive has an unsafe entry size.');
  }
  return size;
}

function tarOctal(header, start, length, label) {
  const raw = tarString(header, start, length).trim();
  if (!/^[0-7]+$/u.test(raw)) {
    throw new Error(`The candidate image archive has an invalid ${label}.`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The candidate image archive has an unsafe ${label}.`);
  }
  return value;
}

function assertTarChecksum(header) {
  const expected = tarOctal(header, 148, 8, 'header checksum');
  const actual = header.reduce(
    (sum, value, index) => sum + (index >= 148 && index < 156 ? 0x20 : value),
    0,
  );
  if (actual !== expected) {
    throw new Error('The candidate image archive header checksum is invalid.');
  }
}

function parsePaxRecords(content) {
  const records = {};
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) {
      throw new Error('The candidate image archive has malformed PAX metadata.');
    }
    const length = Number.parseInt(content.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1) {
      throw new Error('The candidate image archive has malformed PAX metadata.');
    }
    const end = offset + length;
    if (end > content.length || content[end - 1] !== 0x0a) {
      throw new Error('The candidate image archive has malformed PAX metadata.');
    }
    const record = content.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) {
      throw new Error('The candidate image archive has malformed PAX metadata.');
    }
    const key = record.slice(0, equals);
    if (Object.hasOwn(records, key)) {
      throw new Error('The candidate image archive has ambiguous PAX metadata.');
    }
    records[key] = record.slice(equals + 1);
    offset = end;
  }
  return records;
}

function tarHeader(header, pax) {
  const prefix = tarString(header, 345, 155);
  const name = tarString(header, 0, 100);
  const pathname = pax.path ?? (prefix ? `${prefix}/${name}` : name);
  return {
    path: archivePath(pathname),
    size: tarSize(header),
    type: String.fromCharCode(header[156] || 0),
  };
}

function isRegularTarEntry(type) {
  return type === '\0' || type === '0';
}

function tarPadding(size) {
  return (512 - (size % 512)) % 512;
}

async function inspectDockerExport(containerId, targets) {
  const expected = new Map(
    [...targets.entries()].map(([path, target]) => [archivePath(path), target]),
  );
  const sourceRelevantPaths = new Set();
  for (const path of expected.keys()) {
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      sourceRelevantPaths.add(parts.slice(0, index).join('/'));
    }
  }
  const seen = new Map();
  const appEntries = new Set();
  const linkPaths = new Set();
  const contents = new Map();
  const command = spawn('docker', ['export', containerId], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let buffered = Buffer.alloc(0);
  let current = null;
  let finished = false;
  let nextPax = {};

  const processEntry = (entry, content) => {
    if (entry.type === 'g') {
      throw new Error('The candidate image archive has ambiguous global PAX metadata.');
    }
    if (entry.type === 'x') {
      if (Object.keys(nextPax).length > 0) {
        throw new Error('The candidate image archive has ambiguous PAX metadata.');
      }
      const metadata = parsePaxRecords(content);
      if (Object.keys(metadata).some((key) => key !== 'path')) {
        throw new Error('The candidate image archive has unsupported PAX metadata.');
      }
      nextPax = metadata;
      return;
    }
    const target = expected.get(entry.path);
    const sourceRelevant = sourceRelevantPaths.has(entry.path);
    if (entry.path === 'app' || entry.path.startsWith('app/')) {
      if (appEntries.has(entry.path)) {
        throw new Error('The candidate image archive repeats a normalized application path.');
      }
      appEntries.add(entry.path);
    }
    if (sourceRelevant && (entry.type === '1' || entry.type === '2')) {
      linkPaths.add(entry.path);
    }
    if (
      sourceRelevant &&
      !isRegularTarEntry(entry.type) &&
      entry.type !== '5'
    ) {
      throw new Error('The candidate image archive has an unsupported source entry type.');
    }
    if (!target) return;
    if (seen.has(entry.path)) {
      throw new Error('The candidate image archive repeats a reviewed tracked path.');
    }
    seen.set(entry.path, entry.type);
    if (!isRegularTarEntry(entry.type) || content.length !== target.size) {
      throw new Error('The candidate image tracked source bytes could not be inspected safely.');
    }
    contents.set(target.key, content);
  };

  const drain = () => {
    while (true) {
      if (!current) {
        if (buffered.length < 512) return;
        const header = buffered.subarray(0, 512);
        buffered = buffered.subarray(512);
        if (header.every((value) => value === 0)) {
          finished = true;
          return;
        }
        assertTarChecksum(header);
        const pax = nextPax;
        nextPax = {};
        const entry = tarHeader(header, pax);
        if (!['\0', '0', '1', '2', '5', 'x', 'g'].includes(entry.type)) {
          throw new Error('The candidate image archive has an unsupported entry type.');
        }
        const target = expected.get(entry.path);
        const capture = entry.type === 'g' || entry.type === 'x' || Boolean(target);
        const limit =
          entry.type === 'g' || entry.type === 'x'
            ? 1024 * 1024
            : target?.maxSize ?? target?.size;
        if (capture && (limit === undefined || entry.size > limit)) {
          throw new Error('The candidate image archive has an unsafe inspected entry size.');
        }
        current = {
          entry,
          content: capture ? Buffer.alloc(entry.size) : null,
          offset: 0,
          padding: tarPadding(entry.size),
        };
      }
      const remaining = current.entry.size - current.offset;
      if (remaining > 0) {
        if (buffered.length === 0) return;
        const length = Math.min(remaining, buffered.length);
        if (current.content) buffered.copy(current.content, current.offset, 0, length);
        current.offset += length;
        buffered = buffered.subarray(length);
        if (current.offset < current.entry.size) return;
      }
      if (current.padding > 0) {
        if (buffered.length < current.padding) return;
        buffered = buffered.subarray(current.padding);
      }
      processEntry(current.entry, current.content ?? Buffer.alloc(0));
      current = null;
    }
  };

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      command.once('error', rejectPromise);
      command.stdout.on('data', (chunk) => {
        try {
          buffered = Buffer.concat([buffered, chunk]);
          drain();
        } catch (error) {
          command.kill('SIGKILL');
          rejectPromise(error);
        }
      });
      command.once('close', (status) => {
        try {
          if (
            status !== 0 ||
            current ||
            !finished ||
            buffered.length < 512 ||
            buffered.some((value) => value !== 0)
          ) {
            throw new Error('The immutable candidate filesystem could not be inspected.');
          }
          resolvePromise();
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
  } finally {
    command.kill('SIGKILL');
  }
  for (const path of expected.keys()) {
    const ancestor = path.split('/');
    ancestor.pop();
    for (let index = 1; index <= ancestor.length; index += 1) {
      if (linkPaths.has(ancestor.slice(0, index).join('/'))) {
        throw new Error('The candidate image tracked source bytes could not be inspected safely.');
      }
    }
    if (!seen.has(path) || !contents.has(expected.get(path).key)) {
      throw new Error('The candidate image is missing reviewed tracked source bytes.');
    }
  }
  return contents;
}

function trackedImageSourcePaths() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) {
    throw new Error('The tracked source manifest could not be resolved.');
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((path) => {
      const parts = path.split('/');
      const basename = parts.at(-1) ?? '';
      return !(
        path.startsWith('.github/') ||
        path === '.env' ||
        path.startsWith('.env.') ||
        path === 'docker-compose.yml' ||
        basename === '.DS_Store' ||
        basename.endsWith('.log') ||
        parts.some((part) =>
          ['.smrt', '.svelte-kit', '.turbo', 'build', 'dist', 'node_modules'].includes(
            part,
          ),
        )
      );
    });
}

export async function inspectCandidateImageFilesystem(
  candidateRef,
  paths,
  expectedSha256,
) {
  const created = spawnSync(
    'docker',
    ['create', '--network', 'none', '--entrypoint', '/bin/true', candidateRef],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const containerId = created.stdout.trim();
  if (created.error || created.status !== 0 || !/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error('The immutable candidate filesystem could not be inspected.');
  }
  try {
    const targets = new Map();
    for (const path of paths) {
      const content = readFileSync(resolve(repositoryRoot, path));
      targets.set(`app/${path}`, { key: path, size: content.length });
    }
    const contents = await inspectDockerExport(containerId, targets);
    const sourceTreeSha256 = sourceFingerprintContents(contents, paths);
    if (sourceTreeSha256 !== expectedSha256) {
      throw new Error(
        'The candidate image source content does not match the reviewed Git tree.',
      );
    }

    return { sourceTreeSha256 };
  } finally {
    spawnSync('docker', ['rm', '--force', containerId], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  }
}

export function validateInstalledSmrtDependencies(actual, expected) {
  const normalize = (dependencies) =>
    Object.fromEntries(
      Object.entries(dependencies).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  if (
    JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))
  ) {
    throw new Error(
      'The candidate image installed s-m-r-t dependencies do not match the reviewed declarations.',
    );
  }
  return actual;
}

export function isolatedInvocation(binary, args, platform = process.platform) {
  if (platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return {
      backend: 'darwin-sandbox-exec-deny-remote-ip',
      binary: '/usr/bin/sandbox-exec',
      args: ['-p', darwinNetworkSandboxProfile, binary, ...args],
    };
  }
  if (platform === 'linux') {
    const unshare = ['/usr/bin/unshare', '/bin/unshare'].find(existsSync);
    if (unshare) {
      return {
        backend: 'linux-unshare-network-namespace',
        binary: unshare,
        args: ['--user', '--map-root-user', '--net', '--', binary, ...args],
      };
    }
  }
  throw new Error(
    'The parity contract requires an OS-enforced outbound-network isolation backend.',
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

function executeScenario(scenario, environment, imageRef) {
  const [binary, ...args] = scenario.invocation;
  const isolated =
    imageRef && scenario.id !== 'self-hosted-topology'
      ? candidateImageInvocation(imageRef, scenario.invocation)
      : isolatedInvocation(binary, args);
  const result = spawnSync(isolated.binary, isolated.args, {
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
    execution:
      imageRef && scenario.id !== 'self-hosted-topology'
        ? {
            kind: 'candidate-image',
            reference: imageRef,
            sandbox: 'docker-network-none-read-only-cap-drop-all',
          }
        : {
            kind: 'host',
            reason:
              'self-hosted topology requires the reviewed host-side kustomize verifier; immutable runtime images intentionally omit cluster administration tools',
            sandbox: isolated.backend,
          },
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

function inventorySnapshot(environment, imageRef) {
  const invocation = [
    'pnpm',
    '--filter',
    '@willgriffin/iolaus-site',
    'exec',
    'tsx',
    'scripts/deployed-parity-inventory.ts',
  ];
  const isolated = imageRef
    ? candidateImageInvocation(imageRef, invocation)
    : isolatedInvocation(invocation[0], invocation.slice(1));
  const result = spawnSync(isolated.binary, isolated.args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const localImageId = validateLocalImageId(
    argumentValue('--local-image-id', argv),
  );
  if (imageRef && localImageId) {
    throw new Error('--image-ref and --local-image-id are mutually exclusive.');
  }
  const candidateRef = imageRef ?? localImageId;
  // The static self-hosted topology verifier deliberately runs on the host: the
  // runtime image does not and must not contain kubectl. A candidate image report
  // is therefore never deployment-release evidence by itself.
  const releaseEligible = false;
  const startedAt = new Date().toISOString();
  const revision = gitRevision();
  const expectedLockfileSha256 = createHash('sha256')
    .update(readFileSync(resolve(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'))
    .digest('hex');
  const sourcePaths = trackedImageSourcePaths();
  const sourceTreeSha256 = sourceFingerprint(repositoryRoot, sourcePaths);
  let candidateImageProvenance = candidateRef
    ? inspectCandidateImage(
        candidateRef,
        revision,
        expectedLockfileSha256,
        Boolean(imageRef),
      )
    : null;
  const sandboxBase = resolve(
    process.env.HOME || tmpdir(),
    '.cache/iolaus-parity-contract',
  );
  mkdirSync(sandboxBase, { recursive: true, mode: 0o700 });
  const sandboxRoot = mkdtempSync(resolve(sandboxBase, 'iolaus-parity-'));
  const isolationBackend = isolatedInvocation('true', []).backend;
  let checks;
  let inventory;
  try {
    const environment = buildScenarioEnvironment(sandboxRoot);
    const reviewedInventory = inventorySnapshot(environment, null);
    if (candidateRef && candidateImageProvenance) {
      const inspectedFilesystem = await inspectCandidateImageFilesystem(
        candidateRef,
        sourcePaths,
        sourceTreeSha256,
      );
      candidateImageProvenance = {
        ...candidateImageProvenance,
        sourceTreeSha256: inspectedFilesystem.sourceTreeSha256,
      };
    }
    checks = scenarios.map((scenario) =>
      executeScenario(scenario, environment, candidateRef),
    );
    inventory = candidateRef
      ? inventorySnapshot(environment, candidateRef)
      : reviewedInventory;
    if (
      candidateRef &&
      inventory.inventorySha256 !== reviewedInventory.inventorySha256
    ) {
      throw new Error(
        'The candidate image inventory does not match the reviewed checkout inventory.',
      );
    }
    if (candidateImageProvenance) {
      validateInstalledSmrtDependencies(
        inventory.installedSmrtDependencies,
        reviewedInventory.smrtDependencies,
      );
      candidateImageProvenance = {
        ...candidateImageProvenance,
        installedSmrtDependencies: inventory.installedSmrtDependencies,
      };
    }
  } finally {
    rmSync(sandboxRoot, { force: true, recursive: true });
  }
  if (inventory.dependencyLockSha256 !== expectedLockfileSha256) {
    throw new Error(
      'The exercised dependency lock digest does not match this checkout.',
    );
  }
  if (
    JSON.stringify(inventory.installedSmrtDependencies) !==
    JSON.stringify(inventory.smrtDependencies)
  ) {
    throw new Error(
      'The exercised s-m-r-t installation does not match its released dependency declarations.',
    );
  }
  if (candidateImageProvenance) {
    checks.push({
      id: 'candidate-image-provenance',
      invocation: 'docker image inspect <candidate-image-ref>',
      observable:
        'the immutable image contains exact reviewed tracked-source bytes as raw regular TAR entries; image-executed scenarios run read-only with networking disabled, while the separately identified topology verifier remains host-executed',
      status: 'passed',
    });
  }
  const evidence = {
    schema: 'iolaus-deployed-parity-contract:v1',
    status: 'passed',
    scope: candidateRef
      ? 'candidate-image-and-host-topology-contract'
      : 'source-contract',
    releaseEligible,
    candidateImageTested: Boolean(candidateRef),
    revision,
    sourceTreeSha256,
    runtime,
    candidateImageRef: candidateRef,
    candidateImageProvenance,
    inventorySha256: inventory.inventorySha256,
    dependencyLockSha256: inventory.dependencyLockSha256,
    smrtDependencies: inventory.smrtDependencies,
    installedSmrtDependencies: inventory.installedSmrtDependencies,
    counts: inventory.counts,
    checks,
    executionProvenance: {
      candidateImageScenarioIds: checks
        .filter((check) => check.execution?.kind === 'candidate-image')
        .map((check) => check.id),
      hostOnlyScenarioIds: checks
        .filter((check) => check.execution?.kind === 'host')
        .map((check) => check.id),
      deploymentEvidenceRequiredForRelease: Boolean(candidateRef),
    },
    startedAt,
    completedAt: new Date().toISOString(),
    isolation: {
      callerEnvironmentInherited: false,
      backend: isolationBackend,
      candidateBackend: candidateRef ? 'docker-network-none' : null,
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
