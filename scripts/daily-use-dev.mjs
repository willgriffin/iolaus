#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

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
  'IOLAUS_POSTGRES_USER',
  'IOLAUS_POSTGRES_DATABASE',
];
for (const key of required) {
  if (!env[key]) throw new Error(`Private daily-use configuration requires ${key}.`);
}
if (env.SMRT_RUNTIME_PROFILE !== 'self-hosted') {
  throw new Error('Daily-use runtime must use SMRT_RUNTIME_PROFILE=self-hosted.');
}
const databaseName = decodeURIComponent(new URL(env.DATABASE_URL).pathname.replace(/^\/+|\/+$/gu, ''));
const databaseNamespace = env.SMRT_APP_ID.replaceAll('-', '_');
if (databaseName !== databaseNamespace && !databaseName.startsWith(`${databaseNamespace}_`)) {
  throw new Error(`Daily-use PostgreSQL database must be named ${databaseNamespace} or begin with ${databaseNamespace}_.`);
}
if (env.HOST && env.HOST !== '127.0.0.1') {
  throw new Error('Daily-use app backend must bind only to 127.0.0.1.');
}
env.HOST = '127.0.0.1';
env.PORT ||= '47292';
env.SMRT_BACKGROUND_JOBS ||= 'false';
env.TSX_TSCONFIG_PATH ||= join(root, 'apps', 'site', 'tsconfig.runtime.json');
env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = new URL(env.IOLAUS_PUBLIC_URL).hostname;
const configuration = createHash('sha256').update(JSON.stringify({ appId: env.SMRT_APP_ID, profile: env.SMRT_RUNTIME_PROFILE, publicUrl: env.IOLAUS_PUBLIC_URL, database: databaseName, listener: `127.0.0.1:${env.PORT}`, assets: env.RESUME_FILES_CONFIG_JSON })).digest('hex');

function record() {
  if (!existsSync(recordPath)) return null;
  const value = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (!Number.isSafeInteger(value.pid) || typeof value.start !== 'string') return null;
  const check = spawnSync('ps', ['-p', String(value.pid), '-o', 'lstart=,command='], { encoding: 'utf8' });
  if (check.status !== 0) return null;
  if (!check.stdout.includes(value.start) || !check.stdout.includes('vite')) throw new Error('Daily-use process record does not identify the live process; retain it and inspect private state.');
  if (value.configuration !== configuration) throw new Error('Daily-use process configuration changed while it is live; stop it from the matching configuration first.');
  return value;
}

async function ready(pid) {
  const url = `http://127.0.0.1:${env.PORT}/api/_runtime/health`;
  for (let attempt = 0; attempt < 240; attempt += 1) {
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
    const child = spawn(join(root, 'apps', 'site', 'node_modules', '.bin', 'vite'), ['dev', '--host', '127.0.0.1', '--port', env.PORT, '--strictPort'], { cwd: join(root, 'apps', 'site'), env, detached: true, stdio: ['ignore', descriptor, descriptor] });
    closeSync(descriptor); child.unref();
    const details = spawnSync('ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
    if (!details) {
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
      throw new Error('Daily-use Vite process did not provide a verifiable start time.');
    }
    writeFileSync(recordPath, `${JSON.stringify({ pid: child.pid, start: details, configuration, instance: randomBytes(16).toString('hex') })}\n`, { mode: 0o600 });
    try { await ready(child.pid); } catch (error) { try { process.kill(child.pid, 'SIGTERM'); } catch {} rmSync(recordPath, { force: true }); throw error; }
    console.log(JSON.stringify({ status: 'started', pid: child.pid, secretValuesIncluded: false }));
  }
}
else if (command === 'stop') {
  const current = record();
  if (!current) { rmSync(recordPath, { force: true }); console.log(JSON.stringify({ status: 'stopped', secretValuesIncluded: false })); }
  else { process.kill(current.pid, 'SIGTERM'); for (let attempt = 0; attempt < 40; attempt += 1) { try { process.kill(current.pid, 0); } catch { rmSync(recordPath, { force: true }); console.log(JSON.stringify({ status: 'stopped', pid: current.pid, secretValuesIncluded: false })); process.exit(0); } await new Promise((done) => setTimeout(done, 250)); } throw new Error('Daily-use Vite process did not exit after SIGTERM; retain its record and inspect private state.'); }
}
else if (command === 'status') {
  const current = record();
  console.log(JSON.stringify({ status: current ? 'running' : 'stopped', pid: current?.pid ?? null, configuration: current ? configuration : null, secretValuesIncluded: false }));
}
else if (command === 'backup') {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const directory = resolve(env.IOLAUS_DAILY_BACKUP_DIR || '/Users/will/Work/willgriffin/local-ops/iolaus/backups', stamp);
  const partial = `${directory}.partial`;
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  const dump = spawnSync('docker', ['compose', '--env-file', envFile, '-f', 'docker-compose.daily.yml', 'exec', '-T', 'postgres', 'pg_dump', '-U', env.IOLAUS_POSTGRES_USER, env.IOLAUS_POSTGRES_DATABASE], { cwd: root, env, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error('PostgreSQL backup failed.');
  writeFileSync(resolve(partial, 'database.sql'), dump.stdout, { mode: 0o600 });
  const storage = JSON.parse(env.RESUME_FILES_CONFIG_JSON);
  if (storage.type !== 's3' || !storage.bucket || !storage.endpoint || !storage.accessKeyId || !storage.secretAccessKey) {
    throw new Error('Daily backup requires the configured S3-compatible asset provider.');
  }
  mkdirSync(resolve(partial, 'assets'), { recursive: true, mode: 0o700 });
  const assets = spawnSync('aws', ['s3', 'sync', `s3://${storage.bucket}`, resolve(partial, 'assets'), '--endpoint-url', storage.endpoint], {
    cwd: root,
    env: { ...env, AWS_ACCESS_KEY_ID: storage.accessKeyId, AWS_SECRET_ACCESS_KEY: storage.secretAccessKey, AWS_DEFAULT_REGION: storage.region || 'us-east-1' },
    encoding: 'utf8',
  });
  if (assets.status !== 0) throw new Error(`S3 asset backup failed; inspect private partial backup ${partial}.`);
  const permissions = spawnSync('chmod', ['-R', 'go-rwx', partial], { cwd: root, env, stdio: 'ignore' });
  if (permissions.status !== 0) throw new Error('Daily backup could not set private permissions.');
  const assetCount = spawnSync('find', [resolve(partial, 'assets'), '-type', 'f'], { encoding: 'utf8' });
  if (assetCount.status !== 0) throw new Error('Daily backup could not inventory S3 assets.');
  writeFileSync(resolve(partial, 'complete.json'), `${JSON.stringify({ schema: 1, databaseSha256: createHash('sha256').update(dump.stdout).digest('hex'), assetObjects: assetCount.stdout.trim().split('\n').filter(Boolean).length, complete: true })}\n`, { mode: 0o600 });
  renameSync(partial, directory);
  console.log(JSON.stringify({ status: 'backup-created', directory, recovery: 'Restore only into an isolated PostgreSQL target, then verify assets and database counts before cutover.', secretValuesIncluded: false }));
}
else throw new Error('Usage: daily-use-dev.mjs up|down|migrate|dev|doctor|start|stop|status|backup');
