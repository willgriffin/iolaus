import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { assertOwnedDemoRoot, assertSafeDemoRoot, initializeDemoRoot } from './iolaus-demo.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('marks and reopens an isolated demo root', () => {
  const root = mkdtempSync(join(tmpdir(), 'iolaus-demo-unit-'));
  roots.push(root);
  const canonicalRoot = realpathSync(root);
  assert.equal(initializeDemoRoot(root), canonicalRoot);
  assert.equal(initializeDemoRoot(root), canonicalRoot);
  assert.equal(assertOwnedDemoRoot(root), canonicalRoot);
  const marker = JSON.parse(readFileSync(join(root, '.iolaus-demo-root.json'), 'utf8'));
  assert.equal(marker.schema, 'iolaus-demo-root:v1');
  assert.equal(marker.appId, 'iolaus');
});

test('refuses broad and source-controlled reset targets', () => {
  assert.throws(() => assertSafeDemoRoot(homedir()), /broad or source-controlled/);
  assert.throws(() => assertSafeDemoRoot(tmpdir()), /broad or source-controlled/);
  assert.throws(() => assertSafeDemoRoot(join(process.cwd(), 'unsafe-demo')), /outside the source checkout/);
});

test('refuses to adopt or reset unmarked data', () => {
  const root = mkdtempSync(join(tmpdir(), 'iolaus-demo-unit-'));
  roots.push(root);
  writeFileSync(join(root, 'personal.txt'), 'preserve me');
  assert.throws(() => initializeDemoRoot(root), /non-empty unmarked/);
  assert.throws(() => assertOwnedDemoRoot(root), /unmarked directory/);
});

test('refuses a forged ownership marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'iolaus-demo-unit-'));
  roots.push(root);
  writeFileSync(
    join(root, '.iolaus-demo-root.json'),
    JSON.stringify({
      schema: 'iolaus-demo-root:v1',
      appId: 'iolaus',
      root,
      sourceFingerprint: 'forged',
    }),
  );
  assert.throws(() => assertOwnedDemoRoot(root), /invalid marker/);
});
