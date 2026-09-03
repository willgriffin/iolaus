import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
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
  constructor() {
    super('The requested local operation is busy. Please try again.');
    this.name = 'KeyedLockTimeoutError';
  }
}

/**
 * Cross-process, bounded serialization for one application mutation key.
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
  let descriptor;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify({ schemaVersion: 1, pid: process.pid, instance })}\n`,
        );
      } catch (error) {
        closeSync(descriptor);
        descriptor = undefined;
        rmSync(path, { force: true });
        throw error;
      }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      let ownerPid;
      let staleIdentity;
      let staleDescriptor;
      try {
        staleDescriptor = openSync(path, 'r');
        staleIdentity = fstatSync(staleDescriptor);
        const record = JSON.parse(readFileSync(staleDescriptor, 'utf8'));
        if (
          record?.schemaVersion !== 1 ||
          !Number.isSafeInteger(record.pid) ||
          !/^[a-f0-9]{32}$/.test(record.instance)
        ) {
          throw new Error('invalid');
        }
        ownerPid = record.pid;
      } catch {
        throw new Error(
          'A local operation lock exists but cannot be verified; inspect the private state directory.',
        );
      } finally {
        if (staleDescriptor !== undefined) closeSync(staleDescriptor);
      }
      if (!processExists(ownerPid)) {
        try {
          const currentIdentity = lstatSync(path);
          if (
            staleIdentity &&
            currentIdentity.dev === staleIdentity.dev &&
            currentIdentity.ino === staleIdentity.ino
          ) {
            rmSync(path);
            continue;
          }
        } catch (removeError) {
          if (errorCode(removeError) !== 'ENOENT') throw removeError;
        }
      }
      if (Date.now() >= deadline) throw new KeyedLockTimeoutError();
      await pause(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }

  try {
    return await callback();
  } finally {
    closeSync(descriptor);
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
