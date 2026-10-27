import {
  loadExternalManifestSync,
  ObjectRegistry,
} from '@happyvertical/smrt-core';

/** Chat exposes an authorized facade, not its private model constructors.
 * Use the registry's public metadata-only registration for its schema closure.
 * Importing the facade eagerly also evaluates unrelated message APIs/classes.
 */
export function registerDeploymentSchemaMetadata(): void {
  const packageName = '@happyvertical/smrt-chat';
  const manifest = loadExternalManifestSync(packageName, { warn: false });
  if (!manifest) throw new Error('Released chat schema manifest is missing.');
  for (const [name, definition] of Object.entries(manifest.objects)) {
    if (
      definition.packageName !== packageName ||
      !definition.schema ||
      ObjectRegistry.getClassByQualifiedName(name)
    )
      continue;
    ObjectRegistry.registerFromManifest(name, definition, packageName);
  }
}

registerDeploymentSchemaMetadata();
