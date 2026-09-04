import assert from 'node:assert/strict';
import test from 'node:test';

import { executeImportPlan } from './smrt-portability.mjs';

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
