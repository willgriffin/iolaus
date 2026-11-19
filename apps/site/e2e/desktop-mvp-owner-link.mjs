import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// QA operator supplies only the installed app's sidecar PID and public origin.
// Capture that process's environment privately; never print it or its token.
const [pid, rawOrigin, output] = process.argv.slice(2);
if (!/^\d+$/.test(pid || '') || !rawOrigin || !output || !isAbsolute(output))
  throw new Error('Usage: node desktop-mvp-owner-link.mjs SIDECAR_PID LOOPBACK_ORIGIN /absolute/private/owner-link.json');
const origin = new URL(rawOrigin);
if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
  throw new Error('Expected a plain HTTP loopback origin.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const destination = resolve(output);
if (destination === repository || destination.startsWith(`${repository}/`))
  throw new Error('Credential output must be outside the repository.');
let processInfo;
try {
  processInfo = execFileSync('/bin/ps', ['eww', '-p', pid, '-o', 'command='], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch {
  // Never expose child stdout/stderr through Node's rich subprocess error.
  throw new Error('Could not inspect the selected desktop sidecar process.');
}
const secret = processInfo.match(/(?:^|\s)SMRT_DESKTOP_OWNER_LINK_SECRET=([^\s]+)/)?.[1];
if (!secret) throw new Error('Selected process has no desktop owner-link credential.');
const url = new URL('/api/_runtime/owner-link', origin);
url.searchParams.set('launch', secret);
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
writeFileSync(destination, JSON.stringify({ url: url.href }), { mode: 0o600, flag: 'wx' });
console.log('Private desktop owner-link handoff created.');
