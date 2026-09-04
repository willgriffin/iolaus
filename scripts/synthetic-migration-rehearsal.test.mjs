import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateParityIsAdmissible,
  syntheticBundle,
  syntheticContracts,
  syntheticRehearsalDisposition,
  validateRehearsalDatabaseUrl,
} from './synthetic-migration-rehearsal.mjs';

const admissibleCandidate = {
  status: 'passed',
  revision: 'candidate-revision',
  candidateImageTested: true,
  candidateImageProvenance: { binding: 'local-image-id' },
  executionProvenance: { candidateImageScenarioIds: ['generated-surfaces'] },
  syntheticDataOnly: true,
  productionAccessPerformed: false,
  secretValuesIncluded: false,
};

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

test('parity skip cannot produce exit-eligible synthetic rehearsal evidence', () => {
  assert.deepEqual(
    syntheticRehearsalDisposition({ status: 'skipped-by-explicit-operator-option' }),
    {
      status: 'partial',
      syntheticRehearsalExitEligible: false,
      productionRehearsalExitEligible: false,
    },
  );
  assert.deepEqual(syntheticRehearsalDisposition({ status: 'passed' }), {
    status: 'partial',
    syntheticRehearsalExitEligible: false,
    productionRehearsalExitEligible: false,
  });
  assert.deepEqual(
    syntheticRehearsalDisposition({
      status: 'passed',
      candidateImageTested: true,
    }),
    {
    status: 'passed',
    syntheticRehearsalExitEligible: true,
    productionRehearsalExitEligible: false,
    },
  );
});

test('candidate parity accepts both immutable image provenance modes', () => {
  assert.equal(
    candidateParityIsAdmissible(admissibleCandidate, 'candidate-revision'),
    true,
  );
  assert.equal(
    candidateParityIsAdmissible(
      {
        ...admissibleCandidate,
        candidateImageProvenance: { binding: 'released-repository-digest' },
      },
      'candidate-revision',
    ),
    true,
  );
  assert.equal(
    candidateParityIsAdmissible(
      {
        ...admissibleCandidate,
        candidateImageProvenance: { binding: 'mutable-image-tag' },
      },
      'candidate-revision',
    ),
    false,
  );
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
