import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
function fixture(state, database = 'postgresql://user:password@127.0.0.1:54330/iolaus_willgriffin_test') {
  const envFile = join(state, 'daily.env');
  writeFileSync(envFile, `SMRT_RUNTIME_PROFILE=self-hosted\nSMRT_APP_ID=iolaus-willgriffin\nIOLAUS_PUBLIC_URL=https://example.test\nDATABASE_URL=${database}\nRESUME_FILES_CONFIG_JSON={"type":"s3","bucket":"test","endpoint":"http://127.0.0.1:9000","accessKeyId":"test","secretAccessKey":"test"}\nIOLAUS_OIDC_SERVER_URL=https://issuer.test\nIOLAUS_OIDC_CLIENT_ID=test\nIOLAUS_OIDC_ADMIN_EMAILS=test@example.test\nIOLAUS_POSTGRES_USER=user\nIOLAUS_POSTGRES_DATABASE=iolaus_willgriffin_test\n`, { mode: 0o600 });
  return envFile;
}

test('rejects blank persisted start before ownership checks', () => {
  const state = mkdtempSync(join(tmpdir(), 'iolaus-guard-'));
  const envFile = fixture(state);
  writeFileSync(join(state, 'vite-process.json'), JSON.stringify({ pid: process.pid, start: '   ' }), { mode: 0o600 });
  assert.throws(() => execFileSync('node', ['scripts/daily-use-dev.mjs', 'status'], { cwd: root, env: { ...process.env, IOLAUS_DAILY_ENV_FILE: envFile, IOLAUS_DAILY_STATE_DIR: state }, encoding: 'utf8', stdio: 'pipe' }), /no verifiable start time/u);
});

test('rejects PostgreSQL identity query overrides before runtime commands', () => {
  const state = mkdtempSync(join(tmpdir(), 'iolaus-guard-'));
  const envFile = fixture(state, 'postgresql://user:password@127.0.0.1:54330/iolaus_willgriffin_test?host=other.invalid');
  assert.throws(() => execFileSync('node', ['scripts/daily-use-dev.mjs', 'status'], { cwd: root, env: { ...process.env, IOLAUS_DAILY_ENV_FILE: envFile, IOLAUS_DAILY_STATE_DIR: state }, encoding: 'utf8', stdio: 'pipe' }), /must not override PostgreSQL host/u);
});
