#!/usr/bin/env node
/**
 * iolaus.localhost CLI — thin wrapper around the reusable
 * `@happyvertical/smrt-app-cli` factory. Resources and commands are
 * discovered at runtime from `GET /api/_resources`; there is no
 * hand-maintained resource list (the old `resources.ts` is gone).
 */
import { createAppCli } from '@happyvertical/smrt-app-cli';

const cli = createAppCli({
  name: 'iolaus',
  // Preserve the existing config location (~/.config/iolaus.localhost/) and
  // env-var prefix (IOLAUS_*) so already-authenticated users keep their
  // stored token across the migration.
  configDir: 'iolaus.localhost',
  defaultServerUrl: 'http://localhost:5173',
});

await cli.run(process.argv.slice(2));
