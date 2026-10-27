import { loadExternalManifestSync } from '@happyvertical/smrt-core';
import { readDeploymentSchemas } from '../../../../../../scripts/smrt-deployment-schema.mjs';
import { getIolausSourceRoot } from '../runtime-paths.js';

/** Optional transitive runtime modules are not included in the app scanner's
 * model import graph. Their released public manifests remain static authority. */
export async function readApplicationDeploymentSchemas() {
  const schemas = await readDeploymentSchemas(getIolausSourceRoot());
  for (const suffix of ['prompts', 'secrets', 'playbooks', 'reports']) {
    const manifest = loadExternalManifestSync(`@happyvertical/smrt-${suffix}`, {
      warn: false,
    });
    if (!manifest)
      throw new Error(`Missing released static schema manifest: ${suffix}.`);
    for (const object of Object.values(manifest.objects)) {
      if (object.schema) schemas.push(object.schema);
    }
  }
  const byTable = new Map(schemas.map((schema) => [schema.tableName, schema]));
  return [...byTable.values()];
}
