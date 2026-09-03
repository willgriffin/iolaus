/**
 * Hydrate the SMRT registry with dependency packages' shipped manifests BEFORE
 * their model classes are imported and registered.
 *
 * WHY THIS EXISTS
 * ---------------
 * Standalone scripts (db:migrate, db:status, mcp:generate) run under `tsx`,
 * which does NOT run the SMRT build-time scanner that the Vite plugin runs.
 * Without the scanner, dependency model classes (e.g. @happyvertical/smrt-users
 * `Role`, `User`, `Tenant`) register via runtime introspection, which cannot
 * see plain instance-field initializers (`name = ''`). Their generated table
 * schemas are then truncated to base columns only, so `db:migrate` creates
 * e.g. a `roles` table without the `name`/`description`/`is_system` columns that
 * `seedSystemRoles()` writes — failing with `column "name" ... does not exist`.
 *
 * Each package ships a `dist/manifest.json` (exposed via its `./manifest.json`
 * export) carrying the full field/DDL definitions. Loading those into the
 * registry's manifest cache *before* the classes register makes registration
 * pick up the complete schema. `loadExternalManifestSync` is cached/idempotent,
 * and the Vite/production path already loads these, so this is a safe no-op there.
 *
 * IMPORTANT: import this module as the FIRST import in any entry point that
 * registers dependency models (see `$lib/server/smrt` and `scripts/db-common`),
 * so its side effect runs before those packages are evaluated.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadExternalManifestSync,
  loadManifestFromPathSync,
} from '@happyvertical/smrt-core';

const DEPENDENCY_PACKAGES = [
  '@happyvertical/smrt-agents',
  '@happyvertical/smrt-users',
  '@happyvertical/smrt-profiles',
  '@happyvertical/smrt-places',
  '@happyvertical/smrt-tags',
  '@happyvertical/smrt-facts',
  '@happyvertical/smrt-jobs',
] as const;

for (const packageName of DEPENDENCY_PACKAGES) {
  loadExternalManifestSync(packageName, { warn: false });
}

const LOCAL_MANIFEST_CANDIDATES = [
  resolve(process.cwd(), '.smrt/manifest.json'),
  resolve(process.cwd(), 'apps/site/.smrt/manifest.json'),
] as const;

for (const manifestPath of LOCAL_MANIFEST_CANDIDATES) {
  if (existsSync(manifestPath)) {
    loadManifestFromPathSync(manifestPath);
    break;
  }
}
