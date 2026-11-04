import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import { getDbConfig } from './db.js';
import { MATCHING_POLICY_VERSION } from './normalized-matching.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

export type MatchingDialect = 'postgres' | 'sqlite';

export type MatchingDiscoveryProgress = {
  status:
    | 'pending'
    | 'ready'
    | 'missing-preferences'
    | 'needs-evidence'
    | 'failed';
};

/** Values come from a server-verified subject, never a browser profile selector. */
export function currentQualifiedMatchJoin(
  subject: CandidateWorkspaceSubject,
  bind: (value: unknown) => string,
  opportunityAlias = 'o',
  dialect: MatchingDialect = 'postgres',
): string {
  if (!/^[a-z][a-z0-9_]*$/.test(opportunityAlias))
    throw new Error('Invalid matching query alias.');
  const o = opportunityAlias;
  return `
    JOIN matching_results current_match
      ON current_match.opportunity_id = CAST(${o}.id AS TEXT)
      AND current_match.profile_id = ${bind(subject.profileId)}
      AND current_match.tenant_id = ${bind(subject.tenantId)}
      AND current_match.user_id = ${bind(subject.userId)}
      AND current_match.policy_version = ${bind(MATCHING_POLICY_VERSION)}
      AND current_match.status = 'qualified'
    JOIN matching_source_versions matching_input_version
      ON matching_input_version.opportunity_id = current_match.opportunity_id
      AND matching_input_version.revision = current_match.source_revision
    JOIN sources matching_listing
      ON matching_listing.id = ${o}.source_id
      AND matching_listing.is_active = TRUE AND matching_listing.public_listing = TRUE
    JOIN matching_source_listing_versions matching_listing_version
      ON matching_listing_version.source_id = matching_listing.id
      AND matching_listing_version.revision = current_match.source_listing_revision
    JOIN matching_profile_versions matching_profile_version
      ON matching_profile_version.profile_id = current_match.profile_id
      AND matching_profile_version.revision = current_match.profile_revision
    JOIN matching_vocabulary_version matching_vocabulary
      ON matching_vocabulary.id = 1 AND matching_vocabulary.revision = current_match.vocabulary_revision
    JOIN candidate_profiles matching_owner
      ON CAST(matching_owner.id AS TEXT) = current_match.profile_id
      AND CAST(matching_owner.tenant_id AS TEXT) = current_match.tenant_id
      AND matching_owner.owner_user_id = current_match.user_id
      AND matching_owner.active = TRUE
      AND ${liveMatchingOwnerSql('matching_owner')}
      AND ${liveMatchingOpportunitySql(o, dialect)}
  `;
}

/** Both the worker and discovery use the same live source lifecycle boundary. */
export function liveMatchingOpportunitySql(
  alias: string,
  dialect: MatchingDialect,
): string {
  const expiry =
    dialect === 'sqlite'
      ? `julianday(${alias}.expires_at) > julianday('now')`
      : `${alias}.expires_at > CURRENT_TIMESTAMP`;
  return `${alias}.status IN ('found', 'recommended', 'active', 'open')
    AND (${alias}.expires_at IS NULL OR ${expiry})`;
}

/** Live row status is an additional gate after native request identity verification. */
export function liveMatchingOwnerSql(profileAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM memberships mm
    JOIN users mu ON mu.id = mm.user_id AND mu.status = 'active'
    JOIN tenants mt ON mt.id = mm.tenant_id AND mt.status = 'active'
    WHERE mm.tenant_id = ${profileAlias}.tenant_id
      AND CAST(mm.user_id AS TEXT) = ${profileAlias}.owner_user_id
      AND mm.status = 'active' AND mm.role_id IS NOT NULL
  )`;
}

export async function getMatchingDiscoveryProgress(
  subject: CandidateWorkspaceSubject,
): Promise<MatchingDiscoveryProgress> {
  const { requireCurrentCandidateWorkspaceSubject, WorkspaceSubjectError } =
    await import('./workspace-subject.js');
  const active = requireCurrentCandidateWorkspaceSubject();
  if (
    active.profileId !== subject.profileId ||
    active.tenantId !== subject.tenantId ||
    active.userId !== subject.userId
  )
    throw new WorkspaceSubjectError(
      403,
      'Matching progress is outside this workspace.',
    );
  const config = getDbConfig();
  const db = getRequestScopedDatabase() ?? (await resolveDatabase(config));
  const result = await db.query(
    `
    SELECT CASE WHEN f.status <> 'missing-preferences'
      AND (f.cursor < clock.work_revision OR EXISTS (
        SELECT 1 FROM matching_source_versions sv WHERE sv.revision > clock.source_event_revision
      )) THEN 'pending' ELSE f.status END AS status
    FROM matching_profile_facts f
    JOIN matching_profile_versions pv ON pv.profile_id = f.profile_id AND pv.revision = f.profile_revision
    JOIN matching_vocabulary_version vv ON vv.id = 1 AND vv.revision = f.vocabulary_revision
    JOIN matching_worker_cursor clock ON clock.id = 1
    WHERE f.profile_id = ? AND f.tenant_id = ? AND f.user_id = ? AND f.policy_version = ?
  `,
    [
      subject.profileId,
      subject.tenantId,
      subject.userId,
      MATCHING_POLICY_VERSION,
    ],
  );
  const row = (Array.isArray(result) ? result : result.rows)[0];
  switch (row?.status) {
    case 'ready':
    case 'needs-evidence':
    case 'missing-preferences':
    case 'failed':
    case 'pending':
      return { status: row.status };
    default:
      return { status: 'pending' };
  }
}
