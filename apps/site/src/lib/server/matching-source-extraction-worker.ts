import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { matchingPostingInput } from './matching-projection-input.js';
import {
  liveMatchingOpportunitySql,
  type MatchingDialect,
} from './matching-projection-read.js';
import { advanceMatchingSourceRevision } from './matching-projection-schema.js';
import {
  extractMatchingSource,
  MATCHING_SOURCE_EXTRACTION_VERSION,
  parseMatchingSourceExtraction,
} from './matching-source-extraction.js';
import { MatchingSourceExtractionError } from './matching-source-extraction-contract.js';
import {
  matchingSourceCaptureDigest,
  matchingSourceDecisionRequestId,
} from './matching-source-identity.js';
import type { MatchingSourceDecisionProfile } from './matching-source-semantics.js';
import { MATCHING_POLICY_VERSION } from './normalized-matching.js';
import { OpportunityIntelligenceGovernanceError } from './opportunity-intelligence-governance.js';

const SCAN_BATCH = 24;
const LEASE_MS = 180_000;
const MAX_ATTEMPTS = 3;
type Row = Record<string, unknown>;
type Provider = (
  input: Parameters<typeof extractMatchingSource>[0] & {
    workplaceType?: string;
  },
  options: Parameters<typeof extractMatchingSource>[1],
) => ReturnType<typeof extractMatchingSource>;

function text(value: unknown) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function needsInterpretation(row: Row): boolean {
  try {
    const snapshot = JSON.parse(text(row.facts_json)) as {
      uncertainties?: unknown[];
    };
    return Boolean(snapshot.uncertainties?.length);
  } catch {
    return false;
  }
}

async function claimSourceExtraction(
  database: DatabaseInterface,
  dialect: MatchingDialect,
  opportunityId?: string,
  decisionRequestId?: string,
) {
  if (!database.transaction)
    throw new Error('Source extraction requires native transactions.');
  return database.transaction(async (db) => {
    const {
      rows: [cursor],
    } = await db.query(
      'UPDATE matching_source_extraction_cursor SET id=id WHERE id=1 RETURNING work_cursor',
    );
    if (!cursor)
      throw new Error('Source extraction schema is not initialized.');
    const { rows: candidates } = await db.query(
      `
      WITH page AS (
        SELECT opportunity_id, work_revision, source_revision, vocabulary_revision,
          source_listing_revision, facts_json, policy_version
        FROM matching_source_facts WHERE ${opportunityId ? 'opportunity_id = ?' : 'work_revision > CAST(? AS BIGINT)'}
        ORDER BY work_revision LIMIT ${SCAN_BATCH}
      )
      SELECT f.opportunity_id, f.work_revision, f.facts_json, sv.revision AS source_revision, sl.revision AS listing_revision,
        o.source_content_fingerprint, o.source_content_version, o.source_content_json,
        o.title, o.description_raw, o.locations, o.location_notes, o.work_mode,
        CASE WHEN vv.revision = f.vocabulary_revision AND f.policy_version = ?
          AND sv.revision = f.source_revision AND sl.revision = f.source_listing_revision
          AND s.is_active = TRUE AND s.public_listing = TRUE AND ${liveMatchingOpportunitySql('o', dialect)}
        THEN 1 ELSE 0 END AS eligible,
        x.attempts AS previous_attempts, x.state AS previous_state, x.next_run_at, x.input_digest, x.request_id AS previous_request_id, x.payload_json AS previous_payload
      FROM page f
      JOIN matching_vocabulary_version vv ON vv.id=1
      JOIN matching_source_versions sv ON sv.opportunity_id=f.opportunity_id
      JOIN opportunities o ON CAST(o.id AS TEXT)=f.opportunity_id
      LEFT JOIN sources s ON s.id=o.source_id
      LEFT JOIN matching_source_listing_versions sl ON sl.source_id=s.id
      LEFT JOIN matching_source_interpretations x ON x.opportunity_id=f.opportunity_id
        AND x.contract_version=? AND x.source_fingerprint=o.source_content_fingerprint
        AND x.source_content_version=o.source_content_version
      ORDER BY f.work_revision
    `,
      [
        opportunityId ?? text(cursor.work_cursor),
        MATCHING_POLICY_VERSION,
        MATCHING_SOURCE_EXTRACTION_VERSION,
      ],
    );
    const now = Date.now();
    const sameCapture = (row: Row) =>
      row.input_digest ===
        matchingSourceCaptureDigest(row.source_content_json) &&
      (decisionRequestId === undefined ||
        row.previous_request_id === decisionRequestId);
    const selected = candidates.find(
      (row) =>
        Number(row.eligible) === 1 &&
        /^[a-f0-9]{64}$/u.test(text(row.source_content_fingerprint)) &&
        Number(row.source_content_version) > 0 &&
        (opportunityId !== undefined || needsInterpretation(row)) &&
        (!decisionRequestId ||
          row.previous_state !== 'running' ||
          Number(row.next_run_at) <= now) &&
        (!sameCapture(row) ||
          (!['complete', 'failed'].includes(text(row.previous_state)) &&
            Number(row.previous_attempts ?? 0) < MAX_ATTEMPTS &&
            Number(row.next_run_at ?? 0) <= now)),
    );
    if (!opportunityId) {
      await db.query(
        'UPDATE matching_source_extraction_cursor SET work_cursor=CAST(? AS BIGINT) WHERE id=1',
        [
          text(
            selected?.work_revision ?? candidates.at(-1)?.work_revision ?? 0,
          ),
        ],
      );
    }
    if (!selected) return null;
    const posting = matchingPostingInput(selected);
    if (!posting.title || !posting.description) return null;
    const {
      rows: [current],
    } = await db.query(
      `
      SELECT sv.opportunity_id FROM matching_source_versions sv
      JOIN opportunities o ON CAST(o.id AS TEXT)=sv.opportunity_id
      JOIN sources s ON s.id=o.source_id AND s.is_active=TRUE AND s.public_listing=TRUE
      JOIN matching_source_listing_versions sl ON sl.source_id=s.id
      WHERE sv.opportunity_id=? AND sv.revision=CAST(? AS BIGINT)
        AND sl.revision=CAST(? AS BIGINT) AND ${liveMatchingOpportunitySql('o', dialect)}
      ${dialect === 'postgres' ? 'FOR SHARE OF sv, sl' : ''}
    `,
      [
        selected.opportunity_id,
        selected.source_revision,
        selected.listing_revision,
      ],
    );
    if (!current) return null;
    const lease = randomUUID();
    const attempt =
      (sameCapture(selected) ? Number(selected.previous_attempts ?? 0) : 0) + 1;
    const capture = text(selected.source_content_json);
    const inputDigest = matchingSourceCaptureDigest(capture);
    const input: Parameters<Provider>[0] = {
      opportunityId: text(selected.opportunity_id),
      sourceContentFingerprint: text(selected.source_content_fingerprint),
      sourceContentVersion: Number(selected.source_content_version),
      title: posting.title,
      description: posting.description,
      location: posting.location,
      ...(decisionRequestId &&
        posting.workplaceType && { workplaceType: posting.workplaceType }),
    };
    await db.query(
      `
      INSERT INTO matching_source_interpretations(
        opportunity_id, source_fingerprint, source_content_version, contract_version, input_digest,
        state, lease, next_run_at, attempts, payload_json, request_id
      ) VALUES (?, ?, CAST(? AS BIGINT), ?, ?, 'running', ?, CAST(? AS BIGINT), ?, '', ?)
      ON CONFLICT(opportunity_id) DO UPDATE SET
        source_fingerprint=excluded.source_fingerprint, source_content_version=excluded.source_content_version,
        contract_version=excluded.contract_version, input_digest=excluded.input_digest, state=excluded.state, lease=excluded.lease,
        next_run_at=excluded.next_run_at, attempts=excluded.attempts, payload_json='', request_id=excluded.request_id
    `,
      [
        input.opportunityId,
        input.sourceContentFingerprint,
        input.sourceContentVersion,
        MATCHING_SOURCE_EXTRACTION_VERSION,
        inputDigest,
        lease,
        now + LEASE_MS,
        attempt,
        decisionRequestId ?? '',
      ],
    );
    return {
      lease,
      attempt,
      input,
      capture,
      sourceRevision: text(selected.source_revision),
      listingRevision: text(selected.listing_revision),
      prior:
        decisionRequestId &&
        selected.previous_state === 'complete' &&
        selected.input_digest === inputDigest &&
        selected.previous_payload
          ? {
              payload: text(selected.previous_payload),
              requestId: text(selected.previous_request_id),
              attempts: Number(selected.previous_attempts),
            }
          : undefined,
    };
  });
}

/**
 * Claim a single shared posting, call the governed provider outside the
 * transaction, and attach only to the exact live source version. Both the
 * cheap worker and provider-free local run use the same persisted output.
 */
export async function runMatchingSourceExtraction(
  database: DatabaseInterface,
  dialect: MatchingDialect,
  budgetMicros: number,
  options: {
    opportunityId?: string;
    windowId?: string;
    provider?: Provider;
    decisionProfile?: MatchingSourceDecisionProfile;
    onFailure?: (kind: string) => void;
    onDiagnostic?: (kind: string) => void;
  } = {},
): Promise<'idle' | 'published' | 'obsolete' | 'retry'> {
  if (!database.transaction)
    throw new Error('Source extraction requires native transactions.');
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros <= 0)
    throw new Error('Source extraction requires a positive integer budget.');
  if (options.decisionProfile && (!options.provider || !options.opportunityId))
    throw new Error(
      'Decision publication requires an explicit provider and posting.',
    );
  const decisionRequestId =
    options.decisionProfile &&
    matchingSourceDecisionRequestId(options.decisionProfile);
  const claimed = await claimSourceExtraction(
    database,
    dialect,
    options.opportunityId,
    decisionRequestId,
  );
  if (!claimed) return 'idle';
  const {
    input,
    lease,
    attempt,
    capture,
    sourceRevision,
    listingRevision,
    prior,
  } = claimed;
  const provider = options.provider ?? extractMatchingSource;
  const retainPrior = async () => {
    if (!prior) return false;
    const { rows } = await database.query(
      `UPDATE matching_source_interpretations
       SET state='complete', lease='', next_run_at=0, attempts=?, payload_json=?, request_id=?
       WHERE opportunity_id=? AND lease=? AND state='running'
       RETURNING opportunity_id`,
      [
        prior.attempts,
        prior.payload,
        prior.requestId,
        input.opportunityId,
        lease,
      ],
    );
    return rows.length > 0;
  };
  try {
    const output = await provider(input, {
      budgetMicros,
      ...(options.windowId === undefined ? {} : { windowId: options.windowId }),
    });
    if (decisionRequestId) {
      const incoming = parseMatchingSourceExtraction(output.extraction, input);
      const provenance = incoming.semantic?.decision;
      if (
        !provenance ||
        matchingSourceDecisionRequestId(provenance) !== decisionRequestId
      )
        throw new MatchingSourceExtractionError('matching_extraction_coverage');
      if (prior) {
        const previous = parseMatchingSourceExtraction(
          JSON.parse(prior.payload),
          input,
        );
        const countVerified = (extraction: typeof previous) =>
          extraction.semantic?.verification.units.filter(
            ({
              classificationCorrect,
              allConditionsRepresented,
              logicAndQualifiersPreserved,
            }) =>
              classificationCorrect &&
              allConditionsRepresented &&
              logicAndQualifiersPreserved,
          ).length ?? 0;
        if (
          previous.coverage === 'complete' ||
          countVerified(previous) > countVerified(incoming) ||
          (previous.semantic?.verification.roleCorrect &&
            !incoming.semantic?.verification.roleCorrect) ||
          (previous.semantic?.verification.geographyCorrect &&
            !incoming.semantic?.verification.geographyCorrect)
        ) {
          options.onFailure?.('PriorEvidenceRetained');
          return (await retainPrior()) ? 'idle' : 'obsolete';
        }
      }
    }
    for (const diagnostic of output.diagnostics ?? [])
      options.onDiagnostic?.(diagnostic);
    for (const { field, issue } of output.schemaDiagnostics ?? [])
      options.onDiagnostic?.(`schema:${field}:${issue}`);
    return await database.transaction(async (db) => {
      if (dialect === 'sqlite')
        await db.query(
          'UPDATE matching_source_extraction_cursor SET id=id WHERE id=1',
        );
      // Source triggers acquire this same version row before committing raw
      // changes or deleting a posting. Use the same lock order before output.
      const {
        rows: [current],
      } = await db.query(
        `
        SELECT sv.opportunity_id FROM matching_source_versions sv
        JOIN opportunities o ON CAST(o.id AS TEXT)=sv.opportunity_id
        JOIN sources s ON s.id=o.source_id AND s.is_active=TRUE AND s.public_listing=TRUE
        JOIN matching_source_listing_versions sl ON sl.source_id=s.id
        WHERE sv.opportunity_id=? AND o.source_content_fingerprint=?
          AND o.source_content_version=CAST(? AS BIGINT) AND o.source_content_json=?
          AND sv.revision=CAST(? AS BIGINT) AND sl.revision=CAST(? AS BIGINT)
          AND ${liveMatchingOpportunitySql('o', dialect)}
        ${dialect === 'postgres' ? 'FOR UPDATE OF sv FOR SHARE OF sl' : ''}
      `,
        [
          input.opportunityId,
          input.sourceContentFingerprint,
          input.sourceContentVersion,
          capture,
          sourceRevision,
          listingRevision,
        ],
      );
      if (!current) {
        await db.query(
          `UPDATE matching_source_interpretations SET
          state='retry', lease='', next_run_at=0, attempts=attempts-1
          WHERE opportunity_id=? AND lease=? AND state='running'`,
          [input.opportunityId, lease],
        );
        return 'obsolete' as const;
      }
      const {
        rows: [saved],
      } = await db.query(
        `
        UPDATE matching_source_interpretations SET
          state='complete', lease='', next_run_at=0, payload_json=?, request_id=?
        WHERE opportunity_id=? AND lease=? AND state='running' RETURNING opportunity_id
      `,
        [
          JSON.stringify(output.extraction),
          decisionRequestId ?? output.requestId ?? '',
          input.opportunityId,
          lease,
        ],
      );
      if (!saved) return 'obsolete' as const;
      await advanceMatchingSourceRevision(db, dialect, input.opportunityId);
      return 'published' as const;
    });
  } catch (cause) {
    const type = cause instanceof Error ? cause.constructor.name : '';
    const classification =
      cause instanceof MatchingSourceExtractionError
        ? cause.code
        : cause instanceof OpportunityIntelligenceGovernanceError
          ? `Governance:${cause.code}`
          : ['ZodError', 'DatabaseError'].includes(type)
            ? type
            : cause instanceof Error &&
                cause.message ===
                  'Pinned matching extraction model is unavailable.'
              ? 'PinnedModelUnavailable'
              : cause instanceof Error &&
                  cause.message ===
                    'Matching extraction exceeds the input token ceiling.'
                ? 'InputCeiling'
                : 'ProviderOrConfigurationError';
    options.onFailure?.(classification);
    if (await retainPrior()) return 'retry';
    // Admission refusals did not invoke the provider. Keep the source
    // retryable when an hourly cap, circuit, or pending duplicate clears.
    const admissionRefused =
      cause instanceof OpportunityIntelligenceGovernanceError &&
      [
        'budget_exhausted',
        'budget_missing',
        'circuit_open',
        'disabled',
        'duplicate_in_progress',
        'pricing_missing',
      ].includes(cause.code);
    const waitMs = admissionRefused ? 15 * 60_000 : 60_000 * attempt;
    await database.query(
      `
      UPDATE matching_source_interpretations SET state=?, lease='', next_run_at=CAST(? AS BIGINT),
        attempts=?
      WHERE opportunity_id=? AND lease=? AND state='running'
    `,
      [
        !admissionRefused && attempt >= MAX_ATTEMPTS ? 'failed' : 'retry',
        Date.now() + waitMs,
        admissionRefused ? attempt - 1 : attempt,
        input.opportunityId,
        lease,
      ],
    );
    return 'retry';
  }
}

/** Explicit opt-in for the separate, candidate-free paid source pass. */
export function startMatchingSourceExtractionWorker(
  database: DatabaseInterface,
  dialect: MatchingDialect,
) {
  if (process.env.IOLAUS_MATCHING_SOURCE_EXTRACTION !== '1')
    return async () => {};
  const budgetMicros = Number(
    process.env.IOLAUS_MATCHING_SOURCE_EXTRACTION_HOURLY_MICROS,
  );
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros <= 0)
    throw new Error(
      'Set an hourly matching source extraction budget before enabling the worker.',
    );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const loop = () => {
    if (stopped) return;
    active = (async () => {
      try {
        await runMatchingSourceExtraction(database, dialect, budgetMicros);
      } catch {
        console.error(
          'Matching source interpretation could not process a posting; it will retry.',
        );
      }
      if (!stopped) timer = setTimeout(loop, 15_000);
    })();
  };
  loop();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await active;
  };
}
