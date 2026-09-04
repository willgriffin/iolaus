import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opportunityDataSurfaceToolNames } from '../src/lib/opportunity-bulk-workflows.js';
import {
  jobSearchWebMcpToolDefinitions,
} from '../src/lib/webmcp.js';
import {
  listApiExposedResources,
  type ApiAction,
} from '../src/lib/server/api-exposure.js';
import {
  isReadOnlyMcpTool,
  isSourceReadMcpTool,
  listMcpTools,
} from '../src/lib/server/mcp-tools.js';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(siteRoot, '../..');
const snapshotPath = resolve(
  siteRoot,
  'scripts/deployed-parity-inventory.snapshot.json',
);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortedActions(actions: ReadonlySet<ApiAction>): ApiAction[] {
  return [...actions].sort((left, right) => left.localeCompare(right));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function releasedSmrtDependencies(): Record<string, string> {
  const dependencies = new Map<string, string>();
  for (const path of [
    resolve(repositoryRoot, 'package.json'),
    resolve(siteRoot, 'package.json'),
  ]) {
    const manifest = readJson(path);
    for (const group of ['dependencies', 'devDependencies']) {
      const entries = manifest[group];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        continue;
      }
      for (const [name, version] of Object.entries(entries)) {
        if (!name.startsWith('@happyvertical/smrt')) continue;
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
          throw new Error(`${name} must be pinned to a released semantic version.`);
        }
        const previous = dependencies.get(name);
        if (previous && previous !== version) {
          throw new Error(`${name} resolves to conflicting released versions.`);
        }
        dependencies.set(name, version);
      }
    }
  }
  return Object.fromEntries(
    [...dependencies.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export async function buildDeployedParityInventory() {
  const rest = listApiExposedResources().map((resource) => ({
    actions: sortedActions(resource.apiActions),
    className: resource.className,
    collection: resource.slug,
    tableName: resource.tableName,
  }));
  const mcp = (await listMcpTools({ authenticated: true }))
    .map((tool) => ({
      name: tool.name,
      readOnly:
        isReadOnlyMcpTool(tool.name) || isSourceReadMcpTool(tool.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const opportunity = rest.find(
    (resource) => resource.className === 'Opportunity',
  );
  if (!opportunity) {
    throw new Error('The generated Opportunity REST surface is missing.');
  }
  const generatedOpportunityReads = ['get', 'list']
    .filter((action) => opportunity.actions.includes(action as ApiAction))
    .map((action) => ({
      effect: 'read' as const,
      idempotent: true,
      name: `opportunity_${action}`,
      openWorld: false,
      readOnly: true,
    }));
  const webmcp = [
    ...generatedOpportunityReads,
    ...jobSearchWebMcpToolDefinitions,
  ]
    .map((definition) => ({
      effect: 'effect' in definition ? definition.effect : null,
      idempotent:
        'idempotent' in definition ? definition.idempotent : null,
      name: definition.name,
      openWorld: 'openWorld' in definition ? definition.openWorld : null,
      readOnly: 'readOnly' in definition ? definition.readOnly : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const forbiddenRestClasses = new Set([
    'CandidateAnswer',
    'CandidateProfile',
    'CandidateProfileLink',
  ]);
  const exposedPrivateClass = rest.find((resource) =>
    forbiddenRestClasses.has(resource.className),
  );
  if (exposedPrivateClass) {
    throw new Error(
      `Private class ${exposedPrivateClass.className} must remain off generated REST.`,
    );
  }
  const unsafeWebMcpTool = webmcp.find(
    (tool) =>
      /(?:^|[_-])(?:approve|submit)(?:$|[_-])/u.test(tool.name) ||
      (tool.effect !== 'read' && tool.effect !== 'write') ||
      typeof tool.idempotent !== 'boolean' ||
      typeof tool.openWorld !== 'boolean' ||
      typeof tool.readOnly !== 'boolean' ||
      (tool.effect === 'read') !== tool.readOnly,
  );
  if (unsafeWebMcpTool) {
    throw new Error(
      `WebMCP tool ${unsafeWebMcpTool.name} violates the deployed effect or approval boundary.`,
    );
  }
  const inventory = {
    schema: 'iolaus-deployed-parity-inventory:v1',
    dependencies: {
      lockfileSha256: digest(
        readFileSync(resolve(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'),
      ),
      smrt: releasedSmrtDependencies(),
    },
    surfaces: {
      dataSurface: [...opportunityDataSurfaceToolNames].sort((left, right) =>
        left.localeCompare(right),
      ),
      mcp,
      rest,
      webmcp,
    },
  };
  return {
    ...inventory,
    inventorySha256: digest(`${JSON.stringify(inventory)}\n`),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = await buildDeployedParityInventory();
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (process.argv.includes('--update')) {
    writeFileSync(snapshotPath, serialized, { encoding: 'utf8', mode: 0o644 });
  } else {
    const expected = readFileSync(snapshotPath, 'utf8');
    if (serialized !== expected) {
      const expectedInventory = JSON.parse(expected) as {
        inventorySha256?: unknown;
      };
      throw new Error(
        `Deployed parity inventory drifted (expected ${String(expectedInventory.inventorySha256)}, received ${inventory.inventorySha256}). Review the complete surface before running --update.`,
      );
    }
  }
  console.log(
    JSON.stringify({
      schema: 'iolaus-deployed-parity-inventory-check:v1',
      status: process.argv.includes('--update') ? 'updated' : 'passed',
      inventorySha256: inventory.inventorySha256,
      dependencyLockSha256: inventory.dependencies.lockfileSha256,
      smrtDependencies: inventory.dependencies.smrt,
      counts: {
        dataSurface: inventory.surfaces.dataSurface.length,
        mcp: inventory.surfaces.mcp.length,
        rest: inventory.surfaces.rest.length,
        webmcp: inventory.surfaces.webmcp.length,
      },
      secretValuesIncluded: false,
    }),
  );
}
