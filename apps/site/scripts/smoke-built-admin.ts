import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareLocalDatabaseStorage } from '@happyvertical/smrt-app-runtime';
import { resolveApplicationStateRoot } from '../../../scripts/smrt-runtime-identity.mjs';

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to allocate local smoke-test port.'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function collectOutput(process: ChildProcessWithoutNullStreams) {
  let output = '';
  process.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  process.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  return () => output.trim();
}

function waitForExit(
  process: ChildProcessWithoutNullStreams,
  getOutput: () => string,
): Promise<never> {
  return new Promise((_, reject) => {
    process.once('exit', (code, signal) => {
      reject(
        new Error(
          `Built server exited before the admin smoke check completed. Exit code: ${
            code ?? 'none'
          }; signal: ${signal ?? 'none'}.\n${getOutput()}`,
        ),
      );
    });
  });
}

async function waitForAdminResponse(port: number, getOutput: () => string) {
  const url = `http://127.0.0.1:${port}/admin/`;
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      return await fetch(url, { redirect: 'manual' });
    } catch {
      await delay(150);
    }
  }
  throw new Error(`Timed out waiting for ${url}.\n${getOutput()}`);
}

function assertAdminRedirect(response: Response, getOutput: () => string) {
  const location = response.headers.get('location') ?? '';
  if (
    response.status === 303 &&
    location.startsWith('/login?next=%2Fadmin%2F')
  ) {
    return;
  }

  throw new Error(
    `Built admin smoke check expected a 303 login redirect, received ${
      response.status
    } ${response.statusText || '(no status text)'} with Location ${
      location || '(none)'
    }.\n${getOutput()}`,
  );
}

const port = await getAvailablePort();
const sourceRoot = resolve(process.cwd(), '../..');
const appId = `iolaus-build-smoke-${process.pid}`;
const dataDirectory = mkdtempSync(
  join(realpathSync(tmpdir()), 'iolaus-build-smoke-'),
);
const stateDirectory = resolveApplicationStateRoot({
  appId,
  dataDirectory,
  sourceRoot,
});
const cleanup = () => {
  rmSync(dataDirectory, { force: true, recursive: true });
  rmSync(stateDirectory, { force: true, recursive: true });
};
process.once('exit', cleanup);
const runtimePaths = await prepareLocalDatabaseStorage({
  appId,
  dataDirectory,
  sourceRoot,
});
const runtimeEnvironment = {
  ...process.env,
  DATABASE_URL: runtimePaths.database,
  DATABASE_TYPE: 'sqlite',
  HOST: '127.0.0.1',
  ORIGIN: `http://127.0.0.1:${port}`,
  PORT: String(port),
  SMRT_APP_ID: appId,
  SMRT_ASSETS_DIR: runtimePaths.assets,
  SMRT_BACKGROUND_JOBS: 'false',
  SMRT_DATA_DIR: dataDirectory,
  SMRT_RUNTIME_PROFILE: 'local',
};
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const migration = spawn(packageManager, ['exec', 'smrt', 'db:migrate'], {
  cwd: process.cwd(),
  env: runtimeEnvironment,
});
const migrationOutput = collectOutput(migration);
const migrationExit = await new Promise<number | null>((resolveExit, reject) => {
  migration.once('error', reject);
  migration.once('exit', resolveExit);
});
if (migrationExit !== 0) {
  throw new Error(
    `Built-server smoke database migration failed with exit code ${migrationExit ?? 'none'}.\n${migrationOutput()}`,
  );
}
const server = spawn(process.execPath, ['build'], {
  cwd: process.cwd(),
  env: runtimeEnvironment,
});
const getOutput = collectOutput(server);

try {
  const response = await Promise.race([
    waitForAdminResponse(port, getOutput),
    waitForExit(server, getOutput),
  ]);
  assertAdminRedirect(response, getOutput);
} finally {
  server.kill();
  await new Promise<void>((resolveExit) => {
    if (server.exitCode !== null || server.signalCode !== null) {
      resolveExit();
      return;
    }
    server.once('exit', () => resolveExit());
  });
  cleanup();
  process.removeListener('exit', cleanup);
}
