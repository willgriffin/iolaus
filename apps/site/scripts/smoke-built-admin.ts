import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

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
const server = spawn(process.execPath, ['build'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    IOLAUS_BUILD_SMOKE: 'true',
  },
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
}
