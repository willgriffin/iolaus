import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readSensitiveBundle } from './smrt-portability-assets.mjs';
import { executeImportPlan } from './smrt-portability.mjs';

function withPrivateBundleFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'iolaus-private-bundle-'));
  const canonicalParent = join(root, 'canonical');
  const parentAlias = join(root, 'alias');
  const bundlePath = join(canonicalParent, 'bundle.json');
  mkdirSync(canonicalParent, { mode: 0o700 });
  writeFileSync(bundlePath, '{"kind":"synthetic"}', { mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  symlinkSync(canonicalParent, parentAlias, 'dir');
  try {
    run({ bundlePath, parentAlias, root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('private bundle reader accepts a canonical file through a macOS-style parent alias', () => {
  withPrivateBundleFixture(({ parentAlias }) => {
    assert.equal(
      readSensitiveBundle(join(parentAlias, 'bundle.json')),
      '{"kind":"synthetic"}',
    );
  });
});

test(
  'private bundle reader accepts a normal /tmp path',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync('/tmp/iolaus-private-bundle-');
    const bundlePath = join(root, 'bundle.json');
    writeFileSync(bundlePath, '{"kind":"synthetic"}', { mode: 0o600 });
    chmodSync(bundlePath, 0o600);
    try {
      assert.equal(readSensitiveBundle(bundlePath), '{"kind":"synthetic"}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('private bundle reader rejects a symlink leaf through a canonical parent', () => {
  withPrivateBundleFixture(({ bundlePath, parentAlias }) => {
    const linkedBundle = join(parentAlias, 'linked-bundle.json');
    symlinkSync(bundlePath, linkedBundle);
    assert.throws(
      () => readSensitiveBundle(linkedBundle),
      /unsafe-bundle-file/,
    );
  });
});

test('private bundle reader rejects permissions broader than 0600', () => {
  withPrivateBundleFixture(({ bundlePath }) => {
    chmodSync(bundlePath, 0o644);
    assert.throws(
      () => readSensitiveBundle(bundlePath),
      /unsafe-bundle-file/,
    );
  });
});

test('private bundle reader detects a symlink swap after opening', () => {
  withPrivateBundleFixture(({ bundlePath, parentAlias }) => {
    const openedPath = `${bundlePath}.opened`;
    assert.throws(
      () =>
        readSensitiveBundle(join(parentAlias, 'bundle.json'), {
          onOpened() {
            renameSync(bundlePath, openedPath);
            symlinkSync(openedPath, bundlePath);
          },
        }),
      /bundle-changed-during-read/,
    );
  });
});

test('private bundle reader detects permissions broadened after opening', () => {
  withPrivateBundleFixture(({ bundlePath, parentAlias }) => {
    assert.throws(
      () =>
        readSensitiveBundle(join(parentAlias, 'bundle.json'), {
          onOpened() {
            chmodSync(bundlePath, 0o644);
          },
        }),
      /bundle-changed-during-read/,
    );
  });
});

test('import binds inserts and deferred updates with parameter arrays', async () => {
  const calls = [];
  const tx = {
    async query(...args) {
      calls.push(args);
      return calls.length === 1 ? { rows: [{ count: 0 }] } : { rows: [] };
    },
  };
  const table = {
    name: 'items',
    primaryKeys: ['id'],
    deferredColumns: new Set(['parentId']),
  };

  assert.equal(
    await executeImportPlan(
      tx,
      [table],
      new Map([['items', { rows: [{ id: 'child', parentId: 'parent' }] }]]),
    ),
    1,
  );
  assert.deepEqual(calls[1], [
    'INSERT INTO "items" ("id", "parentId") VALUES (?, ?)',
    ['child', null],
  ]);
  assert.deepEqual(calls[2], [
    'UPDATE "items" SET "parentId" = ? WHERE "id" = ?',
    ['parent', 'child'],
  ]);
});
