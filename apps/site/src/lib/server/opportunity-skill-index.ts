import type { AnalysisSourceIdentity } from './opportunity-analysis-source.js';
import { deterministicOpportunityAnalysis } from './opportunity-analysis-source.js';
import {
  type AnalysisDatabase,
  publishOpportunityAnalysis,
  readCurrentAnalysis,
} from './opportunity-analysis-store.js';

const PUBLIC_STATUSES = [
  'found',
  'recommended',
  'apply',
  'applied',
  'interviewing',
  'offer',
  'maybe',
  'needs_input',
  'active',
  'new',
];

export type OpportunitySkillIndexResult = {
  mode: 'dry-run' | 'apply';
  scanned: number;
  expectedSkills: number;
  indexedSkills: number;
  missingSkillsets: number;
  emptyIndexes: number;
  compatibleEnriched: number;
  applied: number;
  unchanged: number;
  failed: number;
  truncated: boolean;
  nextCursor: string | null;
  retryCursor: string | null;
};

function decodeCursor(cursor?: string): string {
  if (!cursor) return '';
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
    throw new Error('Invalid skill-index cursor.');
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value))
    throw new Error('Invalid skill-index cursor.');
  return value;
}

function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

function sameSkills(
  expected: ReturnType<typeof deterministicOpportunityAnalysis>['skills'],
  actual: ReturnType<typeof deterministicOpportunityAnalysis>['skills'],
): boolean {
  const key = (skill: (typeof expected)[number]) =>
    `${skill.slug}:${skill.kind}`;
  return (
    expected.length === actual.length &&
    expected.map(key).sort().join('|') === actual.map(key).sort().join('|')
  );
}

/**
 * Rebuild the public catalog's deterministic skill index with no worker,
 * provider, or budget admission. This is intentionally an explicit operator
 * path; the normal analysis backfill keeps its global 300/day admission cap.
 */
export async function reindexOpportunitySkills(
  db: AnalysisDatabase,
  options: { max: number; cursor?: string; apply?: boolean },
): Promise<OpportunitySkillIndexResult> {
  if (
    !Number.isSafeInteger(options.max) ||
    options.max < 1 ||
    options.max > 300
  )
    throw new Error('Skill-index max must be 1..300.');
  const after = decodeCursor(options.cursor);
  const rows = (
    await db.query(
      `SELECT o.id,o.source_content_json,o.source_content_fingerprint,o.source_content_version
       FROM opportunities o JOIN sources s ON s.id=o.source_id
       WHERE s.public_listing=TRUE AND s.is_active=TRUE
         AND o.status IN (${PUBLIC_STATUSES.map(() => '?').join(',')})
         AND (o.expires_at IS NULL OR o.expires_at>CURRENT_TIMESTAMP)
         AND CAST(o.id AS TEXT)>?
       ORDER BY CAST(o.id AS TEXT) ASC LIMIT ?`,
      [...PUBLIC_STATUSES, after, options.max + 1],
    )
  ).rows as Record<string, unknown>[];
  const result: OpportunitySkillIndexResult = {
    mode: options.apply ? 'apply' : 'dry-run',
    scanned: 0,
    expectedSkills: 0,
    indexedSkills: 0,
    missingSkillsets: 0,
    emptyIndexes: 0,
    compatibleEnriched: 0,
    applied: 0,
    unchanged: 0,
    failed: 0,
    truncated: rows.length > options.max,
    nextCursor: options.cursor ?? null,
    retryCursor: null,
  };
  for (const row of rows.slice(0, options.max)) {
    const id = String(row.id);
    const before = result.nextCursor;
    result.scanned++;
    try {
      const source: AnalysisSourceIdentity = {
        id,
        sourceContentJson: String(row.source_content_json ?? ''),
        sourceContentFingerprint: String(row.source_content_fingerprint ?? ''),
        sourceContentVersion: Number(row.source_content_version),
      };
      const expected = deterministicOpportunityAnalysis(source);
      result.expectedSkills += expected.skills.length;
      const current = await readCurrentAnalysis(db, id);
      const indexed = current?.skills.length ?? 0;
      result.indexedSkills += indexed;
      if (current?.status === 'enriched') {
        result.compatibleEnriched++;
        result.unchanged++;
      } else if (!current || !sameSkills(expected.skills, current.skills)) {
        if (options.apply) {
          const published = await publishOpportunityAnalysis(
            db,
            source,
            expected,
          );
          // Report coverage after a successful repair. This lets --check run
          // after --apply and makes remaining gaps actionable.
          result.indexedSkills += published.skills.length - indexed;
          if (published.status === 'enriched') {
            // A concurrent enrichment wins atomically in the store. It is a
            // compatible index, never a deterministic gap to overwrite.
            result.compatibleEnriched++;
            result.unchanged++;
          } else result.applied++;
        } else {
          result.missingSkillsets++;
          if (expected.skills.length > 0 && indexed === 0)
            result.emptyIndexes++;
        }
      } else {
        result.unchanged++;
      }
      result.nextCursor = encodeCursor(id);
    } catch {
      // Do not skip an unretryable source silently. Resume at this same page;
      // preceding records are idempotent and raw IDs never enter operator logs.
      result.failed++;
      result.retryCursor = before;
      result.nextCursor = before;
      result.truncated = true;
      break;
    }
  }
  if (!result.truncated && result.failed === 0) result.nextCursor = null;
  return result;
}

/** A read-only coverage result is unhealthy only for deterministic gaps. */
export function skillIndexCoverageHealthy(result: OpportunitySkillIndexResult) {
  return result.failed === 0 && result.missingSkillsets === 0;
}
