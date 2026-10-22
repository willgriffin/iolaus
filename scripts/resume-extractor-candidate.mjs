import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function candidateArgs(image, name) {
  assert.match(image, /^ghcr\.io\/willgriffin\/iolaus\/resume-import-extraction@sha256:[a-f0-9]{64}$/);
  return ['run', '--detach', '--name', name, '--network', 'none', '--read-only',
    '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,mode=1777', image];
}

// Runs inside the actual candidate with its default entrypoint already active.
export const probe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
(async () => {
  assert.equal(process.getuid(), 10001);
  const status = await fs.readFile('/proc/self/status', 'utf8');
  assert.match(status, /CapEff:\s+0+\n/);
  assert.match(status, /NoNewPrivs:\s+1\n/);
  const mounts = await fs.readFile('/proc/mounts', 'utf8');
  assert.ok(mounts.split('\n').some(line => { const parts = line.split(' '); return parts[1] === '/' && parts[3].split(',').includes('ro'); }));
  assert.ok(mounts.split('\n').some(line => { const parts = line.split(' '); return parts[1] === '/tmp' && parts[2] === 'tmpfs' && parts[3].includes('size=32768k') && parts[3].split(',').includes('noexec'); }));
  await assert.rejects(fs.writeFile('/app/should-not-write', 'private'), error => ['EROFS', 'EACCES'].includes(error.code));
  assert.equal((await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(), '536870912');
  assert.equal((await fs.readFile('/sys/fs/cgroup/pids.max', 'utf8')).trim(), '64');
  assert.equal((await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim(), '100000 100000');
  // Network=none supplies loopback only; also exercise a denied external connect.
  const interfaces = require('node:os').networkInterfaces();
  assert.ok(Object.values(interfaces).flat().every(entry => entry.internal));
  await assert.rejects(fetch('http://192.0.2.1', { signal: AbortSignal.timeout(1000) }));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:8080/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'default entrypoint never became healthy');
  const extract = (body, headers = {}) => fetch('http://127.0.0.1:8080/extract', {
    method: 'POST', headers: { 'content-type': 'application/pdf', ...headers }, body });
  assert.equal((await extract('invalid', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await extract(Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await extract('invalid pdf')).status, 422);
  // A real incomplete upload must expire on the production 75s deadline.
  const started = Date.now();
  const timeoutResponse = new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:8080/extract', { method: 'POST',
      headers: { 'content-type': 'application/pdf' } }, res => { req.end(); res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.write('incomplete');
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await extract('busy')).status, 503);
  assert.equal(await timeoutResponse, 504);
  assert.ok(Date.now() - started < 80000, 'production deadline exceeded');
  // Disconnect an incomplete request and require cleanup, then new admission.
  await new Promise(resolve => {
    const req = http.request('http://127.0.0.1:8080/extract', { method: 'POST',
      headers: { 'content-type': 'application/pdf' } });
    req.on('error', () => {}); req.on('close', resolve); req.write('incomplete');
    setTimeout(() => req.destroy(), 100);
  });
  for (let i = 0; i < 100; i++) {
    if (!(await fs.readdir('/tmp')).some(name => name.startsWith('iolaus-resume-'))) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual((await fs.readdir('/tmp')).filter(name => name.startsWith('iolaus-resume-')), []);
  assert.equal((await extract('invalid pdf')).status, 422);
  console.log('Candidate envelope passed; PDF/OCR/provider/Kubernetes qualification still required.');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

export function qualifyCandidate(image, revision, lockSha, run = execFileSync) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.match(lockSha, /^[a-f0-9]{64}$/);
  const name = `iolaus-extractor-candidate-${randomUUID()}`;
  const args = candidateArgs(image, name);
  const docker = (args) => run('docker', args, { encoding: 'utf8', timeout: 120_000 });
  docker(['pull', image]);
  const [metadata] = JSON.parse(docker(['image', 'inspect', image]));
  assert.equal(metadata.Config.User, '10001:10001');
  assert.equal(metadata.Config.Labels['org.opencontainers.image.revision'], revision);
  assert.equal(metadata.Config.Labels['dev.happyvertical.iolaus.pnpm-lock.sha256'], lockSha);
  try {
    docker(args);
    process.stdout.write(docker(['exec', name, 'node', '-e', probe]));
  } finally { docker(['rm', '--force', name]); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  qualifyCandidate(...process.argv.slice(2));
}
