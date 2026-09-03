// MUST stay before the @happyvertical/smrt-* model imports below: hydrates
// dependency manifests so their classes register with complete schemas when
// running under tsx (no build scanner). See manifest-preload.ts for rationale.
import './manifest-preload.js';
import {
  ObjectRegistry,
  type SmrtClassOptions,
  SmrtCollection,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import '@happyvertical/smrt-facts';
import '@happyvertical/smrt-jobs';
import '@happyvertical/smrt-places';
import '@happyvertical/smrt-profiles';
import '@happyvertical/smrt-tags';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import * as siteObjects from '../objects/index.js';
import { listExposureCandidates } from './api-exposure.js';
import { getDbConfig, getSmrtOptions } from './db.js';

const objectOverrides: Record<string, Partial<SmrtClassOptions>> = {};
const localPackageName = '@willgriffin/iolaus-site';

// Register every class exported from `$lib/objects` (the index is class-only).
// Deriving the list keeps newly added models from being silently left out of
// registration and collection setup.
for (const [name, objectConstructor] of Object.entries(siteObjects)) {
  ObjectRegistry.register(objectConstructor, {
    name,
    packageName: localPackageName,
  });
}

// Register an explicit collection for every class exposed on REST or MCP,
// including dependency models such as the smrt-facts records. Keyed by the
// registry's own class entry so the collection binds to the exact registered
// constructor rather than a simple-name lookup.
for (const resource of listExposureCandidates()) {
  const registered = ObjectRegistry.getClass(resource.className);
  if (!registered || typeof registered.collectionConstructor === 'function') {
    continue;
  }
  const itemClass = registered.constructor;
  class DefaultCollection extends SmrtCollection<SmrtObject> {
    static _itemClass = itemClass;
  }
  ObjectRegistry.registerCollection(resource.className, DefaultCollection);
}

export function getSmrtConfig(className: string): SmrtClassOptions {
  const defaults = getSmrtOptions();
  const override = objectOverrides[className];
  return override ? { ...defaults, ...override } : defaults;
}

export function getRequestScopedSmrtOptions(): SmrtClassOptions {
  const config = getSmrtOptions();
  return {
    ...config,
    db: getRequestScopedDatabase() ?? config.db ?? getDbConfig(),
  };
}

export async function getCollection<T extends SmrtObject = SmrtObject>(
  className: string,
  options: Pick<SmrtClassOptions, 'db'> = {},
) {
  const config = getSmrtConfig(className);
  const override = objectOverrides[className];
  const requestScopedDb = override?.db ? undefined : getRequestScopedDatabase();

  return await ObjectRegistry.getCollection<T>(className, {
    ...config,
    db: options.db ?? requestScopedDb ?? config.db ?? getDbConfig(),
  });
}
