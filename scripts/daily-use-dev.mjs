#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status || 1;
}

if (command === 'up') run('docker', ['compose', '--env-file', envFile, '-f', 'docker-compose.daily.yml', 'up', '-d', '--wait']);
else if (command === 'down') run('docker', ['compose', '--env-file', envFile, '-f', 'docker-compose.daily.yml', 'down']);
else if (command === 'migrate') run('pnpm', ['--filter', '@willgriffin/iolaus-site', 'exec', 'tsx', 'scripts/db-migrate.ts']);
else if (command === 'dev') run('pnpm', ['--filter', '@willgriffin/iolaus-site', 'dev', '--host', '127.0.0.1', '--port', env.PORT]);
else if (command === 'doctor') run('pnpm', ['--filter', '@willgriffin/iolaus-site', 'exec', 'tsx', 'scripts/db-status.ts', '--json']);
else throw new Error('Usage: daily-use-dev.mjs up|down|migrate|dev|doctor');
