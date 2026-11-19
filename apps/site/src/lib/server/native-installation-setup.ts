import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { initializeLocalApplicationRuntime } from '@happyvertical/smrt-app-runtime';
import { loadConfig } from '@happyvertical/smrt-config';
import {
  loadManifestFromPathSync,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import { registerBuildSchema } from '@happyvertical/smrt-core/migrations';
import { prepareApplicationStateRoot } from '../../../../../scripts/smrt-runtime-identity.mjs';
import { acquireWriterLease } from '../../../../../scripts/smrt-writer-lease.mjs';

export interface NativeInstallationOptions {
  appId: string;
  dataDirectory: string;
  sourceRoot: string;
  bindHost: string;
  operationInstance?: string;
  manifestPath?: string;
}

async function packagedFile(sourceRoot: string, path: string): Promise<string> {
  const canonical = await realpath(path);
  const within = relative(sourceRoot, canonical);
  if (
    isAbsolute(within) ||
    within === '..' ||
    within.startsWith('../') ||
    within.startsWith('..\\')
  )
    throw new Error(
      'Native setup inputs must be inside the packaged application.',
    );
  return canonical;
}

/** Explicit native installation/upgrade phase, completed before serving HTTP. */
export async function prepareNativeInstallation(
  options: NativeInstallationOptions,
): Promise<{ status: 'ready'; firstRun: boolean }> {
  const sourceRoot = await realpath(options.sourceRoot);
  const manifestPath = await packagedFile(
    sourceRoot,
    options.manifestPath ?? join(sourceRoot, 'apps/site/manifest.json'),
  );
  const configPath = await packagedFile(
    sourceRoot,
    join(sourceRoot, 'apps/site/smrt.config.js'),
  );
  const stateRoot = prepareApplicationStateRoot({
    appId: options.appId,
    dataDirectory: options.dataDirectory,
    sourceRoot,
  });
  const lease = acquireWriterLease(stateRoot, {
    operationInstance: options.operationInstance,
  });
  let runtime:
    | Awaited<ReturnType<typeof initializeLocalApplicationRuntime>>['runtime']
    | undefined;
  let firstRun = false;
  try {
    await loadConfig({
      cache: false,
      configPath,
    });
    const manifest = loadManifestFromPathSync(manifestPath);
    if (!manifest || !Object.keys(manifest.objects).length)
      throw new Error('Packaged native application schema is unavailable.');
    // Register before the framework phase, including upgrades: otherwise its
    // removed-package guard would see only the framework's built-in models.
    for (const [name, definition] of Object.entries(manifest.objects)) {
      if (definition.schema && !ObjectRegistry.getClassByQualifiedName(name))
        ObjectRegistry.registerFromManifest(
          name,
          definition,
          definition.packageName ?? manifest.packageName,
        );
    }
    registerBuildSchema(manifest);
    const initialized = await initializeLocalApplicationRuntime({
      appId: options.appId,
      dataDirectory: options.dataDirectory,
      sourceRoot,
      bindHost: options.bindHost,
      createSchema: true,
      backgroundJobs: false,
      paidCapabilities: false,
      prepareDatabase: async (db, context) => {
        if (db !== context.db || context.profile !== 'local')
          throw new Error(
            'Native setup requires the supplied local database executor.',
          );
        firstRun = context.firstRun;
        await context.migrateSchemas();
        const { prepareLocalApplicationSchema } = await import(
          './local-application-schema.js'
        );
        await prepareLocalApplicationSchema(db);
      },
    });
    runtime = initialized.runtime;
    return { status: 'ready', firstRun };
  } finally {
    try {
      await runtime?.db.close?.();
    } finally {
      lease.release();
    }
  }
}
