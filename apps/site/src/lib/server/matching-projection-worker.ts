import type { DatabaseInterface } from '@happyvertical/sql';
import {
  loadMatchingCandidateInput,
  loadMatchingVocabulary,
  matchingPostingInput,
} from './matching-projection-input.js';
import {
  liveMatchingOpportunitySql,
  liveMatchingOwnerSql,
  type MatchingDialect,
} from './matching-projection-read.js';
import {
  MATCHING_SOURCE_EXTRACTION_VERSION,
  parseMatchingSourceExtraction,
} from './matching-source-extraction-contract.js';
import { matchingSourceCaptureDigest } from './matching-source-identity.js';
import {
  evaluateNormalizedMatch,
  MATCHING_POLICY_VERSION,
  normalizeMatchingCandidate,
  normalizeMatchingPosting,
} from './normalized-matching.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

const SOURCE_BATCH = 128;
const PROFILE_BATCH = 128;
const PROFILE_SCAN_BATCH = 16;
const PROFILE_IDLE_MS = 30_000;
const vocabularies = new WeakMap<
  DatabaseInterface,
  {
    revision: string;
    data: Awaited<ReturnType<typeof loadMatchingVocabulary>>;
  }
>();
type Row = Record<string, unknown>;
type Scope = CandidateWorkspaceSubject & {
  profileRevision: string;
  vocabularyRevision: string;
};
type Candidate = ReturnType<typeof normalizeMatchingCandidate>;
type Posting = ReturnType<typeof normalizeMatchingPosting>;

export type PendingMatchingDecision = {
  opportunityId: string;
  sourceRevision: string;
  listingRevision: string;
  status: ReturnType<typeof evaluateNormalizedMatch>['status'] | 'failed';
  score: number;
  reasonsJson: string;
};

export type MatchingTick = {
  normalized: number;
  evaluated: number;
  sourceBacklog: boolean;
  profileBacklog: boolean;
};

async function rows(
  db: DatabaseInterface,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const result = await db.query(sql, params);
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function text(value: unknown): string {
  return String(value ?? '');
}

function share(dialect: MatchingDialect, aliases: string): string {
  return dialect === 'postgres' ? ` FOR SHARE OF ${aliases}` : '';
}

function valuesSql(rowCount: number, types: readonly string[]): string {
  const row = `(${types.map((type) => `CAST(? AS ${type})`).join(', ')})`;
  return Array.from({ length: rowCount }, () => row).join(', ');
}

function parseSnapshot<T>(value: unknown): T | null {
  try {
    return JSON.parse(text(value)) as T | null;
  } catch {
    return null;
  }
}

/**
 * Recheck the captured profile and vocabulary generations on the same executor
 * that publishes, holding the PG versions until commit. In SQLite the worker
 * already holds its transaction's write lock. Identity joins guard transferred,
 * deactivated or removed owners independently of the revision checks.
 */
async function lockCurrentMatchingScope(
  db: DatabaseInterface,
  dialect: MatchingDialect,
  scope: Scope,
): Promise<boolean> {
  const [current] = await rows(
    db,
    `
    SELECT pv.profile_id FROM matching_profile_versions pv
    JOIN candidate_profiles p ON CAST(p.id AS TEXT) = pv.profile_id
    JOIN matching_vocabulary_version vv ON vv.id = 1
    WHERE pv.profile_id = ? AND pv.revision = CAST(? AS BIGINT)
      AND CAST(p.tenant_id AS TEXT) = ? AND p.owner_user_id = ? AND p.active = TRUE
      AND vv.revision = CAST(? AS BIGINT) AND ${liveMatchingOwnerSql('p')}
    ${share(dialect, 'pv, vv')}
  `,
    [
      scope.profileId,
      scope.profileRevision,
      scope.tenantId,
      scope.userId,
      scope.vocabularyRevision,
    ],
  );
  return Boolean(current);
}

/** Internal transaction-only publication. A worker never publishes by request-supplied ID. */
export async function publishMatchingBatch(
  db: DatabaseInterface,
  dialect: MatchingDialect,
  scope: Scope,
  decisions: readonly PendingMatchingDecision[],
): Promise<number> {
  if (!decisions.length) return 0;
  if (decisions.length > PROFILE_BATCH)
    throw new Error('Matching publication exceeds its batch bound.');
  if (!(await lockCurrentMatchingScope(db, dialect, scope))) return 0;
  const incoming = decisions.flatMap((decision) => [
    decision.opportunityId,
    decision.sourceRevision,
    decision.listingRevision,
    decision.status,
    decision.score,
    decision.reasonsJson,
  ]);
  const published = await rows(
    db,
    `
    WITH incoming(opportunity_id, source_revision, listing_revision, status, score, reasons_json) AS (
      VALUES ${valuesSql(decisions.length, ['TEXT', 'BIGINT', 'BIGINT', 'TEXT', 'INTEGER', 'TEXT'])}
    ), checked AS (
      SELECT i.* FROM incoming i
      JOIN matching_source_versions sv ON sv.opportunity_id = i.opportunity_id AND sv.revision = i.source_revision
      JOIN opportunities o ON CAST(o.id AS TEXT) = sv.opportunity_id
      JOIN sources s ON s.id = o.source_id AND s.is_active = TRUE AND s.public_listing = TRUE
      JOIN matching_source_listing_versions sl ON sl.source_id = s.id AND sl.revision = i.listing_revision
      WHERE ${liveMatchingOpportunitySql('o', dialect)}
      ${share(dialect, 'sv, sl')}
    )
    INSERT INTO matching_results (
      profile_id, tenant_id, user_id, opportunity_id, profile_revision, source_revision,
      source_listing_revision, vocabulary_revision, policy_version, status, score, reasons_json
    )
    SELECT ?, ?, ?, opportunity_id, CAST(? AS BIGINT), source_revision,
      listing_revision, CAST(? AS BIGINT), ?, status, score, reasons_json
    FROM checked WHERE TRUE
    ON CONFLICT (profile_id, opportunity_id) DO UPDATE SET
      tenant_id = excluded.tenant_id, user_id = excluded.user_id,
      profile_revision = excluded.profile_revision, source_revision = excluded.source_revision,
      source_listing_revision = excluded.source_listing_revision,
      vocabulary_revision = excluded.vocabulary_revision, policy_version = excluded.policy_version,
      status = excluded.status, score = excluded.score, reasons_json = excluded.reasons_json
    RETURNING opportunity_id
  `,
    [
      ...incoming,
      scope.profileId,
      scope.tenantId,
      scope.userId,
      scope.profileRevision,
      scope.vocabularyRevision,
      MATCHING_POLICY_VERSION,
    ],
  );
  return published.length;
}

function normalizeSourceSnapshot(
  row: Row,
  vocabulary: Awaited<ReturnType<typeof loadMatchingVocabulary>>,
): Posting {
  const raw = matchingPostingInput(row);
  if (
    row.interpretation_json &&
    row.input_digest === matchingSourceCaptureDigest(row.source_content_json)
  ) {
    try {
      const interpretation = parseMatchingSourceExtraction(
        JSON.parse(text(row.interpretation_json)),
        raw,
      );
      return normalizeMatchingPosting(raw, vocabulary, interpretation);
    } catch {
      // Invalid or mismatched derived data cannot replace raw hard evidence.
    }
  }
  return normalizeMatchingPosting(raw, vocabulary);
}

async function sourceWork(
  db: DatabaseInterface,
  dialect: MatchingDialect,
  cursor: Row,
  vocabularyRevision: string,
  vocabulary: Awaited<ReturnType<typeof loadMatchingVocabulary>>,
): Promise<Pick<MatchingTick, 'normalized' | 'sourceBacklog'>> {
  // Event revisions are a fast path. A concurrent PG writer can allocate a
  // revision before another commits it; the independent ID sweep catches it.
  const [events, sweep] = await Promise.all([
    rows(
      db,
      `SELECT opportunity_id, revision FROM matching_source_versions
      WHERE revision > CAST(? AS BIGINT) ORDER BY revision LIMIT ${SOURCE_BATCH / 2}`,
      [text(cursor.source_event_revision)],
    ),
    rows(
      db,
      `SELECT opportunity_id FROM matching_source_versions
      WHERE opportunity_id > ? ORDER BY opportunity_id LIMIT ${SOURCE_BATCH / 2}`,
      [text(cursor.source_cursor)],
    ),
  ]);
  const ids = [
    ...new Set([...events, ...sweep].map((row) => text(row.opportunity_id))),
  ];
  let workRevision = BigInt(text(cursor.work_revision));
  let normalized = 0;
  if (ids.length) {
    const stale = await rows(
      db,
      `
      SELECT sv.opportunity_id, sv.revision AS source_revision,
        sl.revision AS listing_revision, o.title, o.description_raw, o.locations,
        o.location_notes, o.work_mode, o.source_content_json, o.source_content_version, o.source_content_fingerprint,
        x.input_digest, x.payload_json AS interpretation_json
      FROM matching_source_versions sv
      JOIN opportunities o ON CAST(o.id AS TEXT) = sv.opportunity_id
      JOIN sources s ON s.id = o.source_id AND s.is_active = TRUE AND s.public_listing = TRUE
      JOIN matching_source_listing_versions sl ON sl.source_id = s.id
      LEFT JOIN matching_source_interpretations x ON x.opportunity_id = sv.opportunity_id
        AND x.state = 'complete' AND x.contract_version = ?
        AND x.source_fingerprint = o.source_content_fingerprint AND x.source_content_version = o.source_content_version
      LEFT JOIN matching_source_facts f ON f.opportunity_id = sv.opportunity_id
        AND f.source_revision = sv.revision AND f.source_listing_revision = sl.revision
        AND f.vocabulary_revision = CAST(? AS BIGINT) AND f.policy_version = ?
      WHERE f.opportunity_id IS NULL AND sv.opportunity_id IN (${ids.map(() => '?').join(', ')})
        AND ${liveMatchingOpportunitySql('o', dialect)}
      ORDER BY sv.opportunity_id
      ${share(dialect, 'sv, sl')}
    `,
      [
        MATCHING_SOURCE_EXTRACTION_VERSION,
        vocabularyRevision,
        MATCHING_POLICY_VERSION,
        ...ids,
      ],
    );
    if (stale.length) {
      const facts = stale.flatMap((row) => [
        row.opportunity_id,
        row.source_revision,
        row.listing_revision,
        vocabularyRevision,
        MATCHING_POLICY_VERSION,
        JSON.stringify(normalizeSourceSnapshot(row, vocabulary)),
        (++workRevision).toString(),
      ]);
      await db.query(
        `
        INSERT INTO matching_source_facts(
          opportunity_id, source_revision, source_listing_revision, vocabulary_revision,
          policy_version, facts_json, work_revision
        ) VALUES ${valuesSql(stale.length, ['TEXT', 'BIGINT', 'BIGINT', 'BIGINT', 'TEXT', 'TEXT', 'BIGINT'])}
        ON CONFLICT(opportunity_id) DO UPDATE SET
          source_revision = excluded.source_revision, source_listing_revision = excluded.source_listing_revision,
          vocabulary_revision = excluded.vocabulary_revision, policy_version = excluded.policy_version,
          facts_json = excluded.facts_json, work_revision = excluded.work_revision
      `,
        facts,
      );
      normalized = stale.length;
    }
  }
  await db.query(
    `
    UPDATE matching_worker_cursor SET source_cursor = ?, source_event_revision = CAST(? AS BIGINT),
      work_revision = CAST(? AS BIGINT) WHERE id = 1
  `,
    [
      sweep.length === SOURCE_BATCH / 2
        ? text(sweep.at(-1)?.opportunity_id)
        : '',
      text(events.at(-1)?.revision ?? cursor.source_event_revision),
      workRevision.toString(),
    ],
  );
  return {
    normalized,
    sourceBacklog: events.length === SOURCE_BATCH / 2 || normalized > 0,
  };
}

async function profileWork(
  db: DatabaseInterface,
  dialect: MatchingDialect,
  cursor: Row,
  vocabularyRevision: string,
  vocabulary: Awaited<ReturnType<typeof loadMatchingVocabulary>>,
  now: number,
): Promise<Pick<MatchingTick, 'evaluated' | 'profileBacklog'>> {
  // Bound the number of owners inspected even when none are ready. A
  // durable round-robin cursor keeps an expensive or inactive workspace
  // from hiding later profiles behind an unbounded filtered scan.
  const scan = await rows(
    db,
    `
    WITH page AS (
      SELECT profile_id FROM matching_profile_versions
      WHERE profile_id > ? ORDER BY profile_id LIMIT ${PROFILE_SCAN_BATCH}
    )
    SELECT page.profile_id, pv.revision AS profile_revision,
      CAST(p.tenant_id AS TEXT) AS tenant_id, p.owner_user_id AS user_id,
      f.facts_json, f.status, f.cursor,
      CASE WHEN p.id IS NOT NULL AND p.active = TRUE AND ${liveMatchingOwnerSql('p')}
        AND (f.profile_id IS NULL OR f.next_run_at <= CAST(? AS BIGINT)
          OR (f.status <> 'missing-preferences' AND f.cursor < c.work_revision))
      THEN 1 ELSE 0 END AS due
    FROM page
    JOIN matching_profile_versions pv ON pv.profile_id = page.profile_id
    LEFT JOIN candidate_profiles p ON CAST(p.id AS TEXT) = pv.profile_id
    LEFT JOIN matching_profile_facts f ON f.profile_id = pv.profile_id AND f.profile_revision = pv.revision
      AND f.vocabulary_revision = CAST(? AS BIGINT) AND f.policy_version = ?
    JOIN matching_worker_cursor c ON c.id = 1
    ORDER BY page.profile_id
  `,
    [
      text(cursor.profile_cursor),
      now,
      vocabularyRevision,
      MATCHING_POLICY_VERSION,
    ],
  );
  const profile = scan.find((row) => Number(row.due) === 1);
  if (!profile) {
    await db.query(
      'UPDATE matching_worker_cursor SET profile_cursor = ? WHERE id = 1',
      [scan.length === PROFILE_SCAN_BATCH ? text(scan.at(-1)?.profile_id) : ''],
    );
    return {
      evaluated: 0,
      profileBacklog:
        scan.length === PROFILE_SCAN_BATCH || Boolean(cursor.profile_cursor),
    };
  }
  const scope = {
    profileId: text(profile.profile_id),
    tenantId: text(profile.tenant_id),
    userId: text(profile.user_id),
    profileRevision: text(profile.profile_revision),
    vocabularyRevision,
  };
  await db.query(
    'UPDATE matching_worker_cursor SET profile_cursor = ? WHERE id = 1',
    [scope.profileId],
  );
  if (!(await lockCurrentMatchingScope(db, dialect, scope)))
    return { evaluated: 0, profileBacklog: true };
  let candidate = parseSnapshot<Candidate>(profile.facts_json);
  let status = text(profile.status) || 'pending';
  let position = text(profile.cursor ?? '0');
  if (!candidate) {
    const input = await loadMatchingCandidateInput(db, scope);
    if (!input) return { evaluated: 0, profileBacklog: false };
    candidate = normalizeMatchingCandidate(input, vocabulary);
    position = '0';
    status =
      !candidate.roles.length ||
      (!input.locations.length && !input.remoteCountries?.length)
        ? 'missing-preferences'
        : 'pending';
  }

  let evaluated = 0;
  let backlog = false;
  if (status !== 'missing-preferences') {
    const postings = await rows(
      db,
      `
      SELECT opportunity_id, source_revision, source_listing_revision, facts_json, work_revision
      FROM matching_source_facts
      WHERE work_revision > CAST(? AS BIGINT) AND vocabulary_revision = CAST(? AS BIGINT)
        AND policy_version = ?
      ORDER BY work_revision LIMIT ${PROFILE_BATCH}
    `,
      [position, vocabularyRevision, MATCHING_POLICY_VERSION],
    );
    const decisions: PendingMatchingDecision[] = postings.map((row) => {
      const posting = parseSnapshot<Posting>(row.facts_json);
      const match = posting
        ? evaluateNormalizedMatch(posting, candidate)
        : null;
      return {
        opportunityId: text(row.opportunity_id),
        sourceRevision: text(row.source_revision),
        listingRevision: text(row.source_listing_revision),
        status: match?.status ?? 'failed',
        score: match?.score ?? 0,
        // Snapshots retain the quoted text. Pair rows retain locators only,
        // avoiding a copy of private candidate text for every posting.
        reasonsJson: JSON.stringify(
          match?.reasons.map(({ citations, ...reason }) => ({
            ...reason,
            citations: citations.map(({ field, id, start, end }) => ({
              field,
              id,
              start,
              end,
            })),
          })) ?? [],
        ),
      };
    });
    evaluated = await publishMatchingBatch(db, dialect, scope, decisions);
    position = text(postings.at(-1)?.work_revision ?? cursor.work_revision);
    // An empty feed may be behind a removed source work item. Use the current
    // watermark so it cannot monopolize the next scheduling tick.
    if (!postings.length) {
      const [clock] = await rows(
        db,
        'SELECT work_revision FROM matching_worker_cursor WHERE id = 1',
      );
      position = text(clock?.work_revision ?? position);
    }
    backlog = postings.length === PROFILE_BATCH;
    if (backlog) status = 'pending';
    else {
      const hasStatus = async (decision: string) =>
        (
          await rows(
            db,
            `
          SELECT 1 FROM matching_results
          WHERE profile_id = ? AND profile_revision = CAST(? AS BIGINT)
            AND vocabulary_revision = CAST(? AS BIGINT) AND policy_version = ?
            AND status = ? LIMIT 1
        `,
            [
              scope.profileId,
              scope.profileRevision,
              scope.vocabularyRevision,
              MATCHING_POLICY_VERSION,
              decision,
            ],
          )
        ).length > 0;
      const privateGap =
        candidate.evidence.length === 0 ||
        candidate.uncertainties.some(
          ({ code }) => code !== 'candidate-role-choice-unknown',
        ) ||
        candidate.questions.some((question) => !question.query);
      status = (await hasStatus('qualified'))
        ? 'ready'
        : (await hasStatus('failed'))
          ? 'failed'
          : privateGap && (await hasStatus('insufficient-evidence'))
            ? 'needs-evidence'
            : 'ready';
    }
  }
  if (!(await lockCurrentMatchingScope(db, dialect, scope)))
    return { evaluated, profileBacklog: backlog };
  await db.query(
    `
    INSERT INTO matching_profile_facts (profile_id, tenant_id, user_id, profile_revision, vocabulary_revision,
      policy_version, facts_json, status, cursor, next_run_at)
    VALUES (?, ?, ?, CAST(? AS BIGINT), CAST(? AS BIGINT), ?, ?, ?, CAST(? AS BIGINT), CAST(? AS BIGINT))
    ON CONFLICT(profile_id) DO UPDATE SET tenant_id = excluded.tenant_id, user_id = excluded.user_id,
      profile_revision = excluded.profile_revision, vocabulary_revision = excluded.vocabulary_revision,
      policy_version = excluded.policy_version, facts_json = excluded.facts_json, status = excluded.status,
      cursor = excluded.cursor, next_run_at = excluded.next_run_at
  `,
    [
      scope.profileId,
      scope.tenantId,
      scope.userId,
      scope.profileRevision,
      vocabularyRevision,
      MATCHING_POLICY_VERSION,
      JSON.stringify(candidate),
      status,
      position,
      backlog ? 0 : now + PROFILE_IDLE_MS,
    ],
  );
  return { evaluated, profileBacklog: backlog };
}

/**
 * Each bounded transaction processes a source page and one profile's feed page.
 * The persisted cursor row is the lease, released by commit/rollback/crash.
 * Work and checkpoints commit together; another process resumes the same feed.
 */
export function runMatchingTick(
  database: DatabaseInterface,
  dialect: MatchingDialect,
  now = Date.now(),
): Promise<MatchingTick> {
  if (!database.transaction)
    throw new Error('Matching requires native transactions.');
  return database.transaction(async (db) => {
    if (dialect === 'postgres') {
      await db.query("SET LOCAL lock_timeout = '2s'");
      await db.query("SET LOCAL statement_timeout = '5s'");
    }
    const [cursor] = await rows(
      db,
      'UPDATE matching_worker_cursor SET id = id WHERE id = 1 RETURNING *',
    );
    const [version] = await rows(
      db,
      `SELECT revision FROM matching_vocabulary_version v WHERE id = 1${share(dialect, 'v')}`,
    );
    if (!cursor || !version)
      throw new Error('Matching schema is not initialized.');
    const vocabularyRevision = text(version.revision);
    let compiled = vocabularies.get(database);
    if (compiled?.revision !== vocabularyRevision) {
      compiled = {
        revision: vocabularyRevision,
        data: await loadMatchingVocabulary(db),
      };
      vocabularies.set(database, compiled);
    }
    const vocabulary = compiled.data;
    const sources = await sourceWork(
      db,
      dialect,
      cursor,
      vocabularyRevision,
      vocabulary,
    );
    const profiles = await profileWork(
      db,
      dialect,
      cursor,
      vocabularyRevision,
      vocabulary,
      now,
    );
    return { ...sources, ...profiles };
  });
}

export function startMatchingWorker(
  database: DatabaseInterface,
  dialect: MatchingDialect,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let consecutiveFailures = 0;
  const tick = () => {
    if (stopped) return;
    running = (async () => {
      let delay = 1_000;
      try {
        const result = await runMatchingTick(database, dialect);
        consecutiveFailures = 0;
        delay = result.sourceBacklog || result.profileBacklog ? 25 : 1_000;
      } catch {
        // Keep retries bounded and never include private input in operator logs.
        consecutiveFailures += 1;
        console.error(
          'Matching worker could not process a batch; it will retry.',
        );
        delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, consecutiveFailures));
      }
      if (!stopped) timer = setTimeout(tick, delay);
    })();
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
