/**
 * One-time, idempotent data migration for the lifecycle de-naming rename
 * (app-flow P3). Persisted enum/role values that baked in the owner's name are
 * remapped to generic values:
 *   - application status   `awaiting_will`          -> `awaiting_user`
 *   - kanban column        `ready_for_will_review`  -> `ready_for_user_review`
 *   - kanban column        `needs_will_decision`    -> `needs_user_decision`
 *   - role values (`'will'`) on tasks/decisions/sources/applications -> `owner`
 *
 * Each statement is a plain UPDATE keyed on the old value, so re-running after
 * the rename is a no-op (no rows match). Safe to call on every `db:migrate`.
 */

interface DbLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rowCount?: number | null } | undefined>;
}

const LIFECYCLE_VALUE_REMAPS: ReadonlyArray<
  readonly [table: string, column: string, from: string, to: string]
> = [
  ['applications', 'status', 'awaiting_will', 'awaiting_user'],
  ['applications', 'submitted_by_role', 'will', 'owner'],
  ['decisions', 'decision_by', 'will', 'owner'],
  ['sources', 'account_owner_role', 'will', 'owner'],
  ['tasks', 'assignee_role', 'will', 'owner'],
  ['tasks', 'blocker_owner_role', 'will', 'owner'],
  ['tasks', 'created_by', 'will', 'owner'],
  ['tasks', 'kanban_column', 'ready_for_will_review', 'ready_for_user_review'],
  ['tasks', 'kanban_column', 'needs_will_decision', 'needs_user_decision'],
  // Anomalous legacy rows that stored a status value in kanban_column; remap to
  // strip the owner name regardless.
  ['tasks', 'kanban_column', 'awaiting_will', 'awaiting_user'],
];

export interface LifecycleRemapResult {
  table: string;
  column: string;
  from: string;
  to: string;
  updated: number;
}

export async function remapLifecycleValues(
  db: DbLike,
): Promise<LifecycleRemapResult[]> {
  const results: LifecycleRemapResult[] = [];
  for (const [table, column, from, to] of LIFECYCLE_VALUE_REMAPS) {
    const result = await db.query(
      `UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = $2`,
      [to, from],
    );
    const updated =
      typeof result?.rowCount === 'number' ? result.rowCount : 0;
    if (updated > 0) results.push({ column, from, table, to, updated });
  }
  return results;
}

export function formatLifecycleRemapSummary(
  results: LifecycleRemapResult[],
): string {
  if (results.length === 0) {
    return 'Lifecycle value remap: nothing to migrate (already de-named).';
  }
  return [
    'Lifecycle value remap:',
    ...results.map(
      (r) => `- ${r.table}.${r.column}: ${r.from} -> ${r.to} (${r.updated})`,
    ),
  ].join('\n');
}
