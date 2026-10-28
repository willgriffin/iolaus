import { createRequire } from 'node:module';
import {
  loadExternalManifestSync,
  loadManifestFromPathSync,
  ObjectRegistry,
} from '@happyvertical/smrt-core';

const CHAT_PACKAGE = '@happyvertical/smrt-chat';

/** The released chat manifest, found from this module rather than the cwd.
 *
 * `loadExternalManifestSync` resolves packages from `process.cwd()`. The
 * deployed image runs every entrypoint from the repository root (`cd /app`),
 * where `@happyvertical/smrt-chat` is not installed: it is a dependency of
 * `apps/site` only. Resolving from this module's own location works from any
 * working directory, so migrations and startup do not depend on the caller's
 * cwd. Returns null only when the package genuinely ships no manifest.
 */
function loadReleasedChatManifest() {
  const cached = loadExternalManifestSync(CHAT_PACKAGE, { warn: false });
  if (cached) return cached;
  let manifestPath: string;
  try {
    manifestPath = createRequire(import.meta.url).resolve(
      `${CHAT_PACKAGE}/manifest.json`,
    );
  } catch {
    return null;
  }
  return loadManifestFromPathSync(manifestPath);
}

/** Chat exposes an authorized facade, not its private model constructors.
 * Use the registry's public metadata-only registration for its schema closure.
 * Importing the facade eagerly also evaluates unrelated message APIs/classes.
 */
export function registerDeploymentSchemaMetadata(): void {
  const manifest = loadReleasedChatManifest();
  if (!manifest) throw new Error('Released chat schema manifest is missing.');
  for (const [name, definition] of Object.entries(manifest.objects)) {
    if (
      definition.packageName !== CHAT_PACKAGE ||
      !definition.schema ||
      ObjectRegistry.getClassByQualifiedName(name)
    )
      continue;
    ObjectRegistry.registerFromManifest(name, definition, CHAT_PACKAGE);
  }
}

registerDeploymentSchemaMetadata();
