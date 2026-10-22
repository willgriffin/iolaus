import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verifyPublishedClosure } from './verify-published-closure.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'iolaus-published-closure-'));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const pkg = { name: '@happyvertical/auth', version: '0.103.5', integrity: 'sha512-YWJjZA==' };
  write('vendor/release/published-closure.json', { provenance: 'published-registry-metadata', packages: [pkg] });
  write('pnpm-workspace.yaml', 'overrides:\n  "@happyvertical/auth": "0.103.5"\n');
  write('pnpm-lock.yaml', "packages:\n\n  '@happyvertical/auth@0.103.5':\n    resolution: {integrity: sha512-YWJjZA==}\n\nsnapshots:\n");
  write('node_modules/.pnpm/@happyvertical+auth@0.103.5/node_modules/@happyvertical/auth/package.json', pkg);
  for (const path of ['package.json', 'apps/site/package.json', 'packages/cli/package.json', 'packages/resume/package.json']) write(path, { dependencies: {} });
  write('apps/site/package.json', { dependencies: { [pkg.name]: pkg.version } });
  write('apps/site/node_modules/@happyvertical/auth/package.json', pkg);
  try { run({ root, write }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('verifies published graph and ignores unreachable old pnpm store artifacts', () => fixture(({ root, write }) => {
  write('node_modules/.pnpm/@happyvertical+auth@file+old.tgz/node_modules/@happyvertical/auth/package.json', { name: '@happyvertical/auth', version: '0.103.1' });
  assert.equal(verifyPublishedClosure(root), 1);
}));

test('rejects changed lock integrity', () => fixture(({ root, write }) => {
  write('pnpm-lock.yaml', readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').replace('YWJjZA==', 'ZGlmZmVyZW50'));
  assert.throws(() => verifyPublishedClosure(root), /registry integrity differs/u);
}));

test('rejects incompatible active package copies', () => fixture(({ root, write }) => {
  write('pnpm-lock.yaml', `${readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')}\n  '@happyvertical/auth@0.103.1':\n    resolution: {}\n`);
  assert.throws(() => verifyPublishedClosure(root), /incompatible lock identity/u);
}));

test('rejects a local repack direct dependency', () => fixture(({ root, write }) => {
  write('apps/site/package.json', { dependencies: { '@happyvertical/auth': 'file:../../vendor/release/auth.tgz' } });
  assert.throws(() => verifyPublishedClosure(root), /expected a published version/u);
}));


test('rejects stale direct installed links even when the expected store copy exists', () => fixture(({ root, write }) => {
  write('apps/site/node_modules/@happyvertical/auth/package.json', { name: '@happyvertical/auth', version: '0.103.1' });
  assert.throws(() => verifyPublishedClosure(root), /direct installed link differs/u);
}));
