interface DbLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rowCount?: number | null } | undefined>;
}

export interface AchievementPlacementBackfillResult {
  updated: number;
}

export async function backfillAchievementPlacement(
  db: DbLike,
): Promise<AchievementPlacementBackfillResult> {
  const result = await db.query(
    `UPDATE achievements
     SET resume_placement = $1
     WHERE resume_placement IS NULL OR btrim(resume_placement) = ''`,
    ['auto'],
  );
  return {
    updated: typeof result?.rowCount === 'number' ? result.rowCount : 0,
  };
}

export function formatAchievementPlacementBackfillSummary(
  result: AchievementPlacementBackfillResult,
): string {
  return result.updated > 0
    ? `Achievement placement backfill: set ${result.updated} blank rows to auto.`
    : 'Achievement placement backfill: nothing to update.';
}
