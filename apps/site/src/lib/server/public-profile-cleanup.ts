const PUBLIC_PROFILE_PREFIX = 'public-profiles';
const MAX_CANDIDATES = 100;
const MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000;
const UUID =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PUBLIC_PDF_PATH = new RegExp(
  `^${PUBLIC_PROFILE_PREFIX}/${UUID}/${UUID}/resume\\.pdf$`,
  'i',
);

export interface PublicProfileCleanupDatabase {
  query(
    statement: string,
    values?: unknown[],
  ): Promise<
    { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
  >;
}

export interface PublicProfileCleanupFilesystem {
  delete(path: string): Promise<void>;
  getStats(path: string): Promise<{ isFile: boolean; mtime: Date }>;
  list(
    path: string,
    options: { recursive: boolean; detailed: boolean },
  ): Promise<Array<{ isDirectory: boolean; path: string }>>;
}

export interface PublicProfileCleanupOptions {
  /** Resume from this exact candidate path after a bounded prior scan. */
  afterPath?: string;
  /** Required so this destructive operation cannot run from the application. */
  appStopped: boolean;
  /** Required acknowledgement that no publisher is concurrently creating files. */
  offlineConfirmed: boolean;
  /** Defaults to true: report the plan without deleting any object. */
  dryRun?: boolean;
  now?: Date;
}

export interface PublicProfileCleanupResult {
  candidates: string[];
  deleted: string[];
  dryRun: boolean;
  nextCursor?: string;
  referenced: number;
  scanned: number;
}

function rows(
  result:
    | { rows?: Array<Record<string, unknown>> }
    | Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function referencedPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const path = (value as Record<string, unknown>).pdfPath;
  return typeof path === 'string' && PUBLIC_PDF_PATH.test(path)
    ? path
    : undefined;
}

/**
 * Builds the complete plan before deleting anything. Only a local, stopped
 * deployment may run this: remote/object providers need provider-specific,
 * paginated inventory semantics before they can safely support cleanup.
 */
export async function reconcilePublicProfileOrphans(
  filesystem: PublicProfileCleanupFilesystem,
  database: PublicProfileCleanupDatabase,
  options: PublicProfileCleanupOptions,
): Promise<PublicProfileCleanupResult> {
  if (!options.offlineConfirmed || !options.appStopped)
    throw new Error(
      'Public-profile cleanup requires offline confirmation and a stopped application.',
    );
  if (options.afterPath && !PUBLIC_PDF_PATH.test(options.afterPath))
    throw new Error('Public-profile cleanup cursor is invalid.');

  const now = options.now ?? new Date();
  const cutoff = now.getTime() - MINIMUM_AGE_MS;
  let listed: Awaited<ReturnType<PublicProfileCleanupFilesystem['list']>>;
  try {
    listed = await filesystem.list(PUBLIC_PROFILE_PREFIX, {
      recursive: true,
      detailed: false,
    });
  } catch (cause) {
    throw new Error(
      'Public-profile cleanup aborted because filesystem listing failed.',
      { cause },
    );
  }

  // Stat every matching object before querying or deleting. A partial/inexact
  // listing is never treated as permission to delete.
  const matchingPaths = listed
    .filter((entry) => !entry.isDirectory && PUBLIC_PDF_PATH.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  const afterPath = options.afterPath;
  const remainingPaths = afterPath
    ? matchingPaths.filter((path) => path > afterPath)
    : matchingPaths;
  const pathsToInspect = remainingPaths.slice(0, MAX_CANDIDATES);
  const nextCursor =
    remainingPaths.length > MAX_CANDIDATES ? pathsToInspect.at(-1) : undefined;
  const candidates: string[] = [];
  try {
    for (const path of pathsToInspect) {
      const stats = await filesystem.getStats(path);
      if (!(stats.mtime instanceof Date) || Number.isNaN(stats.mtime.getTime()))
        throw new Error(
          'Public-profile cleanup aborted because filesystem stat returned an invalid modification time.',
        );
      if (!stats.isFile || stats.mtime.getTime() >= cutoff) continue;
      candidates.push(path);
    }
  } catch (cause) {
    throw new Error(
      'Public-profile cleanup aborted because filesystem stat failed.',
      { cause },
    );
  }
  let referenced: Set<string>;
  try {
    const result = await database.query(
      `SELECT pdf_path AS "pdfPath" FROM public_profile_revisions WHERE pdf_path LIKE ?`,
      [`${PUBLIC_PROFILE_PREFIX}/%`],
    );
    referenced = new Set(
      rows(result).flatMap((row) => {
        const path = referencedPath(row);
        return path ? [path] : [];
      }),
    );
  } catch (cause) {
    throw new Error(
      'Public-profile cleanup aborted because the revision lookup failed.',
      { cause },
    );
  }

  const orphanPaths = candidates.filter((path) => !referenced.has(path));
  const dryRun = options.dryRun ?? true;
  if (dryRun) {
    return {
      candidates: orphanPaths,
      deleted: [],
      dryRun: true,
      nextCursor,
      referenced: referenced.size,
      scanned: pathsToInspect.length,
    };
  }

  // The whole list/query/stat plan above must succeed before the first delete.
  const deleted: string[] = [];
  for (const path of orphanPaths) {
    try {
      await filesystem.delete(path);
      deleted.push(path);
    } catch (cause) {
      throw new Error(
        `Public-profile cleanup stopped after ${deleted.length} deletion(s).`,
        {
          cause,
        },
      );
    }
  }
  return {
    candidates: orphanPaths,
    deleted,
    dryRun: false,
    nextCursor,
    referenced: referenced.size,
    scanned: pathsToInspect.length,
  };
}

export function isSupportedPublicProfileCleanupProvider(
  type: string | undefined,
): boolean {
  return type === 'local';
}
