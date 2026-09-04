import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evidenceDigest,
  validateImageReference,
} from './deployed-parity.mjs';

test('accepts only the exact released Iolaus image reference', () => {
  const digest = 'a'.repeat(64);
  assert.equal(
    validateImageReference(
      `ghcr.io/willgriffin/iolaus/site@sha256:${digest}`,
    ),
    `ghcr.io/willgriffin/iolaus/site@sha256:${digest}`,
  );
  assert.equal(validateImageReference(undefined), null);
  for (const invalid of [
    'ghcr.io/willgriffin/iolaus/site:latest',
    `ghcr.io/other/iolaus/site@sha256:${digest}`,
    'ghcr.io/willgriffin/iolaus/site@sha256:REPLACE_WITH_RELEASED_IMAGE_DIGEST',
  ]) {
    assert.throws(() => validateImageReference(invalid), /exact released/u);
  }
});

test('creates a deterministic evidence digest without secret inputs', () => {
  const evidence = {
    schema: 'iolaus-deployed-parity-contract:v1',
    status: 'passed',
    secretValuesIncluded: false,
  };
  assert.match(evidenceDigest(evidence), /^[a-f0-9]{64}$/u);
  assert.equal(evidenceDigest(evidence), evidenceDigest({ ...evidence }));
});
