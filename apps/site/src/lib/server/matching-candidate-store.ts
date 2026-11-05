import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  CANDIDATE_INTERPRETATION_POLICY_VERSION,
  CANDIDATE_INTERPRETATION_PROMPT_VERSION,
  CANDIDATE_INTERPRETATION_VERSION,
  type CandidateInterpretationState,
  candidateInterpretationSchema,
} from './matching-candidate-contract.js';
import type { MatchingProfileScope } from './matching-projection-worker.js';
import type { MatchingCandidateInput } from './normalized-matching.js';

export const MATCHING_CANDIDATE_CACHE_VERSION = `${CANDIDATE_INTERPRETATION_VERSION}:${CANDIDATE_INTERPRETATION_PROMPT_VERSION}`;

export function matchingCandidateInterpretationEnabled() {
  return (
    process.env.IOLAUS_MATCHING_CANDIDATE_INTERPRETATION_ENABLED === 'true'
  );
}

export function matchingCandidateEvidenceDigest(
  input: Pick<MatchingCandidateInput, 'evidence'>,
) {
  return createHash('sha256')
    .update(JSON.stringify(input.evidence))
    .digest('hex');
}

export function matchingCandidateCachePins(scope: MatchingProfileScope) {
  return [
    scope.profileId,
    scope.tenantId,
    scope.userId,
    scope.vocabularyRevision,
    CANDIDATE_INTERPRETATION_POLICY_VERSION,
    MATCHING_CANDIDATE_CACHE_VERSION,
  ];
}

export const matchingCandidateCacheFence = `
  profile_id = ? AND tenant_id = ? AND user_id = ?
  AND vocabulary_revision = CAST(? AS BIGINT) AND policy_version = ? AND contract_version = ?
`;

/** Called under the cheap worker's current profile fence. The queue contains
 * a version pin only; the paid worker re-reads the evidence after authorizing. */
export async function candidateInterpretationForMatching(
  db: DatabaseInterface,
  scope: MatchingProfileScope,
  input: MatchingCandidateInput,
): Promise<CandidateInterpretationState | undefined> {
  if (!input.evidence.length) return;
  const digest = matchingCandidateEvidenceDigest(input);
  const {
    rows: [cached],
  } = await db.query(
    `SELECT state, payload_json FROM matching_candidate_interpretations
     WHERE ${matchingCandidateCacheFence} AND input_digest = ?`,
    [...matchingCandidateCachePins(scope), digest],
  );
  if (cached?.state === 'complete') {
    try {
      return {
        state: 'complete',
        interpretation: JSON.parse(String(cached.payload_json)),
      };
    } catch {
      return { state: 'failed' };
    }
  }
  if (cached?.state === 'failed') {
    if (!cached.payload_json) return { state: 'failed' };
    try {
      // A terminal later phase must not turn already verified assertions
      // into missing evidence. Explicitly mark every unprocessed source.
      const interpretation = candidateInterpretationSchema.parse(
        JSON.parse(String(cached.payload_json)),
      );
      const accounted = new Set([
        ...interpretation.reviewedSourceIds,
        ...interpretation.unresolvedSourceIds,
      ]);
      for (const { id } of input.evidence)
        if (!accounted.has(id)) interpretation.unresolvedSourceIds.push(id);
      return { state: 'failed', interpretation };
    } catch {
      return { state: 'failed' };
    }
  }
  const pending = matchingCandidateInterpretationEnabled()
    ? ({ state: 'pending' } as const)
    : undefined;
  if (cached) return pending;

  await db.query(
    `INSERT INTO matching_candidate_interpretations (
      profile_id, tenant_id, user_id, vocabulary_revision, policy_version, contract_version,
      input_digest, request_id, state
    ) VALUES (?, ?, ?, CAST(? AS BIGINT), ?, ?, ?, ?, 'pending')
    ON CONFLICT (profile_id) DO UPDATE SET
      tenant_id=excluded.tenant_id, user_id=excluded.user_id, vocabulary_revision=excluded.vocabulary_revision,
      policy_version=excluded.policy_version, contract_version=excluded.contract_version,
      input_digest=excluded.input_digest, request_id=excluded.request_id,
      state='pending', lease='', next_run_at=0, payload_json='', draft_json='', next_chunk=0, split_chunk=-1, chunk_started=FALSE, preflight_attempts=0`,
    [...matchingCandidateCachePins(scope), digest, randomUUID()],
  );
  return pending;
}
