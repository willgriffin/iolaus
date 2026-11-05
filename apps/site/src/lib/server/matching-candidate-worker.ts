import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { isAiUsageRefusedError } from './ai-usage-guard.js';
import { runAsRevalidatedJobWorkspaceSubject } from './job-workspace-subject.js';
import {
  CANDIDATE_INTERPRETATION_POLICY_VERSION,
  type CandidateInterpretation,
  parseCandidateInterpretation,
} from './matching-candidate-contract.js';
import {
  chunkMatchingCandidateEvidence,
  interpretMatchingCandidateChunk,
  MAX_MATCHING_CANDIDATE_CHUNKS,
  MatchingCandidateInterpretationError,
  verifyMatchingCandidateChunk,
} from './matching-candidate-interpretation.js';
import {
  MATCHING_CANDIDATE_CACHE_VERSION,
  matchingCandidateCacheFence,
  matchingCandidateCachePins,
  matchingCandidateEvidenceDigest,
  matchingCandidateInterpretationEnabled,
} from './matching-candidate-store.js';
import {
  loadMatchingCandidateInput,
  loadMatchingVocabulary,
} from './matching-projection-input.js';
import {
  liveMatchingOwnerSql,
  type MatchingDialect,
} from './matching-projection-read.js';
import { advanceMatchingProfileRevision } from './matching-projection-schema.js';
import {
  lockCurrentMatchingScope,
  type MatchingProfileScope,
} from './matching-projection-worker.js';

const LEASE_MS = 180_000;
const PREFLIGHT_RETRY_MS = 60 * 60_000;
const MAX_PREFLIGHT_ATTEMPTS = 3;
// Evidence/ownership edits delete the leased row transactionally. Preferences
// and questions can advance the matching generation without changing the input.
const candidateLock = { exclusive: true, reuseAcrossProfileEdits: true };
type CandidateChunk = ReturnType<typeof chunkMatchingCandidateEvidence>[number];

export function splitMatchingCandidateChunk(chunk: CandidateChunk) {
  if (chunk.evidence.length < 2) return;
  const midpoint = Math.ceil(chunk.evidence.length / 2);
  return [
    { evidence: chunk.evidence.slice(0, midpoint) },
    { evidence: chunk.evidence.slice(midpoint) },
  ] as const;
}

function splitPlanEntry(
  plan: { input: CandidateChunk; key: string }[],
  index: number,
) {
  const original = plan[index];
  const halves = original && splitMatchingCandidateChunk(original.input);
  if (!halves || plan.length >= MAX_MATCHING_CANDIDATE_CHUNKS) return false;
  plan.splice(
    index,
    1,
    { input: halves[0], key: `${original.key}-split-left` },
    { input: halves[1], key: `${original.key}-split-right` },
  );
  return true;
}

type Claim = {
  scope: MatchingProfileScope;
  digest: string;
  requestId: string;
  lease: string;
};
type Dependencies = {
  now?: () => number;
  signal?: AbortSignal;
  interpret?: typeof interpretMatchingCandidateChunk;
  verify?: typeof verifyMatchingCandidateChunk;
  chunk?: typeof chunkMatchingCandidateEvidence;
  asOwner?: <T>(
    scope: MatchingProfileScope,
    work: () => Promise<T>,
  ) => Promise<T>;
};

function asCurrentOwner<T>(
  scope: MatchingProfileScope,
  work: () => Promise<T>,
) {
  return runAsRevalidatedJobWorkspaceSubject(scope, 'profile.manage', work);
}

const currentClaim = `${matchingCandidateCacheFence} AND input_digest = ?
  AND request_id = ? AND lease = ? AND state = 'running' AND next_run_at > CAST(? AS BIGINT)`;

function claimPins(claim: Claim, now: number) {
  return [
    ...matchingCandidateCachePins(claim.scope),
    claim.digest,
    claim.requestId,
    claim.lease,
    now,
  ];
}

async function claimNext(
  db: DatabaseInterface,
  dialect: MatchingDialect,
  now: number,
  profileId?: string,
): Promise<Claim | null> {
  const {
    rows: [row],
  } = await db.query(
    `SELECT x.profile_id, x.tenant_id, x.user_id, x.input_digest, x.request_id,
       x.vocabulary_revision, pv.revision AS profile_revision
     FROM matching_candidate_interpretations x
     JOIN matching_profile_versions pv ON pv.profile_id = x.profile_id
     JOIN candidate_profiles p ON CAST(p.id AS TEXT) = x.profile_id
        AND CAST(p.tenant_id AS TEXT) = x.tenant_id AND p.owner_user_id = x.user_id AND p.active = TRUE
     JOIN matching_vocabulary_version vv ON vv.id = 1 AND vv.revision = x.vocabulary_revision
     WHERE x.state IN ('pending', 'running') AND x.next_run_at <= CAST(? AS BIGINT)
       AND x.policy_version = ? AND x.contract_version = ?
       AND ${liveMatchingOwnerSql('p')}
       ${profileId === undefined ? '' : 'AND x.profile_id = ?'}
     ORDER BY x.next_run_at, x.profile_id LIMIT 1`,
    [
      now,
      CANDIDATE_INTERPRETATION_POLICY_VERSION,
      MATCHING_CANDIDATE_CACHE_VERSION,
      ...(profileId === undefined ? [] : [profileId]),
    ],
  );
  if (!row) return null;
  const scope = {
    profileId: String(row.profile_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    vocabularyRevision: String(row.vocabulary_revision),
    profileRevision: String(row.profile_revision),
  };
  if (!(await lockCurrentMatchingScope(db, dialect, scope, candidateLock)))
    return null;
  const lease = randomUUID();
  const digest = String(row.input_digest);
  const requestId = String(row.request_id);
  const {
    rows: [updated],
  } = await db.query(
    `UPDATE matching_candidate_interpretations
     SET state = CASE WHEN chunk_started THEN 'failed' ELSE 'running' END,
         lease = ?, next_run_at = CAST(? AS BIGINT),
         draft_json = CASE WHEN chunk_started THEN '' ELSE draft_json END
     WHERE ${matchingCandidateCacheFence} AND input_digest = ? AND request_id = ?
       AND state IN ('pending', 'running') AND next_run_at <= CAST(? AS BIGINT)
     RETURNING state`,
    [
      lease,
      now + LEASE_MS,
      ...matchingCandidateCachePins(scope),
      digest,
      requestId,
      now,
    ],
  );
  if (!updated) return null;
  if (updated.state === 'failed') {
    // A crashed worker may already have submitted the chunk. The provider
    // cannot deduplicate an ambiguous retry, so surface a terminal state.
    await advanceMatchingProfileRevision(db, dialect, scope.profileId);
    return null;
  }
  return {
    scope,
    digest,
    requestId,
    lease,
  };
}

/**
 * Interpret one evidence revision outside all database transactions. Every
 * capture, paid boundary, checkpoint and publication is fenced by the live
 * owner, source generation and lease. Failed or uncertain input stays visible
 * as interpretation state and never turns into a negative assertion.
 */
export async function runMatchingCandidateInterpretation(
  database: DatabaseInterface,
  dialect: MatchingDialect,
  options: { profileId?: string } & Dependencies = {},
): Promise<'idle' | 'complete' | 'failed' | 'stale' | 'retry'> {
  if (options.signal?.aborted) return 'idle';
  if (!database.transaction)
    throw new Error('Candidate interpretation requires native transactions.');
  const transaction = database.transaction.bind(database);
  const now = options.now ?? Date.now;
  const asOwner = options.asOwner ?? asCurrentOwner;
  const claimed = await transaction((db) =>
    claimNext(db, dialect, now(), options.profileId),
  );
  if (!claimed) return 'idle';
  const claim = claimed;
  const { scope } = claim;

  async function finish(
    state: 'complete' | 'failed',
    payload?: CandidateInterpretation,
  ) {
    return await transaction(async (db) => {
      if (!(await lockCurrentMatchingScope(db, dialect, scope, candidateLock)))
        return false;
      const { rows } = await db.query(
        `UPDATE matching_candidate_interpretations
         SET state = ?, payload_json = COALESCE(?, payload_json), draft_json = '', lease = '', chunk_started = FALSE
         WHERE ${currentClaim} RETURNING profile_id`,
        [
          state,
          payload ? JSON.stringify(payload) : null,
          ...claimPins(claim, now()),
        ],
      );
      if (!rows.length) return false;
      await advanceMatchingProfileRevision(db, dialect, scope.profileId);
      return true;
    });
  }

  async function updateChunk(
    index: number,
    update: string,
    values: unknown[],
    phase: 'draft' | 'verify',
    started: boolean,
  ) {
    return await transaction(async (db) => {
      if (!(await lockCurrentMatchingScope(db, dialect, scope, candidateLock)))
        return false;
      const { rows } = await db.query(
        `UPDATE matching_candidate_interpretations SET ${update}
         WHERE ${currentClaim} AND next_chunk = ?
         AND draft_json ${phase === 'draft' ? '=' : '<>'} ''
         AND ${started ? 'chunk_started' : 'NOT chunk_started'} RETURNING profile_id`,
        [...values, ...claimPins(claim, now()), index],
      );
      return rows.length === 1;
    });
  }

  async function markStarted(index: number, phase: 'draft' | 'verify') {
    await asOwner(scope, async () => {
      const marked = await updateChunk(
        index,
        'chunk_started = TRUE, next_run_at = CAST(? AS BIGINT)',
        [now() + LEASE_MS],
        phase,
        false,
      );
      if (!marked)
        throw new Error('Candidate interpretation is no longer current.');
    });
  }

  try {
    return await asOwner(scope, async () => {
      const capture = await transaction(async (db) => {
        if (
          !(await lockCurrentMatchingScope(db, dialect, scope, candidateLock))
        )
          return null;
        const input = await loadMatchingCandidateInput(db, scope);
        if (!input || matchingCandidateEvidenceDigest(input) !== claim.digest)
          return null;
        const {
          rows: [progress],
        } = await db.query(
          `SELECT payload_json, draft_json, next_chunk, split_chunk FROM matching_candidate_interpretations WHERE ${currentClaim}`,
          claimPins(claim, now()),
        );
        if (!progress) return null;
        return {
          input,
          vocabulary: await loadMatchingVocabulary(db),
          progress,
        };
      });
      if (!capture) return 'stale';
      const { input, vocabulary, progress } = capture;
      const chunks = (options.chunk ?? chunkMatchingCandidateEvidence)(
        input,
        vocabulary,
      ).map((chunk, index) => ({ input: chunk, key: String(index) }));
      const aggregate: CandidateInterpretation = progress.payload_json
        ? JSON.parse(String(progress.payload_json))
        : { assertions: [], reviewedSourceIds: [], unresolvedSourceIds: [] };

      const firstChunk = Number(progress.next_chunk);
      let splitIndex = Number(progress.split_chunk);
      if (
        splitIndex !== -1 &&
        (!Number.isSafeInteger(splitIndex) ||
          splitIndex < 0 ||
          splitIndex > firstChunk ||
          !splitPlanEntry(chunks, splitIndex))
      )
        throw new Error('Candidate interpretation checkpoint is invalid.');
      for (let index = firstChunk; index < chunks.length; index += 1) {
        options.signal?.throwIfAborted();
        const { input: chunk, key } = chunks[index];
        const request = {
          subject: scope,
          input: chunk,
          vocabulary,
          signal: options.signal,
        };
        let draft: CandidateInterpretation;
        if (index === firstChunk && progress.draft_json) {
          draft = parseCandidateInterpretation(
            JSON.parse(String(progress.draft_json)),
            chunk,
            vocabulary,
          );
        } else {
          try {
            const result = await (
              options.interpret ?? interpretMatchingCandidateChunk
            )({
              ...request,
              requestId: `${claim.requestId}-${key}-draft`,
              revalidate: () => markStarted(index, 'draft'),
            });
            draft = result.interpretation;
          } catch (error) {
            if (
              splitIndex !== -1 ||
              !(error instanceof MatchingCandidateInterpretationError) ||
              error.code !== 'candidate_interpretation_provider_incomplete' ||
              error.detail !== 'response_length' ||
              !splitPlanEntry(chunks, index)
            )
              throw error;
            const saved = await updateChunk(
              index,
              'split_chunk = ?, chunk_started = FALSE, next_run_at = CAST(? AS BIGINT)',
              [index, now() + LEASE_MS],
              'draft',
              true,
            );
            if (!saved) return 'stale';
            splitIndex = index;
            index -= 1;
            continue;
          }
          const saved = await updateChunk(
            index,
            'draft_json = ?, chunk_started = FALSE, preflight_attempts = 0, next_run_at = CAST(? AS BIGINT)',
            [JSON.stringify(draft), now() + LEASE_MS],
            'draft',
            true,
          );
          if (!saved) return 'stale';
        }
        const { interpretation } = await (
          options.verify ?? verifyMatchingCandidateChunk
        )({
          ...request,
          requestId: `${claim.requestId}-${key}-verify`,
          revalidate: () => markStarted(index, 'verify'),
          draft,
        });
        aggregate.assertions.push(...interpretation.assertions);
        aggregate.reviewedSourceIds.push(...interpretation.reviewedSourceIds);
        aggregate.unresolvedSourceIds.push(
          ...interpretation.unresolvedSourceIds,
        );
        const saved = await updateChunk(
          index,
          "payload_json = ?, draft_json = '', next_chunk = ?, chunk_started = FALSE, preflight_attempts = 0, next_run_at = CAST(? AS BIGINT)",
          [JSON.stringify(aggregate), index + 1, now() + LEASE_MS],
          'verify',
          true,
        );
        if (!saved) return 'stale';
      }

      const interpretation = parseCandidateInterpretation(
        aggregate,
        input,
        vocabulary,
      );
      const published = await asOwner(scope, () =>
        finish('complete', interpretation),
      );
      return published ? 'complete' : 'stale';
    });
  } catch (error) {
    const interrupted = options.signal?.aborted === true;
    const retryable =
      interrupted ||
      (isAiUsageRefusedError(error) &&
        [
          'user_budget_exhausted',
          'user_budget_unavailable',
          'ai_disabled',
        ].includes(error.code)) ||
      (error instanceof MatchingCandidateInterpretationError &&
        error.code === 'candidate_interpretation_profile_unavailable');
    if (retryable) {
      const retry = await transaction(async (db) => {
        if (
          !(await lockCurrentMatchingScope(db, dialect, scope, candidateLock))
        )
          return false;
        const { rows } = await db.query(
          `UPDATE matching_candidate_interpretations SET state = 'pending', lease = '',
             next_run_at = CAST(? AS BIGINT), preflight_attempts = preflight_attempts + ?
           WHERE ${currentClaim} AND NOT chunk_started AND (? = 0 OR preflight_attempts < ?)
           RETURNING profile_id`,
          [
            interrupted ? 0 : now() + PREFLIGHT_RETRY_MS,
            interrupted ? 0 : 1,
            ...claimPins(claim, now()),
            interrupted ? 0 : 1,
            MAX_PREFLIGHT_ATTEMPTS - 1,
          ],
        );
        return rows.length === 1;
      });
      if (retry) return 'retry';
    }
    // Provider and source details are deliberately excluded. A known failed
    // revision gets a distinct product state without repeated paid attempts.
    return (await finish('failed')) ? 'failed' : 'stale';
  }
}

export function startMatchingCandidateInterpretationWorker(
  database: DatabaseInterface,
  dialect: MatchingDialect,
) {
  if (!matchingCandidateInterpretationEnabled()) return async () => {};
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  let current: Promise<void>;
  function tick() {
    current = (async () => {
      let delay = 15_000;
      try {
        if (
          (await runMatchingCandidateInterpretation(database, dialect, {
            signal: controller.signal,
          })) === 'complete'
        )
          delay = 1000;
      } catch {
        console.error(
          'Candidate interpretation worker could not process its queue.',
        );
      }
      if (!stopped) timer = setTimeout(tick, delay);
    })();
  }
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    await current;
  };
}
