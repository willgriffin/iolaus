import type { DatabaseInterface } from '@happyvertical/sql';
import type { MatchingDiscoveryCoverage } from '$lib/admin/resource-shell';
import {
  liveMatchingOpportunitySql,
  liveMatchingOwnerSql,
  type MatchingDialect,
} from './matching-projection-read.js';
import { MATCHING_POLICY_VERSION } from './normalized-matching.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

/** Read only current outcomes for the verified subject on its request executor.
 * The empty discovery view uses counts, never evidence text or locators. */
export async function readMatchingDiscoveryCoverage(
  db: Pick<DatabaseInterface, 'query'>,
  dialect: MatchingDialect,
  subject: CandidateWorkspaceSubject,
): Promise<MatchingDiscoveryCoverage> {
  const postgres = dialect === 'postgres';
  const reasons = postgres
    ? `jsonb_array_elements(CASE WHEN r.status = 'insufficient-evidence' AND r.reasons_json IS JSON ARRAY THEN CAST(r.reasons_json AS JSONB) ELSE '[]'::jsonb END)`
    : `json_each(CASE WHEN r.status = 'insufficient-evidence' AND json_valid(r.reasons_json) THEN r.reasons_json ELSE '[]' END)`;
  const field = (key: 'code' | 'outcome') =>
    postgres
      ? `j.value->>'${key}'`
      : `CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.${key}') END`;
  const unknown = (...codes: string[]) =>
    `MAX(CASE WHEN ${field('outcome')} = 'unknown'
      AND ${field('code')} IN (${codes.map((code) => `'${code}'`).join(', ')})
      THEN 1 ELSE 0 END)`;
  const result = await db.query(
    `
    WITH current_rows AS MATERIALIZED (
    SELECT r.opportunity_id, r.status, r.reasons_json
    FROM matching_results r
    JOIN candidate_profiles p ON CAST(p.id AS TEXT) = r.profile_id
      AND CAST(p.tenant_id AS TEXT) = r.tenant_id AND p.owner_user_id = r.user_id
      AND p.active = TRUE AND ${liveMatchingOwnerSql('p')}
    JOIN matching_profile_versions pv ON pv.profile_id = r.profile_id AND pv.revision = r.profile_revision
    JOIN matching_vocabulary_version vv ON vv.id = 1 AND vv.revision = r.vocabulary_revision
    JOIN matching_source_versions sv ON sv.opportunity_id = r.opportunity_id AND sv.revision = r.source_revision
    JOIN opportunities o ON CAST(o.id AS TEXT) = sv.opportunity_id
    JOIN sources s ON s.id = o.source_id AND s.is_active = TRUE AND s.public_listing = TRUE
    JOIN matching_source_listing_versions sl ON sl.source_id = s.id AND sl.revision = r.source_listing_revision
    WHERE r.profile_id = ? AND r.tenant_id = ? AND r.user_id = ? AND r.policy_version = ?
      AND (r.status = 'conflict' OR (r.status = 'insufficient-evidence' AND r.screened_with_gaps = FALSE)) AND ${liveMatchingOpportunitySql('o', dialect)}
    ), categorized AS (
      SELECT r.opportunity_id, r.status,
        ${unknown('posting-source-interpretation-missing')} AS missing_source,
        ${unknown('posting-requirement-unsupported', 'required-capability-unsupported', 'posting-capability-gap')} AS unsupported,
        ${unknown('posting-requirement-unknown', 'posting-requirements-incomplete', 'posting-role-unknown', 'posting-role-ambiguous', 'posting-geography-unknown', 'posting-geography-ambiguous')} AS unresolved_source,
        ${unknown('required-capability')} AS unresolved_capability,
        ${unknown('screening-question')} AS unresolved_screening,
        ${unknown('candidate-interpretation-pending')} AS pending_interpretation,
        ${unknown('candidate-interpretation-failed')} AS failed_interpretation,
        ${unknown('candidate-interpretation-partial')} AS partial_interpretation
      FROM current_rows r
      LEFT JOIN ${reasons} j ON TRUE
      GROUP BY r.opportunity_id, r.status
    )
    SELECT
      COUNT(CASE WHEN status = 'conflict' THEN 1 END) AS conflicts,
      SUM(missing_source) AS missing_source,
      SUM(unsupported) AS unsupported,
      SUM(unresolved_source) AS unresolved_source,
      SUM(CASE WHEN unresolved_screening = 1 OR (
        unresolved_capability = 1 AND pending_interpretation = 0
        AND failed_interpretation = 0 AND partial_interpretation = 0
      ) THEN 1 ELSE 0 END) AS unresolved_evidence,
      SUM(pending_interpretation) AS pending_interpretation,
      SUM(failed_interpretation) AS failed_interpretation,
      SUM(partial_interpretation) AS partial_interpretation
    FROM categorized
    `,
    [
      subject.profileId,
      subject.tenantId,
      subject.userId,
      MATCHING_POLICY_VERSION,
    ],
  );
  const row = (Array.isArray(result) ? result : result.rows)[0];
  return {
    conflicts: Number(row?.conflicts ?? 0),
    missingSource: Number(row?.missing_source ?? 0),
    unsupported: Number(row?.unsupported ?? 0),
    unresolvedSource: Number(row?.unresolved_source ?? 0),
    unresolvedEvidence: Number(row?.unresolved_evidence ?? 0),
    pendingInterpretation: Number(row?.pending_interpretation ?? 0),
    failedInterpretation: Number(row?.failed_interpretation ?? 0),
    partialInterpretation: Number(row?.partial_interpretation ?? 0),
  };
}
