import {
  detectEngine,
  resolveDatabase,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import { getDbConfig } from './db.js';
import { privateRecordWhere } from './private-workspace.js';
import { getCollection } from './smrt.js';
import {
  requireCandidateWorkspaceSubject,
  type WorkspaceSubject,
} from './workspace-subject.js';

function assertMatchingContext(subject: WorkspaceSubject): void {
  const context = getCurrentTenant();
  if (
    !context ||
    context.tenantId !== subject.tenantId ||
    context.userId !== subject.userId
  )
    throw new Error(
      'Matching workspace context does not match the verified owner.',
    );
}
export type MatchDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
export async function matchTransaction<T>(
  action: (db: MatchDatabase) => Promise<T>,
): Promise<T> {
  const db =
    getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
  if (!db.transaction)
    throw new Error('Matching requires native transactions.');
  return db.transaction(action);
}
/** All stores pin the executor and lock the complete owner/key tuple before upsert. */
export async function saveOwnedMatchRecord(
  className:
    | 'RequirementEvidenceDecision'
    | 'MatchModel'
    | 'OpportunityRecommendationRank',
  subject: WorkspaceSubject,
  key: Record<string, unknown>,
  payload: Record<string, unknown>,
  db: MatchDatabase,
): Promise<SmrtObject> {
  assertMatchingContext(subject);
  const where = {
    ...key,
    ...privateRecordWhere(requireCandidateWorkspaceSubject(subject)),
  };
  if (db.url && detectEngine(db.url) === 'postgres')
    await db.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
      JSON.stringify([className, where]),
    ]);
  const collection = await getCollection(className, { db: db as never });
  const rows = await findOwnedMatchRecords(className, subject, key, db);
  if (rows.length > 1) throw new Error('Ambiguous private matching record.');
  const existing = rows[0];
  if (!existing)
    return collection.create({ ...payload, ...where, _insertOnly: true });
  if (
    className === 'OpportunityRecommendationRank' &&
    Object.entries(payload).every(
      ([name, value]) =>
        name === 'proofFinishedAt' ||
        (existing as unknown as Record<string, unknown>)[name] === value,
    )
  )
    return existing;
  const revision = existing.updated_at;
  Object.assign(existing, payload, where);
  await existing.save({ expectedUpdatedAt: revision ?? undefined });
  return existing;
}

/** Internal indexed lookup for sensitive content hashes; never exposed as arbitrary filters. */
export async function findOwnedMatchRecords(
  className:
    | 'RequirementEvidenceDecision'
    | 'MatchModel'
    | 'OpportunityRecommendationRank',
  subject: WorkspaceSubject,
  key: Record<string, unknown>,
  database?: MatchDatabase,
): Promise<SmrtObject[]> {
  assertMatchingContext(subject);
  const tables = {
    RequirementEvidenceDecision: 'requirement_evidence_decisions',
    MatchModel: 'match_models',
    OpportunityRecommendationRank: 'opportunity_recommendation_ranks',
  };
  const fields: Record<string, string> = {
    requirementHash: 'requirement_hash',
    evidenceHash: 'evidence_hash',
    candidateMaterialFingerprint: 'candidate_material_fingerprint',
    decisionVersion: 'decision_version',
    model: 'model',
    modelVersion: 'model_version',
    opportunityId: 'opportunity_id',
  };
  const owner = privateRecordWhere(requireCandidateWorkspaceSubject(subject));
  const db =
    database ??
    getRequestScopedDatabase() ??
    (await resolveDatabase(getDbConfig()));
  const values: unknown[] = [
    owner.tenantId,
    owner.ownerUserId,
    owner.candidateProfileId,
  ];
  const clauses = [
    'tenant_id = ?',
    'owner_user_id = ?',
    'candidate_profile_id = ?',
  ];
  for (const [name, value] of Object.entries(key)) {
    if (!fields[name]) throw new Error('Unsupported matching lookup key.');
    clauses.push(`${fields[name]} = ?`);
    values.push(value);
  }
  const found = await db.query(
    `SELECT id FROM ${tables[className]} WHERE ${clauses.join(' AND ')} LIMIT 2`,
    values,
  );
  const collection = await getCollection(className, { db: db as never });
  const records = await Promise.all(
    found.rows.map((row) => collection.get(String(row.id))),
  );
  return records.filter((row): row is SmrtObject =>
    Boolean(
      row &&
        Object.entries(owner).every(
          ([name, value]) =>
            (row as unknown as Record<string, unknown>)[name] === value,
        ),
    ),
  );
}
