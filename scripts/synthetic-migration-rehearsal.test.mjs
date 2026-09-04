import assert from 'node:assert/strict';
import test from 'node:test';

import {
  syntheticBundle,
  syntheticContracts,
  validateRehearsalDatabaseUrl,
} from './synthetic-migration-rehearsal.mjs';

test('synthetic rehearsal fixture is deterministic and includes reconciliation cases', () => {
  const contracts = syntheticContracts();
  const first = syntheticBundle(contracts);
  const second = syntheticBundle(contracts);
  assert.equal(first.runId, second.runId);
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
  assert.equal(first.tables.find((entry) => entry.name === 'tenants').rowCount, 2);
  assert.equal(first.tables.find((entry) => entry.name === 'users').rowCount, 2);
  assert.equal(first.tables.find((entry) => entry.name === 'resume_assets').rowCount, 1);
});

test('rehearsal database guard accepts only named loopback PostgreSQL databases', () => {
  assert.equal(
    validateRehearsalDatabaseUrl(
      'postgresql://iolaus_rehearsal@127.0.0.1:5432/iolaus_rehearsal',
    ),
    'postgresql://iolaus_rehearsal@127.0.0.1:5432/iolaus_rehearsal',
  );
  for (const value of [
    'postgresql://db.example.invalid/iolaus_rehearsal',
    'postgresql://127.0.0.1/iolaus',
    'postgresql://127.0.0.1/iolaus_test?host=db.example.invalid',
    'sqlite:///tmp/iolaus_test.sqlite',
  ]) {
    assert.throws(() => validateRehearsalDatabaseUrl(value), /rehearsal database/iu);
  }
});
