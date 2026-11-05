import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import type {
  MatchingDiscoveryCoverage,
  MatchingDiscoveryProgress,
} from '$lib/admin/resource-shell';
import { getDbConfig } from './db.js';
import { MATCHING_POLICY_VERSION } from './normalized-matching.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

export type MatchingDialect = 'postgres' | 'sqlite';

export type { DiscoveryMatchStatus } from '$lib/discovery-match';

export const DISCOVERY_MATCH_STATUS_SQL = `CASE WHEN current_match.status = 'qualified' THEN 'qualified' ELSE 'screened-with-gaps' END`;

/** Exact server-selected match generations; used again at each bulk write. */
export const MATCHING_REVISION_SQL = [
  'profile_id',
  'tenant_id',
  'user_id',
  'profile_revision',
  'source_revision',
  'source_listing_revision',
  'vocabulary_revision',
  'policy_version',
]
  .map((column) => `CAST(current_match.${column} AS TEXT)`)
  .concat(`(${DISCOVERY_MATCH_STATUS_SQL})`)
  .join(" || ':' || ");

export type MatchingWriteRevision = {
  opportunityId: string;
  updatedAt: string;
  matchingRevision: string;
};

/** Values come from a server-verified subject, never a browser profile selector. */
export function currentQualifiedMatchJoin(
  subject: CandidateWorkspaceSubject,
  bind: (value: unknown) => string,
  opportunityAlias = 'o',
  dialect: MatchingDialect = 'postgres',
): string {
  return currentMatchJoin(subject, bind, opportunityAlias, dialect, false);
}

export function currentDiscoveryMatchJoin(
  subject: CandidateWorkspaceSubject,
  bind: (value: unknown) => string,
  opportunityAlias = 'o',
  dialect: MatchingDialect = 'postgres',
): string {
  return currentMatchJoin(subject, bind, opportunityAlias, dialect, true);
}

function currentMatchJoin(
  subject: CandidateWorkspaceSubject,
  bind: (value: unknown) => string,
  opportunityAlias: string,
  dialect: MatchingDialect,
  includeScreened: boolean,
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
      AND (current_match.status = 'qualified'${includeScreened ? " OR (current_match.status = 'insufficient-evidence' AND current_match.screened_with_gaps = TRUE)" : ''})
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

/** Called only on the transaction that will perform the corresponding write. */
export async function lockMatchingWriteRevision(
  tx: DatabaseInterface,
  dialect: MatchingDialect,
  subject: CandidateWorkspaceSubject,
  expected: MatchingWriteRevision,
  options: { allowScreened?: boolean } = {},
): Promise<boolean> {
  if (dialect === 'sqlite') {
    // Acquire the database write lock before reading currentness, so no
    // concurrent raw mutation can commit between this check and the write.
    await tx.query(
      'UPDATE matching_source_versions SET revision=revision WHERE opportunity_id=?',
      [expected.opportunityId],
    );
  }
  const params: unknown[] = [];
  const join = options.allowScreened
    ? currentDiscoveryMatchJoin
    : currentQualifiedMatchJoin;
  const gate = join(
    subject,
    (value) => {
      params.push(value);
      return '?';
    },
    'o',
    dialect,
  );
  const lock =
    dialect === 'postgres'
      ? 'FOR SHARE OF o, matching_profile_version, matching_vocabulary, matching_input_version, matching_listing_version, current_match'
      : '';
  const {
    rows: [row],
  } = await tx.query(
    `
    SELECT o.updated_at FROM opportunities o ${gate}
    WHERE o.id=? AND (${MATCHING_REVISION_SQL})=? ${lock}
  `,
    [...params, expected.opportunityId, expected.matchingRevision],
  );
  const updatedAt =
    row?.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row?.updated_at ?? '');
  return Boolean(row && updatedAt === expected.updatedAt);
}

/** Keep all matching revision locks on the executor used by the durable mutation. */
export async function withMatchingWriteRevision<T>(
  subject: CandidateWorkspaceSubject,
  expected: MatchingWriteRevision,
  write: (tx: DatabaseInterface) => Promise<T>,
  options: { allowScreened?: boolean } = {},
): Promise<{ current: true; result: T } | { current: false }> {
  const config = getDbConfig();
  const db = getRequestScopedDatabase() ?? (await resolveDatabase(config));
  if (!db.transaction)
    throw new Error('Matching writes require a native transaction.');
  const dialect = config.type === 'sqlite' ? 'sqlite' : 'postgres';
  return db.transaction(async (tx) => {
    if (
      !(await lockMatchingWriteRevision(
        tx,
        dialect,
        subject,
        expected,
        options,
      ))
    )
      return { current: false };
    return { current: true, result: await write(tx) };
  });
}

export async function getMatchingDiscoveryProgress(
  subject: CandidateWorkspaceSubject,
  options: { coverage?: boolean } = {},
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
  const dialect = config.type === 'sqlite' ? 'sqlite' : 'postgres';
  const progress = await readMatchingDiscoveryProgress(db, dialect, active);
  if (
    options.coverage &&
    ['ready', 'needs-evidence'].includes(progress.status)
  ) {
    const { readMatchingDiscoveryCoverage } = await import(
      './matching-discovery-coverage.js'
    );
    return {
      ...progress,
      coverage: await readMatchingDiscoveryCoverage(db, dialect, active),
    };
  }
  return progress;
}

/** Use only with the active workspace subject verified by the caller. */
export async function readMatchingDiscoveryProgress(
  db: DatabaseInterface,
  dialect: MatchingDialect,
  subject: CandidateWorkspaceSubject,
): Promise<MatchingDiscoveryProgress> {
  // Expose only an enum from the current, owned snapshot, never its private text.
  const rolePreferenceStatus =
    dialect === 'sqlite'
      ? "CASE WHEN json_valid(f.facts_json) THEN json_extract(f.facts_json, '$.rolePreferenceStatus') END"
      : "CASE WHEN f.facts_json IS JSON OBJECT THEN f.facts_json::jsonb->>'rolePreferenceStatus' END";
  const result = await db.query(
    `
    SELECT CASE WHEN f.status <> 'missing-preferences'
      AND (f.cursor < clock.work_revision OR EXISTS (
        SELECT 1 FROM matching_source_versions sv WHERE sv.revision > clock.source_event_revision
      )) THEN 'pending' ELSE f.status END AS status,
      ${rolePreferenceStatus} AS role_preference_status
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
  if (row?.role_preference_status === 'unsupported')
    return { status: 'unsupported-target-roles' };
  switch (row?.status) {
    case 'ready':
    case 'needs-evidence':
    case 'missing-preferences':
    case 'failed':
    case 'pending':
      return row.role_preference_status === 'partial'
        ? { status: row.status, hasUnsupportedRoleChoices: true }
        : { status: row.status };
    default:
      return { status: 'pending' };
  }
}
