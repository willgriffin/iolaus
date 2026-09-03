import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KeyedLockTimeoutError,
  withKeyedFileLock,
} from '../../../../../scripts/smrt-keyed-lock.mjs';
import { prepareApplicationStateRoot } from '../../../../../scripts/smrt-runtime-identity.mjs';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'iolaus-runtime-test-')),
  );
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local runtime operation boundaries', () => {
  it('serializes a key across processes and fails on a bounded deadline', async () => {
    const stateRoot = temporaryRoot();
    const signal = join(stateRoot, 'held');
    const moduleUrl = pathToFileURL(
      join(process.cwd(), '../../scripts/smrt-keyed-lock.mjs'),
    ).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { writeFileSync } from 'node:fs'; import { withKeyedFileLock } from ${JSON.stringify(moduleUrl)}; await withKeyedFileLock({stateRoot:${JSON.stringify(stateRoot)},key:'shared',timeoutMs:1000}, async () => { writeFileSync(${JSON.stringify(signal)}, 'held'); await new Promise(resolve => setTimeout(resolve, 500)); });`,
      ],
      { stdio: 'ignore' },
    );
    for (let attempt = 0; attempt < 100 && !existsSync(signal); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(signal)).toBe(true);
    await expect(
      withKeyedFileLock(
        { stateRoot, key: 'shared', timeoutMs: 50, retryMs: 10 },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(KeyedLockTimeoutError);
    await new Promise<void>((resolve, reject) => {
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
      );
      child.once('error', reject);
    });
  });

  it('fails closed with recovery guidance for a stale atomic lock', async () => {
    const stateRoot = temporaryRoot();
    const key = 'stale';
    const lockRoot = join(stateRoot, 'keyed-locks');
    mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
    const path = join(
      lockRoot,
      `${createHash('sha256').update(key).digest('hex')}.lock`,
    );
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, instance: 'a'.repeat(32) })}\n`,
      { mode: 0o600 },
    );
    await expect(
      withKeyedFileLock({ stateRoot, key }, async () => 'unsafe'),
    ).rejects.toThrow(/verify no Iolaus process is running/u);
  });

  it('does not apply POSIX mode-bit custody rules to Windows state', () => {
    const root = temporaryRoot();
    const sourceRoot = join(root, 'source');
    const dataDirectory = join(root, 'data');
    const localAppData = join(root, 'state');
    mkdirSync(sourceRoot);
    mkdirSync(dataDirectory);
    mkdirSync(localAppData);
    chmodSync(localAppData, 0o777);

    expect(() =>
      prepareApplicationStateRoot({
        appId: 'iolaus-test',
        dataDirectory,
        sourceRoot,
        platformName: 'win32',
        homeDirectory: root,
        environment: { LOCALAPPDATA: localAppData },
      }),
    ).not.toThrow();
  });
});
