import type { DatabaseInterface } from '@happyvertical/sql';
import { MATCHING_CANDIDATE_AI_FEATURE } from './ai-config.js';
import { runAsRevalidatedJobWorkspaceSubject } from './job-workspace-subject.js';
import { parseCandidateInterpretation } from './matching-candidate-contract.js';
import {
  chunkMatchingCandidateEvidence,
  estimateMatchingCandidateInterpretation,
  MAX_MATCHING_CANDIDATE_CHUNKS,
  matchingCandidateDraftRequestId,
  matchingCandidateVerificationRequestId,
} from './matching-candidate-interpretation.js';
import {
  matchingCandidateCacheFence,
  matchingCandidateCachePins,
  matchingCandidateEvidenceDigest,
} from './matching-candidate-store.js';
import { splitMatchingCandidateChunk } from './matching-candidate-worker.js';
import {
  loadMatchingCandidateInput,
  loadMatchingVocabulary,
} from './matching-projection-input.js';
import type { MatchingDialect } from './matching-projection-read.js';
import {
  lockCurrentMatchingScope,
  type MatchingProfileScope,
} from './matching-projection-worker.js';

const failedDraft = `
  state = 'failed' AND lease = '' AND split_chunk = -1
  AND draft_json = '' AND chunk_started = FALSE AND next_chunk > 0
  AND payload_json <> ''
`;
const ineligible = { state: 'ineligible' } as const;

function isLocalRecoveryDatabase(url: string, dialect: MatchingDialect) {
  if (dialect === 'sqlite') return true;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Internal operator recovery for a previously observed incomplete
 * draft. A settled receipt proves spend, not completion. Preserve the verified
 * prefix and let the normal worker draft and verify both replacement chunks. */
export async function queueMatchingCandidateDraftRecovery(
  database: DatabaseInterface,
  dialect: MatchingDialect,
  profileId: string,
  options: { observedRequestId: string; dryRun?: boolean },
): Promise<
  | typeof ineligible
  | { state: 'eligible' | 'queued'; chunk: number; reservedSpendMicros: number }
> {
  if (
    !isLocalRecoveryDatabase(database.url, dialect) ||
    !/^[a-f0-9]{64}$/u.test(options.observedRequestId)
  )
    return ineligible;
  if (!database.transaction)
    throw new Error(
      'Candidate interpretation recovery requires native transactions.',
    );

  const {
    rows: [candidate],
  } = await database.query(
    `SELECT x.profile_id, x.tenant_id, x.user_id, x.vocabulary_revision,
            pv.revision AS profile_revision
       FROM matching_candidate_interpretations x
       JOIN matching_profile_versions pv ON pv.profile_id = x.profile_id
       WHERE x.profile_id = ? AND ${failedDraft}`,
    [profileId],
  );
  if (!candidate) return ineligible;
  const scope: MatchingProfileScope = {
    profileId: String(candidate.profile_id),
    tenantId: String(candidate.tenant_id),
    userId: String(candidate.user_id),
    profileRevision: String(candidate.profile_revision),
    vocabularyRevision: String(candidate.vocabulary_revision),
  };
  const transaction = database.transaction.bind(database);
  return runAsRevalidatedJobWorkspaceSubject(scope, 'profile.manage', () =>
    transaction(async (db) => {
      if (
        !(await lockCurrentMatchingScope(db, dialect, scope, {
          exclusive: true,
          reuseAcrossProfileEdits: true,
        }))
      )
        return ineligible;

      const pins = matchingCandidateCachePins(scope);
      const {
        rows: [progress],
      } = await db.query(
        `SELECT input_digest, request_id, next_chunk, payload_json
           FROM matching_candidate_interpretations
           WHERE ${matchingCandidateCacheFence} AND ${failedDraft}`,
        pins,
      );
      if (!progress) return ineligible;
      const input = await loadMatchingCandidateInput(db, scope);
      if (
        !input ||
        matchingCandidateEvidenceDigest(input) !== progress.input_digest
      )
        return ineligible;

      const index = Number(progress.next_chunk);
      if (!Number.isSafeInteger(index) || index < 1) return ineligible;
      const requestId = String(progress.request_id);
      const vocabulary = await loadMatchingVocabulary(db);
      const chunks = chunkMatchingCandidateEvidence(input, vocabulary);
      const original = chunks[index];
      if (!original || chunks.length >= MAX_MATCHING_CANDIDATE_CHUNKS)
        return ineligible;
      try {
        parseCandidateInterpretation(
          JSON.parse(String(progress.payload_json)),
          {
            evidence: chunks.slice(0, index).flatMap((chunk) => chunk.evidence),
          },
          vocabulary,
        );
      } catch {
        return ineligible;
      }

      const draftRequestId = matchingCandidateDraftRequestId({
        subject: scope,
        input: original,
        requestId: `${requestId}-${index}-draft`,
      });
      if (draftRequestId !== options.observedRequestId) return ineligible;
      const verificationRequestId = matchingCandidateVerificationRequestId({
        subject: scope,
        requestId: `${requestId}-${index}-verify`,
      });
      const { rows: receipts } = await db.query(
        `SELECT request_id, status, accounting_basis
           FROM ai_user_spend_entries
           WHERE tenant_id = ? AND owner_user_id = ?
             AND feature = ?
             AND request_id IN (?, ?) LIMIT 3`,
        [
          scope.tenantId,
          scope.userId,
          MATCHING_CANDIDATE_AI_FEATURE,
          draftRequestId,
          verificationRequestId,
        ],
      );
      const [receipt] = receipts;
      if (
        receipts.length !== 1 ||
        receipt?.request_id !== draftRequestId ||
        receipt.status !== 'settled' ||
        receipt.accounting_basis !== 'actual'
      )
        return ineligible;

      const halves = splitMatchingCandidateChunk(original);
      if (!halves) return ineligible;
      const forecasts = halves.map((half) =>
        estimateMatchingCandidateInterpretation(half, vocabulary),
      );
      if (forecasts.some(({ chunks }) => chunks !== 1)) return ineligible;
      const reservedSpendMicros = forecasts.reduce(
        (total, half) => total + half.reservedSpendMicros,
        0,
      );
      if (options.dryRun)
        return { state: 'eligible', chunk: index, reservedSpendMicros };

      const {
        rows: [queued],
      } = await db.query(
        `UPDATE matching_candidate_interpretations
           SET state = 'pending', split_chunk = ?, next_run_at = 0
           WHERE ${matchingCandidateCacheFence} AND ${failedDraft}
             AND input_digest = ? AND request_id = ? AND next_chunk = ?
           RETURNING split_chunk`,
        [index, ...pins, progress.input_digest, requestId, index],
      );
      return queued
        ? { state: 'queued', chunk: index, reservedSpendMicros }
        : ineligible;
    }),
  );
}
