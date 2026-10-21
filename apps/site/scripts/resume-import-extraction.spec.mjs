import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExtractionServer, MAX_INPUT_BYTES } from './resume-import-extraction.mjs';

async function withService(options, run) {
  const root = await mkdtemp(join(tmpdir(), 'iolaus-extraction-test-'));
  const server = createExtractionServer({ tempRoot: root, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url, root); } finally { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
}
function childThat({ body = JSON.stringify({ pages: [{ page: 1, text: 'Fictional resume' }], needsOcr: false }), hold = false } = {}) {
  const children = [];
  const spawnChild = (_bin, args) => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 143)); return true; };
    children.push(child);
    if (!hold) queueMicrotask(async () => { await writeFile(args[3], body, { mode: 0o600 }); child.emit('exit', 0); });
    return child;
  };
  return { spawnChild, children };
}
async function extract(url, body = new Uint8Array([1])) {
  return fetch(`${url}/extract`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body });
}
async function expectClean(root) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readdir(root)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(await readdir(root), []);
}

test('extracts a fictional request and deletes its private temporary files', async () => {
  const fake = childThat();
  await withService(fake, async (url, root) => {
    const response = await extract(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { pages: [{ page: 1, text: 'Fictional resume' }], needsOcr: false });
    await expectClean(root);
  });
});
test('rejects oversized input before creating a child', async () => {
  const fake = childThat();
  await withService(fake, async (url, root) => {
    const response = await extract(url, new Uint8Array(MAX_INPUT_BYTES + 1));
    assert.equal(response.status, 413);
    assert.equal(fake.children.length, 0);
    await expectClean(root);
  });
});
test('returns busy while one bounded child is active', async () => {
  const fake = childThat({ hold: true });
  await withService(fake, async (url) => {
    const first = extract(url);
    while (fake.children.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await extract(url);
    assert.equal(second.status, 503);
    fake.children[0].emit('exit', 1);
    await first;
  });
});
test('kills and cleans up a child at its deadline', async () => {
  const fake = childThat({ hold: true });
  await withService({ ...fake, timeoutMs: 10 }, async (url, root) => {
    const response = await extract(url);
    assert.equal(response.status, 504);
    assert.equal(fake.children[0].killed, true);
    await expectClean(root);
  });
});
test('times out a slow full upload before spawning a child', { timeout: 2_000 }, async (context) => {
  const fake = childThat();
  await withService({ ...fake, timeoutMs: 10 }, async (url, root) => {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(`${url}/extract`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, signal: context.signal }, response => { request.end(); resolve(response); });
      request.on('error', reject);
      // Keep the body incomplete until the server's deadline response. A client
      // timer could expire before the busy server even accepts this request.
      request.write(Buffer.from([1]));
    });
    assert.equal(response.statusCode, 504);
    assert.equal(fake.children.length, 0);
    await expectClean(root);
  });
});
test('disconnect kills the child and removes temporary files', async () => {
  const fake = childThat({ hold: true });
  await withService(fake, async (url, root) => {
    await new Promise((resolve, reject) => {
      const request = httpRequest(`${url}/extract`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'content-length': '1' } });
      request.on('error', () => resolve());
      request.on('close', resolve);
      request.end(Buffer.from([1]));
      setTimeout(() => request.destroy(), 5);
      setTimeout(reject, 500);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.children[0].killed, true);
    await expectClean(root);
  });
});
