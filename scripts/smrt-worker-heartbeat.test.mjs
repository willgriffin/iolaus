import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWorkerHeartbeat,
  resolveWorkerHeartbeatConfig,
  startWorkerHeartbeat,
} from './smrt-worker-heartbeat.mjs';

test('rejects a relative worker heartbeat path', () => {
  assert.throws(
    () => resolveWorkerHeartbeatConfig({ SMRT_WORKER_HEARTBEAT_FILE: 'health.json' }),
    /absolute path/,
  );
});

test('writes and verifies an opt-in worker heartbeat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iolaus-worker-heartbeat-'));
  const config = {
    file: join(directory, 'health.json'),
    intervalMs: 10,
    maxAgeMs: 1_000,
  };
  try {
    const stop = await startWorkerHeartbeat({ config, kind: 'task' });
    await assertWorkerHeartbeat({ config });
    stop();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects a stale worker heartbeat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iolaus-worker-heartbeat-'));
  const config = {
    file: join(directory, 'health.json'),
    intervalMs: 10,
    maxAgeMs: 10,
  };
  try {
    const stop = await startWorkerHeartbeat({ config, kind: 'schedule' });
    stop();
    const old = new Date(Date.now() - 1_000);
    await utimes(config.file, old, old);
    await assert.rejects(() => assertWorkerHeartbeat({ config }), /stale/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
