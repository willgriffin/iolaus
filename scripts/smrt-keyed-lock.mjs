import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** @param {number} pid */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES';
  }
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;
}

/** @param {number} milliseconds */
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class KeyedLockTimeoutError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(
      `The requested local operation is busy. If it persists after Iolaus stops, inspect ${path}.`,
    );
    this.name = 'KeyedLockTimeoutError';
  }
}

/**
 * Cross-process, bounded serialization for one application mutation key.
 * The complete owner record is hard-linked into place, so contenders can
 * never observe the record between creation and initialization.
 * @template T
 * @param {{stateRoot: string, key: string, timeoutMs?: number, retryMs?: number}} options
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withKeyedFileLock(options, callback) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retryMs = options.retryMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const lockRoot = join(options.stateRoot, 'keyed-locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const digest = createHash('sha256').update(options.key).digest('hex');
  const path = join(lockRoot, `${digest}.lock`);
  const instance = randomBytes(16).toString('hex');
  const temporary = join(lockRoot, `.${digest}.${process.pid}.${instance}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, instance })}\n`,
    );
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }

  let acquired = false;
  try {
    while (!acquired) {
      try {
        linkSync(temporary, path);
        acquired = true;
        rmSync(temporary, { force: true });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        let record;
        try {
          record = JSON.parse(readFileSync(path, 'utf8'));
          if (
            record?.schemaVersion !== 1 ||
            !Number.isSafeInteger(record.pid) ||
            !/^[a-f0-9]{32}$/.test(record.instance)
          ) {
            throw new Error('invalid');
          }
        } catch {
          throw new Error(
            `A local operation lock at ${path} cannot be verified. Stop Iolaus before inspecting or removing it.`,
          );
        }
        if (!processExists(record.pid)) {
          throw new Error(
            `A stale local operation lock was found at ${path}. Stop Iolaus, verify no Iolaus process is running, then remove that file and retry.`,
          );
        }
        if (Date.now() >= deadline) throw new KeyedLockTimeoutError(path);
        await pause(Math.min(retryMs, Math.max(1, deadline - Date.now())));
      }
    }

    return await callback();
  } finally {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    if (acquired) {
      try {
        const current = JSON.parse(readFileSync(path, 'utf8'));
        if (current.pid === process.pid && current.instance === instance) {
          rmSync(path, { force: true });
        }
      } catch {
        // A missing or externally repaired lock is not ours to remove.
      }
    }
  }
}
