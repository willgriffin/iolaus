import { createRequire } from 'node:module';
import { loadManifestFromPathSync } from '@happyvertical/smrt-core';
import { readDeploymentSchemas } from '../../../../../../scripts/smrt-deployment-schema.mjs';
import { getIolausSourceRoot } from '../runtime-paths.js';

const requireSite = createRequire(import.meta.url);

/** These declared schema dependencies may be absent from the model import
 * graph. Resolve their public manifests from this module, never process.cwd(). */
export async function readApplicationDeploymentSchemas() {
  const schemas = await readDeploymentSchemas(getIolausSourceRoot());
  for (const suffix of ['prompts', 'secrets', 'playbooks', 'reports']) {
    const packageName = `@happyvertical/smrt-${suffix}`;
    let manifestPath: string;
    try {
      manifestPath = requireSite.resolve(`${packageName}/manifest.json`);
    } catch {
      throw new Error(`Missing released static schema manifest: ${suffix}.`);
    }
    const manifest = loadManifestFromPathSync(manifestPath);
    if (!manifest || manifest.packageName !== packageName)
      throw new Error(`Invalid released static schema manifest: ${suffix}.`);
    for (const object of Object.values(manifest.objects)) {
      if (object.schema) schemas.push(object.schema);
    }
  }
  const byTable = new Map(schemas.map((schema) => [schema.tableName, schema]));
  return [...byTable.values()];
}
