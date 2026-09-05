import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateParityIsAdmissible,
  formatParityHelperFailure,
  parseParityFailureStage,
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
  assert.equal(
    candidateParityIsAdmissible(
      {
        ...admissibleCandidate,
        candidateImageProvenance: { binding: 'unknown-binding' },
      },
      'candidate-revision',
    ),
    false,
  );
  assert.equal(
    candidateParityIsAdmissible(admissibleCandidate, 'different-revision'),
    false,
  );
  assert.equal(
    candidateParityIsAdmissible(
      {
        ...admissibleCandidate,
        executionProvenance: { candidateImageScenarioIds: [] },
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

test('parity failure stage accepts only the fixed allowlist', () => {
  assert.equal(
    parseParityFailureStage(
      'IOLAUS_PARITY_FAILURE_STAGE=candidate-image-source-filesystem\n',
    ),
    'candidate-image-source-filesystem',
  );
  assert.equal(
    parseParityFailureStage('IOLAUS_PARITY_FAILURE_STAGE=unknown\n'),
    'unknown',
  );
  assert.equal(
    parseParityFailureStage(
      'IOLAUS_PARITY_FAILURE_STAGE=scenario-execution secret=/tmp/token\n',
    ),
    'unknown',
  );
});

test('parity helper failure formatting redacts arbitrary child stderr', () => {
  const message = formatParityHelperFailure(
    'Error: DATABASE_URL=postgresql://user:secret@example.invalid/db\n' +
      'IOLAUS_PARITY_FAILURE_STAGE=candidate-inventory\n' +
      '/private/worktree/source.ts:42\n',
    17,
  );
  assert.equal(
    message,
    'Synthetic rehearsal parity helper failed at stage candidate-inventory with exit code 17.',
  );
  assert.doesNotMatch(message, /secret|example\.invalid|source\.ts/u);
  assert.match(
    formatParityHelperFailure('fatal: arbitrary child payload', null),
    /stage unknown with exit code 1\.$/u,
  );
});
