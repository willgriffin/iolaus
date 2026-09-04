import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_AGE_MS = 45_000;

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

/**
 * Resolve an opt-in, process-local heartbeat. The emptyDir that contains it is
 * deliberately not an application-data volume: it proves this specific worker
 * event loop is still making progress without persisting any private state.
 */
export function resolveWorkerHeartbeatConfig(environment = process.env) {
  const file = environment.SMRT_WORKER_HEARTBEAT_FILE;
  if (!file) return null;
  if (!isAbsolute(file)) {
    throw new Error('SMRT_WORKER_HEARTBEAT_FILE must be an absolute path.');
  }
  const maxAgeMs = positiveInteger(
    environment.SMRT_WORKER_HEARTBEAT_MAX_AGE_MS,
    DEFAULT_MAX_AGE_MS,
    'SMRT_WORKER_HEARTBEAT_MAX_AGE_MS',
  );
  const intervalMs = positiveInteger(
    environment.SMRT_WORKER_HEARTBEAT_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    'SMRT_WORKER_HEARTBEAT_INTERVAL_MS',
  );
  if (intervalMs >= maxAgeMs) {
    throw new Error(
      'SMRT_WORKER_HEARTBEAT_INTERVAL_MS must be less than SMRT_WORKER_HEARTBEAT_MAX_AGE_MS.',
    );
  }
  return { file, intervalMs, maxAgeMs };
}

async function writeHeartbeat(file, kind) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, status: 'ready', kind, at: new Date().toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await rename(temporary, file);
}

export async function startWorkerHeartbeat({
  config = resolveWorkerHeartbeatConfig(),
  kind,
  onError = (error) => console.error('Worker heartbeat update failed:', error),
} = {}) {
  if (!config) return () => {};
  if (typeof kind !== 'string' || !kind) {
    throw new Error('A worker heartbeat requires a worker kind.');
  }

  let stopped = false;
  let writing = false;
  const tick = async () => {
    if (stopped || writing) return;
    writing = true;
    try {
      await writeHeartbeat(config.file, kind);
    } catch (error) {
      onError(error);
    } finally {
      writing = false;
    }
  };

  await tick();
  const interval = setInterval(() => void tick(), config.intervalMs);
  interval.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export async function assertWorkerHeartbeat({
  config = resolveWorkerHeartbeatConfig(),
  now = Date.now(),
} = {}) {
  if (!config) {
    throw new Error('SMRT_WORKER_HEARTBEAT_FILE must be configured for this probe.');
  }
  const metadata = await stat(config.file);
  if (!metadata.isFile() || now - metadata.mtimeMs > config.maxAgeMs) {
    throw new Error('Worker heartbeat is stale.');
  }
}

if (process.argv.includes('--check')) {
  try {
    await assertWorkerHeartbeat();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Worker heartbeat check failed.');
    process.exitCode = 1;
  }
}
