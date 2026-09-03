import {
  ensureChangeFeedTable,
  getTenantScopedChangesSince,
  resolveDatabase,
} from '@happyvertical/smrt-core';
import { json, type RequestHandler } from '@sveltejs/kit';
import { getDatabaseUrl, getDbConfig } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const since = Number(url.searchParams.get('since') ?? '0');
  if (!Number.isFinite(since) || since < 0) {
    return json(
      { error: "'since' must be a non-negative number" },
      { status: 400 },
    );
  }

  let limit: number | undefined;
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isFinite(limit) || limit < 1) {
      return json(
        { error: "'limit' must be a positive number" },
        { status: 400 },
      );
    }
  }

  const tablesParam = url.searchParams.get('tables');
  const tables = tablesParam
    ? tablesParam
        .split(',')
        .map((table) => table.trim())
        .filter(Boolean)
    : undefined;

  const db = await resolveDatabase(getDbConfig(), {
    dbid: `smrt:${getDatabaseUrl()}`,
  });
  await ensureChangeFeedTable(db);
  return json(
    await getTenantScopedChangesSince(db, {
      limit,
      since: Math.floor(since),
      tables,
    }),
  );
};
