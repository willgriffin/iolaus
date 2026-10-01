#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const root = process.cwd();
const command = process.argv[2] || 'doctor';
const envFile = resolve(
  process.env.IOLAUS_DAILY_ENV_FILE ||
    '/Users/will/Work/willgriffin/local-ops/iolaus/daily.env',
);

if (!existsSync(envFile)) {
  throw new Error(`Private daily-use environment file is missing: ${envFile}`);
}

const privateEnvironment = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const env = { ...process.env, ...privateEnvironment };
const stateDir = resolve(env.IOLAUS_DAILY_STATE_DIR || '/Users/will/Work/willgriffin/local-ops/iolaus/runtime');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const recordPath = resolve(stateDir, 'vite-process.json');
const logPath = resolve(stateDir, 'vite.log');
const required = [
  'SMRT_RUNTIME_PROFILE',
  'SMRT_APP_ID',
  'IOLAUS_PUBLIC_URL',
  'DATABASE_URL',
  'RESUME_FILES_CONFIG_JSON',
  'IOLAUS_OIDC_SERVER_URL',
  'IOLAUS_OIDC_CLIENT_ID',
  'IOLAUS_OIDC_ADMIN_EMAILS',
];
for (const key of required) {
  if (!env[key]) throw new Error(`Private daily-use configuration requires ${key}.`);
}
if (env.SMRT_RUNTIME_PROFILE !== 'self-hosted') {
  throw new Error('Daily-use runtime must use SMRT_RUNTIME_PROFILE=self-hosted.');
}
if (env.HOST && env.HOST !== '127.0.0.1') {
  throw new Error('Daily-use app backend must bind only to 127.0.0.1.');
}
env.HOST = '127.0.0.1';
env.PORT ||= '47292';
env.SMRT_BACKGROUND_JOBS ||= 'false';
const configuration = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(env).filter(([key]) => !/(SECRET|PASSWORD|KEY)/u.test(key)).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');

function record() {
  if (!existsSync(recordPath)) return null;
  const value = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (!Number.isSafeInteger(value.pid) || typeof value.start !== 'string' || value.configuration !== configuration) return null;
  const check = spawnSync('ps', ['-p', String(value.pid), '-o', 'lstart=,command='], { encoding: 'utf8' });
  if (check.status !== 0 || !check.stdout.includes(value.start) || !check.stdout.includes('vite')) return null;
  return value;
}

async function ready(pid) {
  const url = `http://127.0.0.1:${env.PORT}/api/_runtime/health`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(url); if (response.status === 200) return; } catch {}
    try { process.kill(pid, 0); } catch { throw new Error('Daily-use Vite process exited before health became ready.'); }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Daily-use Vite process did not become ready at ${url}.`);
}

function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status || 1;
}

if (command === 'up') run('docker', ['compose', '--env-file', envFile, '-f', 'docker-compose.daily.yml', 'up', '-d', '--wait']);
else if (command === 'down') run('docker', ['compose', '--env-file', envFile, '-f', 'docker-compose.daily.yml', 'down']);
else if (command === 'migrate') run('pnpm', ['--filter', '@willgriffin/iolaus-site', 'exec', 'tsx', 'scripts/db-migrate.ts']);
else if (command === 'dev') run('pnpm', ['--filter', '@willgriffin/iolaus-site', 'dev', '--host', '127.0.0.1', '--port', env.PORT]);
else if (command === 'doctor') run('pnpm', ['--filter', '@willgriffin/iolaus-site', 'exec', 'tsx', 'scripts/db-status.ts', '--json']);
else if (command === 'start') {
  const current = record();
  if (current) console.log(JSON.stringify({ status: 'running', pid: current.pid, secretValuesIncluded: false }));
  else {
    const descriptor = openSync(logPath, 'a', 0o600);
    const child = spawn('pnpm', ['--filter', '@willgriffin/iolaus-site', 'dev', '--host', '127.0.0.1', '--port', env.PORT], { cwd: root, env, detached: true, stdio: ['ignore', descriptor, descriptor] });
    closeSync(descriptor); child.unref();
    const details = spawnSync('ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(recordPath, `${JSON.stringify({ pid: child.pid, start: details, configuration, instance: randomBytes(16).toString('hex') })}\n`, { mode: 0o600 });
    await ready(child.pid);
    console.log(JSON.stringify({ status: 'started', pid: child.pid, secretValuesIncluded: false }));
  }
}
else if (command === 'stop') {
  const current = record();
  if (!current) { rmSync(recordPath, { force: true }); console.log(JSON.stringify({ status: 'stopped', secretValuesIncluded: false })); }
  else { process.kill(current.pid, 'SIGTERM'); rmSync(recordPath, { force: true }); console.log(JSON.stringify({ status: 'stopped', pid: current.pid, secretValuesIncluded: false })); }
}
else if (command === 'status') {
  const current = record();
  console.log(JSON.stringify({ status: current ? 'running' : 'stopped', pid: current?.pid ?? null, configuration: current ? configuration : null, secretValuesIncluded: false }));
}
else if (command === 'backup') {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const directory = resolve(env.IOLAUS_DAILY_BACKUP_DIR || '/Users/will/Work/willgriffin/local-ops/iolaus/backups', stamp);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dump = spawnSync('docker', ['compose', '--env-file', envFile, '-f', 'docker-compose.daily.yml', 'exec', '-T', 'postgres', 'pg_dump', '-U', env.IOLAUS_POSTGRES_USER, env.IOLAUS_POSTGRES_DATABASE], { cwd: root, env, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error('PostgreSQL backup failed.');
  writeFileSync(resolve(directory, 'database.sql'), dump.stdout, { mode: 0o600 });
  const storage = JSON.parse(env.RESUME_FILES_CONFIG_JSON);
  if (storage.type !== 's3' || !storage.bucket || !storage.endpoint || !storage.accessKey || !storage.secretKey) {
    throw new Error('Daily backup requires the configured S3-compatible asset provider.');
  }
  const assets = spawnSync('aws', ['s3', 'sync', `s3://${storage.bucket}`, resolve(directory, 'assets'), '--endpoint-url', storage.endpoint], {
    cwd: root,
    env: { ...env, AWS_ACCESS_KEY_ID: storage.accessKey, AWS_SECRET_ACCESS_KEY: storage.secretKey, AWS_DEFAULT_REGION: storage.region || 'us-east-1' },
    encoding: 'utf8',
  });
  if (assets.status !== 0) throw new Error('S3 asset backup failed.');
  console.log(JSON.stringify({ status: 'backup-created', directory, recovery: 'Restore only into an isolated PostgreSQL target, then verify assets and database counts before cutover.', secretValuesIncluded: false }));
}
else throw new Error('Usage: daily-use-dev.mjs up|down|migrate|dev|doctor');
