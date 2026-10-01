import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const source = '/Users/will/Work/willgriffin/local-ops/iolaus/daily.env';

test('rejects blank persisted start before ownership checks', () => {
  const state = mkdtempSync(join(tmpdir(), 'iolaus-guard-'));
  writeFileSync(join(state, 'vite-process.json'), JSON.stringify({ pid: process.pid, start: '   ' }));
  assert.throws(() => execFileSync('node', ['scripts/daily-use-dev.mjs', 'status'], { cwd: root, env: { ...process.env, IOLAUS_DAILY_ENV_FILE: source, IOLAUS_DAILY_STATE_DIR: state }, encoding: 'utf8', stdio: 'pipe' }), /no verifiable start time/u);
});
