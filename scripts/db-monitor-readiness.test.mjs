import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  monitorReadinessDatabaseUrl,
  runMonitorReadiness,
} from '../apps/site/scripts/db-monitor-readiness.mjs';

test('forces read-only PostgreSQL startup while retaining the configured connection', () => {
  const original = new URL(
    'postgresql://migration:private@database.example.invalid:5433/career?sslmode=require&application_name=monitor',
  );
  original.searchParams.set(
    'options',
    '-c statement_timeout=4000 -c default_transaction_read_only=off',
  );
  const guarded = new URL(monitorReadinessDatabaseUrl(original.href));
  assert.equal(guarded.username, original.username);
  assert.equal(guarded.password, original.password);
  assert.equal(guarded.host, original.host);
  assert.equal(guarded.pathname, original.pathname);
  assert.equal(guarded.searchParams.get('sslmode'), 'require');
  assert.equal(guarded.searchParams.get('application_name'), 'monitor');
  assert.equal(
    guarded.searchParams.get('options'),
    '-c statement_timeout=4000 -c default_transaction_read_only=off -c default_transaction_read_only=on',
  );
  assert.equal(
    new URL(monitorReadinessDatabaseUrl('postgres://localhost/career'))
      .searchParams.get('options'),
    '-c default_transaction_read_only=on',
  );
});

test('fails closed with a sanitized error for absent, malformed and non-PostgreSQL URLs', () => {
  for (const value of [
    undefined,
    '',
    'private-invalid-url',
    'sqlite:///private-database',
    'https://migration:private@database.example.invalid/career',
  ]) {
    assert.throws(
      () => monitorReadinessDatabaseUrl(value),
      (error) =>
        error instanceof Error &&
        !error.message.includes('private') &&
        !error.message.includes('database.example.invalid'),
    );
  }
});

test('loads native status only after configuring read-only startup options', async () => {
  const env = { DATABASE_URL: 'postgresql://localhost/career' };
  let calls = 0;
  await runMonitorReadiness({
    env,
    async loadStatus() {
      calls++;
      assert.equal(
        new URL(env.DATABASE_URL).searchParams.get('options'),
        '-c default_transaction_read_only=on',
      );
    },
  });
  assert.equal(calls, 1);
});

test('never imports status with an invalid database URL and propagates status failure', async () => {
  let calls = 0;
  await assert.rejects(
    runMonitorReadiness({
      env: { DATABASE_URL: 'sqlite:///private-database' },
      async loadStatus() {
        calls++;
      },
    }),
  );
  assert.equal(calls, 0);
  const failure = new Error('status rejected stale schema');
  await assert.rejects(
    runMonitorReadiness({
      env: { DATABASE_URL: 'postgresql://localhost/career' },
      async loadStatus() {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
});

test('can import the URL guard from a native stdin operator probe without starting status', () => {
  const moduleUrl = new URL('../apps/site/scripts/db-monitor-readiness.mjs', import.meta.url);
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    encoding: 'utf8',
    input: `import { monitorReadinessDatabaseUrl } from ${JSON.stringify(moduleUrl.href)};
      if (!monitorReadinessDatabaseUrl('postgresql://localhost/fixture').includes('read_only')) process.exit(2);`,
    env: { ...process.env, DATABASE_URL: undefined },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
