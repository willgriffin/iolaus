import { ObjectRegistry } from '@happyvertical/smrt-core';
// Side-effect imports: register every app-owned @smrt() model class, plus the
// upstream fact classes the app serves, so the registry walk below sees them
// on a cold process.
import '@happyvertical/smrt-facts';
import '../objects/index.js';

/**
 * Decorator-driven surface exposure. The `api` / `mcp` includes on each
 * `@smrt()` class are the single source of truth for what `/api/[resource]`
 * and the server MCP bridge expose; the CLI (`/api/_resources`) already
 * derives from the same config, so anything reachable on one surface is
 * reachable on the others unless its decorator opts out.
 */

export const standardApiActions = [
  'list',
  'get',
  'create',
  'update',
  'delete',
] as const;

export type ApiAction = (typeof standardApiActions)[number];

export interface ExposedResource {
  /** Standard actions the `api` config includes; empty means not on REST. */
  apiActions: ReadonlySet<ApiAction>;
  className: string;
  /** Standard actions the `mcp` config includes; empty means not on MCP. */
  mcpActions: ReadonlySet<ApiAction>;
  /** Canonical REST slug: the registry collection, identical to the CLI. */
  slug: string;
  /** Snake_case table name, accepted as an alternate slug spelling. */
  tableName: string;
}

/**
 * Packages whose registered classes may be exposed. Anything else that lands
 * in the registry (users, tenancy, jobs, prompts, ...) stays off every
 * surface regardless of its own decorator config.
 */
const exposablePackages = new Set([
  '@willgriffin/iolaus-site',
  '@happyvertical/smrt-facts',
]);

/**
 * Legacy REST slugs that no derived spelling covers. Empty today: every key
 * of the former hand-maintained map is either the canonical collection slug
 * or the class's table name. Kept so an irregular rename can stay reachable.
 */
const legacySlugAliases: Record<string, string> = {};

type SurfaceConfig =
  | boolean
  | { exclude?: readonly string[]; include?: readonly string[] }
  | undefined;

/**
 * Mirrors `resolveStandardCrudActions()` in the smrt-core SvelteKit generator
 * (which the CLI discovery handler uses) and the include/exclude filter in
 * `MCPGenerator.generateTools()`: `false` disables, absent or `true` means
 * every standard action, an explicit `include` (even empty) is the whole set,
 * and `exclude` removes from it.
 */
function resolveStandardActions(config: SurfaceConfig): Set<ApiAction> {
  if (config === false) return new Set();
  if (config === undefined || config === true || typeof config !== 'object') {
    return new Set(standardApiActions);
  }
  const included = Array.isArray(config.include)
    ? standardApiActions.filter((action) => config.include?.includes(action))
    : [...standardApiActions];
  const excluded = Array.isArray(config.exclude) ? config.exclude : [];
  return new Set(included.filter((action) => !excluded.includes(action)));
}

/** Same rule the registry applies when it assigns `registered.collection`. */
export function defaultCollectionSlug(className: string): string {
  const lower = className.toLowerCase();
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  if (lower.endsWith('s') || lower.endsWith('x') || lower.endsWith('z')) {
    return `${lower}es`;
  }
  if (lower.endsWith('ch') || lower.endsWith('sh')) return `${lower}es`;
  return `${lower}s`;
}

/** Fallback for a class without an explicit `tableName` (none today). */
function classnameToTablename(className: string): string {
  return defaultCollectionSlug(
    className.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
  );
}

const collectionBaseNames = new Set(['SmrtCollection', 'SmrtJunction']);

function extendsCollection(ctor: unknown): boolean {
  let current = ctor as { name?: string } | null;
  for (let depth = 0; depth < 32 && current; depth += 1) {
    if (current.name && collectionBaseNames.has(current.name)) return true;
    const next = Object.getPrototypeOf(current) as typeof current;
    if (!next || next === current) break;
    current = next;
  }
  return false;
}

let cachedResources: ExposedResource[] | null = null;

function walkRegistry(): ExposedResource[] {
  const byClass = new Map<string, ExposedResource>();
  const allRegistered = [...ObjectRegistry.getAllClasses().values()];
  // The registry's coexist-qualified collision policy lets two packages
  // register the same simple name, but collection registration and the MCP
  // generator both resolve by simple name. Index every registration, not just
  // the exposable packages, so a foreign same-named class fails closed
  // instead of being bound by insertion order.
  const registrationsByName = new Map<string, Map<unknown, Set<string>>>();
  for (const registered of allRegistered) {
    if (!registered.name) continue;
    const byConstructor = registrationsByName.get(registered.name) ?? new Map();
    const packages = byConstructor.get(registered.constructor) ?? new Set();
    packages.add(registered.packageName ?? '(unknown package)');
    byConstructor.set(registered.constructor, packages);
    registrationsByName.set(registered.name, byConstructor);
  }
  for (const registered of allRegistered) {
    const className = registered.name;
    if (!className || byClass.has(className)) continue;
    if (!exposablePackages.has(registered.packageName ?? '')) continue;
    const byConstructor = registrationsByName.get(className);
    if (byConstructor && byConstructor.size > 1) {
      const packages = [...byConstructor.values()]
        .flatMap((set) => [...set])
        .sort()
        .join(', ');
      throw new Error(
        `Ambiguous exposed class ${className}: distinct classes registered ` +
          `under that name by ${packages}`,
      );
    }
    // Same collection-class test as the CLI discovery handler.
    if (
      collectionBaseNames.has(registered.extends ?? '') ||
      registered.extendsTypeArg ||
      extendsCollection(registered.constructor)
    ) {
      continue;
    }
    const config = (registered.config ?? {}) as {
      api?: SurfaceConfig;
      mcp?: SurfaceConfig;
      tableName?: string;
    };
    const tableName =
      typeof config.tableName === 'string' && config.tableName
        ? config.tableName
        : classnameToTablename(className);
    byClass.set(className, {
      apiActions: resolveStandardActions(config.api),
      className,
      mcpActions: resolveStandardActions(config.mcp),
      slug: registered.collection ?? defaultCollectionSlug(className),
      tableName,
    });
  }
  return [...byClass.values()].sort((left, right) =>
    left.className.localeCompare(right.className),
  );
}

/** Every app-owned model class with its resolved per-surface action sets. */
export function listExposureCandidates(): readonly ExposedResource[] {
  cachedResources ??= walkRegistry();
  return cachedResources;
}

/** Classes whose decorator exposes at least one action on REST. */
export function listApiExposedResources(): readonly ExposedResource[] {
  return listExposureCandidates().filter(
    (resource) => resource.apiActions.size > 0,
  );
}

/** Classes whose decorator exposes at least one action on the MCP bridge. */
export function listMcpExposedResources(): readonly ExposedResource[] {
  return listExposureCandidates().filter(
    (resource) => resource.mcpActions.size > 0,
  );
}

/** Every slug spelling that resolves to a REST-exposed class. */
export function apiResourceSlugs(resource: ExposedResource): string[] {
  const spellings = new Set<string>([
    resource.slug,
    resource.tableName,
    resource.tableName.replaceAll('_', ''),
  ]);
  for (const [alias, className] of Object.entries(legacySlugAliases)) {
    if (className === resource.className) spellings.add(alias);
  }
  return [...spellings].map((slug) => slug.toLowerCase());
}

let cachedSlugIndex: Map<string, ExposedResource> | null = null;

function slugIndex(): Map<string, ExposedResource> {
  if (cachedSlugIndex) return cachedSlugIndex;
  const index = new Map<string, ExposedResource>();
  for (const resource of listApiExposedResources()) {
    for (const slug of apiResourceSlugs(resource)) {
      const existing = index.get(slug);
      if (existing && existing.className !== resource.className) {
        throw new Error(
          `REST resource slug collision: "${slug}" maps to both ${existing.className} and ${resource.className}.`,
        );
      }
      index.set(slug, resource);
    }
  }
  cachedSlugIndex = index;
  return index;
}

/**
 * Resolve a REST resource segment to its class and exposed actions. Accepts
 * the canonical collection slug (`resumeprofiles`, shared with the CLI), the
 * snake_case table name (`resume_profiles`), and the concatenated legacy
 * spelling (`companyresearches`). Returns `undefined` for anything the
 * decorator does not expose on REST.
 */
export function resolveApiResource(
  resource: string,
): { actions: ReadonlySet<ApiAction>; className: string } | undefined {
  const match = slugIndex().get(resource.trim().toLowerCase());
  return match
    ? { actions: match.apiActions, className: match.className }
    : undefined;
}

export function mcpToolPrefix(className: string): string {
  return `${className.toLowerCase()}_`;
}

/** The MCP-exposed class whose generated tool prefix the tool name carries. */
export function resolveMcpToolClass(
  toolName: string,
): { actions: ReadonlySet<ApiAction>; className: string } | undefined {
  const match = listMcpExposedResources().find((resource) =>
    toolName.startsWith(mcpToolPrefix(resource.className)),
  );
  return match
    ? { actions: match.mcpActions, className: match.className }
    : undefined;
}
