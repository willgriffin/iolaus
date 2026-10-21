import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPDFReader } from '@happyvertical/pdf';

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 1_000_000;
export const MAX_PAGES = 20;
export const MAX_TEXT_CHARS = 120_000;
export const EXTRACTION_TIMEOUT_MS = 75_000;
const workerFlag = '--worker';
const scriptPath = fileURLToPath(import.meta.url);

function send(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
function fail(response, status, error) { send(response, status, { error }); }

async function runWorker(input, output) {
  if ((await stat(input)).size > MAX_INPUT_BYTES) process.exit(64);
  const reader = await getPDFReader({ provider: 'unpdf', enableOCR: false });
  const info = await reader.getInfo(input);
  if (!Number.isSafeInteger(info.pageCount) || info.pageCount < 1 || info.pageCount > MAX_PAGES) process.exit(65);
  const pages = [];
  for (let page = 1; page <= info.pageCount; page += 1)
    pages.push({ page, text: String((await reader.extractText(input, { pages: [page], skipOCRFallback: true })) ?? '') });
  if (pages.reduce((total, page) => total + page.text.length, 0) > MAX_TEXT_CHARS) process.exit(66);
  const encoded = JSON.stringify({ pages, needsOcr: pages.some((page) => !page.text.trim()) });
  if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) process.exit(67);
  await writeFile(output, encoded, { mode: 0o600 });
}

async function writeRequest(request, file, signal) {
  return new Promise((resolve, reject) => {
    let bytes = 0; let settled = false;
    const stream = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    const done = (error) => {
      if (settled) return; settled = true;
      if (error?.code === 'TIMEOUT') request.resume();
      else request.destroy();
      stream.destroy(); error ? reject(error) : resolve();
    };
    request.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_INPUT_BYTES) done(Object.assign(new Error(), { code: 'LIMIT' })); });
    request.on('aborted', () => done(Object.assign(new Error(), { code: 'CANCELLED' })));
    signal.addEventListener('abort', () => done(Object.assign(new Error(), { code: signal.reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED' })), { once: true });
    request.on('error', done); stream.on('error', done);
    stream.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    request.pipe(stream);
  });
}
function runChild(input, output, signal, spawnChild) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, [scriptPath, workerFlag, input, output], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } });
    let forced;
    const terminate = () => {
      child.kill('SIGTERM');
      forced = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    if (signal.aborted) terminate();
    else signal.addEventListener('abort', terminate, { once: true });
    child.once('error', () => reject(new Error('failed')));
    child.once('exit', (code) => {
      if (forced) clearTimeout(forced);
      code === 0 ? resolve() : reject(new Error('failed'));
    });
  });
}
function valid(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.pages) || typeof value.needsOcr !== 'boolean' || value.pages.length < 1 || value.pages.length > MAX_PAGES) return false;
  let length = 0;
  return value.pages.every((page, index) => {
    if (!page || page.page !== index + 1 || typeof page.text !== 'string') return false;
    length += page.text.length; return length <= MAX_TEXT_CHARS;
  });
}

export function createExtractionServer({ spawnChild = spawn, timeoutMs = EXTRACTION_TIMEOUT_MS, tempRoot = tmpdir() } = {}) {
  let busy = false;
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { status: 'ok' });
    if (request.method !== 'POST' || request.url !== '/extract') return fail(response, 404, 'not_found');
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf') return fail(response, 415, 'unsupported_type');
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_INPUT_BYTES) return fail(response, 413, 'limit');
    if (busy) return fail(response, 503, 'busy');
    busy = true; let directory;
    const disconnected = new AbortController(); const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort('timeout'), timeoutMs);
    const cancellation = AbortSignal.any([deadline.signal, disconnected.signal]);
    const disconnect = () => disconnected.abort('cancelled');
    request.once('aborted', disconnect); response.once('close', () => { if (!response.writableEnded) disconnect(); });
    try {
      if (cancellation.aborted) throw new Error('cancelled');
      directory = await mkdtemp(join(tempRoot, 'iolaus-resume-')); await chmod(directory, 0o700);
      const input = join(directory, 'input.pdf'); const output = join(directory, 'output.json');
      await writeRequest(request, input, cancellation);
      if (cancellation.aborted) throw new Error('cancelled');
      await runChild(input, output, cancellation, spawnChild);
      if (deadline.signal.aborted) throw new Error('timeout');
      if (disconnected.signal.aborted) return;
      if ((await stat(output)).size > MAX_OUTPUT_BYTES) return fail(response, 502, 'malformed_output');
      const result = JSON.parse(await readFile(output, 'utf8'));
      if (!valid(result)) return fail(response, 502, 'malformed_output');
      send(response, 200, result);
    } catch (error) {
      if (disconnected.signal.aborted) return;
      if (deadline.signal.aborted) fail(response, 504, 'timeout');
      else if (error?.code === 'LIMIT') fail(response, 413, 'limit');
      else fail(response, 422, 'extraction_failed');
    } finally {
      clearTimeout(timer); busy = false;
      if (directory) { try { await rm(directory, { recursive: true, force: true }); } catch {} }
    }
  });
}

if (process.argv[2] === workerFlag || process.argv.slice(2).length === 2) {
  const [input, output] = process.argv[2] === workerFlag ? process.argv.slice(3) : process.argv.slice(2);
  if (!input || !output) process.exit(64);
  runWorker(input, output).catch(() => process.exit(70));
} else if (process.argv[1] === scriptPath) {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  createExtractionServer().listen(Number.isSafeInteger(port) && port > 0 ? port : 8080, '0.0.0.0');
}
