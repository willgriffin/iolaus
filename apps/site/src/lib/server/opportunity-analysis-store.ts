import { createHash, randomUUID } from 'node:crypto';
import { detectEngine, type resolveDatabase } from '@happyvertical/smrt-core';
import {
  OPPORTUNITY_ANALYSIS_VERSION,
  type OpportunityAnalysisSnapshot,
} from '$lib/opportunity-analysis-contract.js';
import type { AnalysisSourceIdentity } from './opportunity-analysis-source.js';
import { DETERMINISTIC_SKILLS_PROMPT_VERSION } from './opportunity-analysis-source.js';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';
export type AnalysisDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
export interface AnalysisProvenance {
  model: string;
  promptVersion: string;
  outputSchemaVersion: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}
export const deterministicAnalysisProvenance: AnalysisProvenance = {
  model: 'deterministic',
  promptVersion: DETERMINISTIC_SKILLS_PROMPT_VERSION,
  outputSchemaVersion: OPPORTUNITY_ANALYSIS_VERSION,
  requestId: '',
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
};
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
export function analysisSnapshotFromRow(
  row: Record<string, unknown>,
): OpportunityAnalysisSnapshot {
  const eligibility = json(row.eligibility_json, {
    remote: null,
    countries: [],
    regions: [],
    timezones: [],
    flags: 0,
    workAuthorization: { required: [], sponsorship: 'unknown' },
  });
  return {
    id: String(row.id),
    opportunityId: String(row.opportunity_id),
    sourceContentFingerprint: String(row.source_content_fingerprint),
    sourceContentVersion: Number(row.source_content_version),
    analysisVersion: OPPORTUNITY_ANALYSIS_VERSION,
    status: row.status as OpportunityAnalysisSnapshot['status'],
    normalizedTitle: String(row.normalized_title),
    seniority: String(row.seniority),
    function: String(row.function),
    workMode: String(row.work_mode),
    employmentType: String(row.employment_type),
    skills: json(row.skills_json, []),
    requirements: json(row.requirements_json, []),
    skillSlugs: json(row.skill_slugs_json, []),
    summaryBullets: json(row.summary_json, []),
    eligibility: eligibility as OpportunityAnalysisSnapshot['eligibility'],
    compensation: json(row.compensation_json, null),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
  };
}
export async function readCurrentAnalysis(
  db: AnalysisDatabase,
  opportunityId: string,
): Promise<OpportunityAnalysisSnapshot | null> {
  const rows = await db.query(
    `SELECT a.*, o.source_content_json AS canonical_source_json FROM opportunities o JOIN opportunity_analyses a ON a.id=o.current_analysis_id AND a.opportunity_id=o.id AND a.source_content_fingerprint=o.source_content_fingerprint AND a.source_content_version=o.source_content_version WHERE o.id=? AND a.analysis_version=? AND a.status IN ('deterministic','enriched') AND (a.status='enriched' OR (a.model='deterministic' AND a.prompt_version=?))`,
    [
      opportunityId,
      OPPORTUNITY_ANALYSIS_VERSION,
      DETERMINISTIC_SKILLS_PROMPT_VERSION,
    ],
  );
  const row = rows.rows[0];
  if (
    !row ||
    row.source_content_digest !==
      createHash('sha256')
        .update(String(row.canonical_source_json))
        .digest('hex')
  )
    return null;
  return analysisSnapshotFromRow(row);
}
/** Artifact, skill junctions and pointer are committed on one pinned native transaction.
 * Public search triggers consume the same transaction. Never hydrate/save a stale Opportunity. */
export async function publishOpportunityAnalysis(
  db: AnalysisDatabase,
  source: AnalysisSourceIdentity,
  value: OpportunityAnalysisSnapshot,
  provenance: AnalysisProvenance = deterministicAnalysisProvenance,
): Promise<OpportunityAnalysisSnapshot> {
  if (!db.transaction)
    throw new Error('Analysis publication requires native transactions.');
  const sqlite = Boolean(db.url && detectEngine(db.url) === 'sqlite');
  const transaction = db.transaction.bind(db);
  const run = () =>
    transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id,source_content_json,source_content_fingerprint,source_content_version FROM opportunities WHERE id=?${sqlite ? '' : ' FOR UPDATE'}`,
        [source.id],
      );
      const current = locked.rows[0];
      if (
        !current ||
        current.source_content_fingerprint !==
          source.sourceContentFingerprint ||
        Number(current.source_content_version) !==
          source.sourceContentVersion ||
        current.source_content_json !== source.sourceContentJson
      )
        throw new Error('Stale opportunity analysis source.');
      const active = await readCurrentAnalysis(tx, source.id);
      if (active?.status === 'enriched' && value.status === 'deterministic')
        return active;
      const hash = createHash('sha256')
        .update(
          JSON.stringify([
            source.id,
            source.sourceContentFingerprint,
            source.sourceContentVersion,
            createHash('sha256').update(source.sourceContentJson).digest('hex'),
            OPPORTUNITY_ANALYSIS_VERSION,
            provenance.model,
            provenance.promptVersion,
            provenance.outputSchemaVersion,
          ]),
        )
        .digest('hex');
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const columns = [
        'id',
        'slug',
        'context',
        'created_at',
        'updated_at',
        'opportunity_id',
        'source_content_fingerprint',
        'source_content_version',
        'source_content_digest',
        'analysis_version',
        'status',
        'normalized_title',
        'seniority',
        'function',
        'work_mode',
        'employment_type',
        'skills_json',
        'requirements_json',
        'eligibility_json',
        'compensation_json',
        'summary_json',
        'countries_json',
        'skill_slugs_json',
        'model',
        'prompt_version',
        'output_schema_version',
        'request_id',
        'input_tokens',
        'output_tokens',
        'cost_micros',
        'error_code',
      ];
      const now = new Date().toISOString();
      const values = [
        id,
        id,
        '',
        now,
        now,
        source.id,
        source.sourceContentFingerprint,
        source.sourceContentVersion,
        createHash('sha256').update(source.sourceContentJson).digest('hex'),
        OPPORTUNITY_ANALYSIS_VERSION,
        value.status,
        value.normalizedTitle,
        value.seniority,
        value.function,
        value.workMode,
        value.employmentType,
        JSON.stringify(value.skills),
        JSON.stringify(value.requirements),
        JSON.stringify(value.eligibility),
        JSON.stringify(value.compensation),
        JSON.stringify(value.summaryBullets),
        JSON.stringify(value.eligibility.countries),
        JSON.stringify(value.skillSlugs),
        provenance.model,
        provenance.promptVersion,
        provenance.outputSchemaVersion,
        provenance.requestId,
        provenance.inputTokens,
        provenance.outputTokens,
        provenance.costMicros,
        value.errorCode ?? '',
      ];
      const inserted = await tx.query(
        `INSERT INTO opportunity_analyses (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT (id) DO NOTHING RETURNING id`,
        values,
      );
      if (inserted.rows.length) {
        for (const skill of value.skills) {
          const skillId = randomUUID();
          await tx.query(
            'INSERT INTO opportunity_skills (id,slug,context,created_at,updated_at,opportunity_id,analysis_id,skill_slug,kind,confidence) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [
              skillId,
              skillId,
              '',
              now,
              now,
              source.id,
              id,
              skill.slug,
              skill.kind,
              skill.confidence,
            ],
          );
        }
      }
      const swapped = await tx.query(
        'UPDATE opportunities SET current_analysis_id=? WHERE id=? AND source_content_fingerprint=? AND source_content_version=? AND source_content_json=? RETURNING id',
        [
          id,
          source.id,
          source.sourceContentFingerprint,
          source.sourceContentVersion,
          source.sourceContentJson,
        ],
      );
      if (swapped.rows.length !== 1)
        throw new Error('Stale opportunity analysis publication.');
      const published = await readCurrentAnalysis(tx, source.id);
      if (!published) throw new Error('Analysis pointer failed verification.');
      return published;
    });
  return sqlite
    ? withSqliteOperationLock('opportunity-analysis-publication', run)
    : run();
}
