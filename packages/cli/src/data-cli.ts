#!/usr/bin/env node
/**
 * Iolaus CLI — thin wrapper around the reusable
 * `@happyvertical/smrt-app-cli` factory. Resources and commands are
 * discovered at runtime from `GET /api/_resources`; there is no
 * hand-maintained resource list (the old `resources.ts` is gone).
 */
import { createAppCli } from '@happyvertical/smrt-app-cli';
import { getCliAppId, getCliConfigDirectory } from './app-config.js';

const appId = getCliAppId();

const cli = createAppCli({
  configDir: getCliConfigDirectory(),
  defaultServerUrl: 'http://localhost:5173',
  // The documented IOLAUS_* variables are the stable credential interface.
  // SMRT_APP_ID changes identity and storage, never the token env namespace.
  envPrefix: 'IOLAUS',
  name: appId,
});

await cli.run(process.argv.slice(2));
