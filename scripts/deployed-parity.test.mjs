import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evidenceDigest,
  validateCandidateImageMetadata,
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

test('binds a candidate image digest to source and dependency provenance', () => {
  const imageRef = `ghcr.io/willgriffin/iolaus/site@sha256:${'a'.repeat(64)}`;
  const revision = 'b'.repeat(40);
  const lockfileSha256 = 'c'.repeat(64);
  const metadata = {
    imageRef,
    labels: {
      'dev.happyvertical.iolaus.pnpm-lock.sha256': lockfileSha256,
      'org.opencontainers.image.revision': revision,
    },
    repoDigests: [imageRef],
  };

  assert.deepEqual(
    validateCandidateImageMetadata(metadata, revision, lockfileSha256),
    { dependencyLockSha256: lockfileSha256, sourceRevision: revision },
  );
  assert.throws(
    () =>
      validateCandidateImageMetadata(
        { ...metadata, repoDigests: [] },
        revision,
        lockfileSha256,
      ),
    /not bound/u,
  );
  assert.throws(
    () =>
      validateCandidateImageMetadata(
        metadata,
        'd'.repeat(40),
        lockfileSha256,
      ),
    /source revision/u,
  );
  assert.throws(
    () => validateCandidateImageMetadata(metadata, revision, 'd'.repeat(64)),
    /dependency lock/u,
  );
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
