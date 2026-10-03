import { createHash } from 'node:crypto';
import type { DecisionResult } from '@happyvertical/ai';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';
import {
  OPPORTUNITY_SCREENING_SUPPORTED_VERSIONS,
  type OpportunityScreeningResult,
  type OpportunityScreeningVersion,
  prepareOpportunityScreening,
  resolveOpportunityScreening,
} from './opportunity-screening.js';
import {
  candidateProfileWhere,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getCollection } from './smrt.js';

type Row = Record<string, unknown>;
export const OPPORTUNITY_SCREENING_PROJECTION_PAGE_LIMIT = 100;
export const OPPORTUNITY_SCREENING_RECEIPT_FEATURE = 'opportunity-screening';
export const OPPORTUNITY_SCREENING_RECEIPT_PROFILE =
  'typesafe-opportunity-screening';
export { OPPORTUNITY_SCREENING_SUPPORTED_VERSIONS } from './opportunity-screening.js';
export interface OpportunityScreeningProjection {
  version: 'opportunity-screening-projection/v1';
  mode: 'coarse_screen';
  sourceStatus: 'current';
  status: OpportunityScreeningResult['status'];
  /** Query owners must preserve human decisions and apply exclusions before pagination. */
  excludeFromDefaultTriage: boolean;
  requestId: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  sourceFingerprint: string;
  profileFingerprint: string;
  inputFingerprint: string;
  evidence: OpportunityScreeningResult['evidence'];
  conditionalPaths: OpportunityScreeningResult['conditionalPaths'];
  uncertainties: string[];
  holdReasons: string[];
}
export interface OpportunityScreeningProjectionDependencies {
  getProfile?: (id: string) => Promise<Row | null>;
  database?: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>;
  };
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function natural(value: unknown): number | undefined {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^\d+$/u.test(value))
  )
    return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
function positive(value: unknown) {
  const number = natural(value);
  return number !== undefined && number > 0 ? number : undefined;
}
function boundedRun(row: Row): boolean {
  if (
    !positive(row.run_actual_calls) ||
    natural(row.run_actual_output_tokens) === undefined
  )
    return false;
  return (
    [
      ['run_calls', 'run_actual_calls', 'run_call_limit', 4],
      ['run_tokens', 'run_actual_tokens', 'run_token_limit', 80000],
      ['run_spend', 'run_actual_spend', 'run_spend_limit', 100000],
    ] as const
  ).every(([reserved, actual, limit, maximum]) => {
    const pending = natural(row[reserved]),
      settled = natural(row[actual]),
      configured = positive(row[limit]);
    return (
      pending !== undefined &&
      settled !== undefined &&
      configured !== undefined &&
      Number.isSafeInteger(pending + settled) &&
      pending + settled <= Math.min(configured, maximum)
    );
  });
}
function model(): string {
  return (
    process.env.OPPORTUNITY_ASSESSMENT_DECISION_MODEL?.trim() ||
    process.env.OPPORTUNITY_SKILL_DECISION_MODEL?.trim() ||
    'jev-latest'
  );
}
/** Reconstruct only the joined native receipt; cached screen JSON is never input. */
function projectRow(
  row: Row,
  profile: Row,
  subject: WorkspaceSubject,
): OpportunityScreeningProjection | undefined {
  try {
    if (
      typeof row.opportunity_id !== 'string' ||
      !row.opportunity_id ||
      row.current_opportunity_id !== row.opportunity_id
    )
      return undefined;
    if (
      !OPPORTUNITY_SCREENING_SUPPORTED_VERSIONS.some(
        (version) => version === row.output_schema_version,
      )
    )
      return undefined;
    const version = row.output_schema_version as OpportunityScreeningVersion;
    const prepared = prepareOpportunityScreening(
      {
        sourceContentJson: String(row.current_source_content_json ?? ''),
        sourceContentFingerprint: String(
          row.current_source_content_fingerprint ?? '',
        ),
        sourceContentVersion: Number(row.current_source_content_version),
        profile,
      },
      { version },
    );
    const expectedInput = hash({
      version: prepared.version,
      opportunityId: row.opportunity_id,
      subject,
      prepared: prepared.inputFingerprint,
    });
    if (
      typeof row.request_id !== 'string' ||
      !row.request_id ||
      typeof row.agent_run_id !== 'string' ||
      !row.agent_run_id ||
      row.owner_request_id !== row.request_id ||
      row.result_request_id !== row.request_id ||
      !row.result_key ||
      row.result_key !== row.request_key ||
      row.content_fingerprint !==
        prepared.sourceIdentity.sourceContentFingerprint ||
      row.input_fingerprint !== expectedInput ||
      row.feature !== OPPORTUNITY_SCREENING_RECEIPT_FEATURE ||
      row.profile !== OPPORTUNITY_SCREENING_RECEIPT_PROFILE ||
      row.model !== model() ||
      row.prompt_version !== prepared.version ||
      row.output_schema_version !== prepared.version ||
      row.prepared_payload_version !== prepared.version ||
      row.result_status !== 'completed' ||
      row.request_status !== 'succeeded' ||
      row.accounting_basis !== 'actual' ||
      !positive(row.actual_total_tokens) ||
      row.run_opportunity_id !== row.opportunity_id ||
      !boundedRun(row) ||
      positive(row.reserved_input_tokens) !== prepared.requestBytes ||
      positive(row.requested_max_output_tokens) !== prepared.maxOutputTokens ||
      !positive(row.reserved_spend_micros)
    )
      return undefined;
    for (const [field, expected] of [
      ['tenant_id', subject.tenantId],
      ['owner_user_id', subject.userId],
      ['candidate_profile_id', subject.profileId],
    ] as const)
      if (
        row[field] !== expected ||
        row[`request_${field}`] !== expected ||
        row[`run_${field}`] !== expected
      )
        return undefined;
    const decision = JSON.parse(String(row.output_json)) as DecisionResult;
    if (decision.model !== model() || decision.provenance?.model !== model())
      return undefined;
    const screen = resolveOpportunityScreening(
      prepared,
      decision,
      row.request_id,
    );
    return {
      version: 'opportunity-screening-projection/v1',
      mode: 'coarse_screen',
      sourceStatus: 'current',
      status: screen.status,
      excludeFromDefaultTriage:
        screen.status === 'clear_mismatch' && screen.holdReasons.length === 0,
      requestId: screen.requestId,
      sourceContentFingerprint:
        prepared.sourceIdentity.sourceContentFingerprint,
      sourceContentVersion: prepared.sourceIdentity.sourceContentVersion,
      sourceFingerprint: screen.sourceFingerprint,
      profileFingerprint: screen.profileFingerprint,
      inputFingerprint: expectedInput,
      evidence: screen.evidence,
      conditionalPaths: screen.conditionalPaths,
      uncertainties: screen.uncertainties,
      holdReasons: screen.holdReasons,
    };
  } catch {
    return undefined;
  }
}
/** One current owned profile and one bounded joined source/receipt query per page.
 * A projection is a coarse relevance screen, never a fit, score or eligibility verdict. */
export async function loadCurrentOpportunityScreeningProjections(
  input: { opportunities: Row[]; subject: WorkspaceSubject },
  dependencies: OpportunityScreeningProjectionDependencies = {},
): Promise<Map<string, OpportunityScreeningProjection>> {
  const result = new Map<string, OpportunityScreeningProjection>();
  const subject = requireWorkspaceSubject(input.subject);
  if (input.opportunities.length > OPPORTUNITY_SCREENING_PROJECTION_PAGE_LIMIT)
    throw new Error(
      'Screening projection pages must contain at most 100 opportunities.',
    );
  const ids = [
    ...new Set(
      input.opportunities
        .map((row) => row.id)
        .filter(
          (id): id is string =>
            typeof id === 'string' &&
            id.length > 0 &&
            id.length <= 200 &&
            id === id.trim() &&
            // biome-ignore lint/suspicious/noControlCharactersInRegex: Native IDs must reject ASCII control characters.
            !/[\x00-\x1f\x7f]/u.test(id),
        ),
    ),
  ];
  if (!ids.length) return result;
  const profile = await (
    dependencies.getProfile ??
    (async (id) => {
      const row = await (await getCollection('CandidateProfile')).get(
        { id },
        { cache: false },
      );
      return row?.toJSON() ?? null;
    })
  )(subject.profileId);
  if (
    !profile ||
    profile.id !== subject.profileId ||
    profile.active !== true ||
    Object.entries(candidateProfileWhere(subject)).some(
      ([key, value]) => profile[key] !== value,
    )
  )
    return result;
  const database =
    dependencies.database ?? (await resolveDatabase(getDbConfig()));
  const found = await database.query(
    `SELECT r.owner_request_id, r.request_id AS result_request_id, r.output_json,
    r.idempotency_key AS result_key, q.idempotency_key AS request_key, r.agent_run_id,
    r.opportunity_id, r.content_fingerprint, r.input_fingerprint, r.feature, r.profile, r.model,
    r.prompt_version, r.output_schema_version, r.prepared_payload_version, r.status AS result_status,
    r.tenant_id, r.owner_user_id, r.candidate_profile_id,
    q.request_id, q.status AS request_status, q.accounting_basis, q.actual_total_tokens,
    q.reserved_input_tokens, q.requested_max_output_tokens, q.reserved_spend_micros,
    q.tenant_id AS request_tenant_id, q.owner_user_id AS request_owner_user_id, q.candidate_profile_id AS request_candidate_profile_id,
    a.opportunity_id AS run_opportunity_id, a.tenant_id AS run_tenant_id, a.owner_user_id AS run_owner_user_id,
    a.candidate_profile_id AS run_candidate_profile_id, a.intelligence_reserved_calls AS run_calls,
    a.intelligence_reserved_input_tokens AS run_tokens, a.intelligence_reserved_spend_micros AS run_spend,
    a.intelligence_actual_calls AS run_actual_calls, a.intelligence_actual_input_tokens AS run_actual_tokens,
    a.intelligence_actual_output_tokens AS run_actual_output_tokens, a.intelligence_actual_spend_micros AS run_actual_spend,
    a.intelligence_call_limit AS run_call_limit, a.intelligence_input_token_limit AS run_token_limit,
    a.intelligence_spend_limit_micros AS run_spend_limit,
    CAST(o.id AS TEXT) AS current_opportunity_id, o.source_content_json AS current_source_content_json,
    o.source_content_fingerprint AS current_source_content_fingerprint, o.source_content_version AS current_source_content_version
    FROM opportunity_intelligence_results r JOIN opportunity_intelligence_requests q
      ON q.request_id = r.owner_request_id AND r.request_id = q.request_id AND q.idempotency_key = r.idempotency_key
      AND q.opportunity_id = r.opportunity_id AND q.agent_run_id = r.agent_run_id
      AND q.content_fingerprint = r.content_fingerprint AND q.input_fingerprint = r.input_fingerprint
      AND q.feature = r.feature AND q.profile = r.profile AND q.model = r.model
      AND q.tenant_id = r.tenant_id AND q.owner_user_id = r.owner_user_id AND q.candidate_profile_id = r.candidate_profile_id
    JOIN agent_runs a ON CAST(a.id AS TEXT) = CAST(q.agent_run_id AS TEXT)
    JOIN opportunities o ON CAST(o.id AS TEXT) = CAST(r.opportunity_id AS TEXT)
      AND o.source_content_fingerprint = r.content_fingerprint
    WHERE r.opportunity_id IN (${ids.map(() => '?').join(',')})
      AND r.feature = ? AND r.profile = ? AND r.model = ?
      AND r.output_schema_version IN (${OPPORTUNITY_SCREENING_SUPPORTED_VERSIONS.map(() => '?').join(',')})
      AND r.prompt_version = r.output_schema_version AND r.prepared_payload_version = r.output_schema_version
      AND r.tenant_id = ? AND r.owner_user_id = ? AND r.candidate_profile_id = ?
      AND a.tenant_id = r.tenant_id AND a.owner_user_id = r.owner_user_id AND a.candidate_profile_id = r.candidate_profile_id
      AND r.status = 'completed' AND q.status = 'succeeded' AND q.accounting_basis = 'actual' AND q.actual_total_tokens > 0
    LIMIT ?`,
    [
      ...ids,
      OPPORTUNITY_SCREENING_RECEIPT_FEATURE,
      OPPORTUNITY_SCREENING_RECEIPT_PROFILE,
      model(),
      ...OPPORTUNITY_SCREENING_SUPPORTED_VERSIONS,
      subject.tenantId,
      subject.userId,
      subject.profileId,
      ids.length * 2 + 1,
    ],
  );
  const allowed = new Set(ids);
  const grouped = new Map<string, Row[]>();
  for (const row of found.rows)
    if (
      typeof row.opportunity_id === 'string' &&
      allowed.has(row.opportunity_id)
    ) {
      const group = grouped.get(row.opportunity_id) ?? [];
      group.push(row);
      grouped.set(row.opportunity_id, group);
    }
  for (const [id, rows] of grouped) {
    const valid = rows
      .map((row) => projectRow(row, profile, subject))
      .filter((row): row is OpportunityScreeningProjection => !!row);
    if (valid.length === 1) result.set(id, valid[0]!);
  }
  return result;
}
