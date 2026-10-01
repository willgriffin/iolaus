import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const script = resolve(root, process.env.IOLAUS_DAILY_TEST_SCRIPT || 'scripts/daily-use-dev.mjs');
const defaultDatabase = 'postgresql://user:password@127.0.0.1:54330/iolaus_willgriffin_test';

function fixture(t, overrides = {}) {
  const state = mkdtempSync(join(tmpdir(), 'iolaus-guard-synthetic-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const values = {
    SMRT_RUNTIME_PROFILE: 'self-hosted',
    SMRT_APP_ID: 'iolaus-willgriffin',
    IOLAUS_PUBLIC_URL: 'https://example.test',
    DATABASE_URL: defaultDatabase,
    RESUME_FILES_CONFIG_JSON: JSON.stringify({ type: 's3', bucket: 'test', endpoint: 'http://127.0.0.1:9000', accessKeyId: 'test', secretAccessKey: 'test' }),
    IOLAUS_OIDC_SERVER_URL: 'https://issuer.test',
    IOLAUS_OIDC_CLIENT_ID: 'test',
    IOLAUS_OIDC_ADMIN_EMAILS: 'test@example.test',
    IOLAUS_POSTGRES_USER: 'user',
    IOLAUS_POSTGRES_DATABASE: 'iolaus_willgriffin_test',
    IOLAUS_DAILY_STATE_DIR: state,
    IOLAUS_DAILY_BACKUP_DIR: join(state, 'backups'),
    PORT: '47292',
    ...overrides,
  };
  const envFile = join(state, 'daily.env');
  writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  const bin = join(state, 'bin');
  mkdirSync(bin);
  // External commands are synthetic sentinels, so these tests cannot touch Docker or live processes.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf called > '${join(state, 'docker-called')}'\nexit 42\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "synthetic-start vite\\n"\n', { mode: 0o700 });
  const env = { PATH: bin, IOLAUS_DAILY_ENV_FILE: envFile };
  const update = (overrides) => {
    Object.assign(values, overrides);
    writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  };
  return { state, update, run: (command) => execFileSync(process.execPath, [script, command], { cwd: state, env, encoding: 'utf8', stdio: 'pipe' }) };

}

test('rejects blank persisted start before ownership checks and preserves record', async (t) => {
  for (const start of ['', '   ']) {
    await t.test(JSON.stringify(start), async (child) => {
      const { state, run } = await runningFixture(child);
      const recordPath = join(state, 'vite-process.json');
      const value = JSON.parse(readFileSync(recordPath, 'utf8'));
      const record = JSON.stringify({ ...value, start });
      writeFileSync(recordPath, record, { mode: 0o600 });
      assert.throws(() => run('status'), /no verifiable start time/u);
      assert.equal(readFileSync(recordPath, 'utf8'), record);
    });
  }
});

test('status accepts an empty isolated state directory', (t) => {
  const { run } = fixture(t);
  assert.equal(JSON.parse(run('status')).status, 'stopped');
});

test('rejects PostgreSQL identity query overrides before runtime commands', async (t) => {
  for (const key of ['host', 'port', 'user', 'password']) {
    await t.test(key, (child) => {
      const { state, run } = fixture(child, { DATABASE_URL: `${defaultDatabase}?${key}=other.invalid` });
      assert.throws(() => run('backup'), new RegExp(`must not override PostgreSQL ${key}`, 'u'));
      assert.equal(existsSync(join(state, 'docker-called')), false);
      assert.equal(existsSync(join(state, 'backups')), false);
    });
  }
});

test('backup rejects mismatched Compose targets before Docker or backup directory creation', async (t) => {
  for (const [name, overrides] of Object.entries({
    database: { IOLAUS_POSTGRES_DATABASE: 'iolaus_willgriffin_other' },
    host: { DATABASE_URL: defaultDatabase.replace('127.0.0.1', 'other.invalid') },
    port: { DATABASE_URL: defaultDatabase.replace('54330', '54331') },
    configuredPort: { IOLAUS_POSTGRES_PORT: '54331' },
  })) {
    await t.test(name, (child) => {
      const { state, run } = fixture(child, overrides);
      assert.throws(() => run('backup'), /must identify the configured local Compose PostgreSQL database/u);
      assert.equal(existsSync(join(state, 'docker-called')), false);
      assert.equal(existsSync(join(state, 'backups')), false);
    });
  }
});

test('backup admits matching default and custom Compose ports', async (t) => {
  for (const port of ['54330', '54331']) {
    await t.test(port, (child) => {
      const { state, run } = fixture(child, { DATABASE_URL: defaultDatabase.replace('54330', port), IOLAUS_POSTGRES_PORT: port });
      assert.throws(() => run('backup'), /PostgreSQL backup failed/u);
      assert.equal(readFileSync(join(state, 'docker-called'), 'utf8'), 'called');
    });
  }
});

async function runningFixture(t) {
  const fixtureState = fixture(t);
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  fixtureState.update({ PORT: String(port) });
  const viteBin = join(fixtureState.state, 'apps', 'site', 'node_modules', '.bin');
  mkdirSync(viteBin, { recursive: true });
  writeFileSync(join(viteBin, 'vite'), `#!${process.execPath}
import { createServer } from 'node:http';
createServer((_request, response) => { response.writeHead(200); response.end('synthetic health'); }).listen(Number(process.env.PORT), '127.0.0.1');
`, { mode: 0o700 });
  // Only this fixture's owned child is signalled, including when an assertion fails.
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} } });
  try { pid = JSON.parse(fixtureState.run('start')).pid; }
  finally {
    const path = join(fixtureState.state, 'vite-process.json');
    if (!pid && existsSync(path)) pid = JSON.parse(readFileSync(path, 'utf8')).pid;
  }
  assert.equal(JSON.parse(fixtureState.run('status')).status, 'running');
  return fixtureState;
}

test('live process fingerprint rejects changes to PostgreSQL target identity', async (t) => {
  for (const [name, database] of Object.entries({
    protocol: defaultDatabase.replace('postgresql:', 'postgres:'),
    user: defaultDatabase.replace('user:', 'other:'),
    host: defaultDatabase.replace('127.0.0.1', 'other.invalid'),
    port: defaultDatabase.replace('54330', '54331'),
    database: defaultDatabase.replace('_test', '_other'),
  })) {
    await t.test(name, async (child) => {
      const { update, run } = await runningFixture(child);
      update({ DATABASE_URL: database });
      assert.throws(() => run('status'), /configuration changed while it is live/u);
    });
  }
});

test('live process fingerprint remains valid when only the database password changes', async (t) => {
  const { update, run } = await runningFixture(t);
  update({ DATABASE_URL: defaultDatabase.replace('password', 'rotated') });
  assert.equal(JSON.parse(run('status')).status, 'running');
});
