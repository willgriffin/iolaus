import type { DatabaseInterface } from '@happyvertical/sql';

export const resumeImportTables = [
  'resume_import_quarantines',
  'resume_import_recovery_audits',
  'intake_items',
  'intake_evidence',
  'intake_analyses',
  'intake_analysis_attempts',
  'intake_plans',
  'intake_actions',
  'intake_proposals',
  'intake_review_decisions',
  'intake_executions',
  'intake_feedback',
  'intake_dispatches',
  'intake_deletions',
] as const;

export async function getResumeImportSchemaStatus(
  db: Pick<DatabaseInterface, 'query'>,
): Promise<{ present: number; total: number }> {
  const parameters = resumeImportTables.map(() => '?').join(', ');
  const result = await db.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN (${parameters})`,
    [...resumeImportTables],
  );
  return { present: result.rows.length, total: resumeImportTables.length };
}

export function resumeImportSchemaIsReady(status: {
  present: number;
  total: number;
}): boolean {
  return status.present === status.total;
}
