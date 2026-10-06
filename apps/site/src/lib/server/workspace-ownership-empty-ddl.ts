function quotedColumns(value: string): string[] | null {
  const columns = value.split(',').map((column) => column.trim());
  if (
    columns.length === 0 ||
    columns.some((column) => !/^"[a-z][a-z0-9_]*"$/u.test(column))
  ) {
    return null;
  }
  return columns;
}

/**
 * SMRT emits this exact PostgreSQL 15 compatibility wrapper for a null-equal
 * conflict index. It is the sole procedural DDL admitted to the empty-table
 * phase: both static branches must create the same unique index on the same
 * confirmed-missing table and columns. Any other DO block stays rejected.
 */
export function nullEqualConflictIndexTarget(statement: string): string | null {
  const match =
    /^\s*-- smrt:null-equal-conflict-index\s+DO \$smrt_null_equal\$\s+BEGIN\s+IF current_setting\('server_version_num'\)::integer >= 150000 THEN\s+EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "([a-z][a-z0-9_]*)" ON "([a-z][a-z0-9_]*)" \(([^)]+)\) NULLS NOT DISTINCT';\s+ELSE\s+EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "([a-z][a-z0-9_]*)" ON "([a-z][a-z0-9_]*)" \(([^)]+)\)';\s+END IF;\s+END;\s+\$smrt_null_equal\$;?\s*$/su.exec(
      statement,
    );
  if (!match) return null;
  const [
    ,
    firstIndex,
    firstTable,
    firstColumns,
    secondIndex,
    secondTable,
    secondColumns,
  ] = match;
  const left = quotedColumns(firstColumns);
  const right = quotedColumns(secondColumns);
  if (
    firstIndex !== secondIndex ||
    firstTable !== secondTable ||
    !left ||
    !right ||
    left.join(',') !== right.join(',')
  ) {
    return null;
  }
  return firstTable;
}
