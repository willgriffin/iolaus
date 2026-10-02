import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';
import type { WorkspaceOpportunityQuery } from './admin-opportunity-query.js';
import { OPPORTUNITY_ASSESSMENT_VERSION } from './opportunity-assessment.js';

const mocks = vi.hoisted(() => ({
  config: { type: 'sqlite' },
  database: undefined as DatabaseInterface | undefined,
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => {
    if (!mocks.database) throw new Error('Test database is not initialized.');
    return mocks.database;
  }),
}));

vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: vi.fn(() => undefined),
}));

vi.mock('./db.js', () => ({
  getDbConfig: vi.fn(() => mocks.config),
}));

const postgresUrl = process.env.TRIAGE_TEST_POSTGRES_URL?.trim();
const TEST_WORKSPACE_SUBJECT = {
  profileId: 'profile-a',
  tenantId: 'tenant-a',
  userId: 'user-a',
} as const;

async function createTables(
  database: DatabaseInterface,
  dialect: 'postgres' | 'sqlite',
): Promise<void> {
  const createOpportunityTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} opportunities (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    human_review_status TEXT,
    source_content_fingerprint TEXT,
    source_content_version INTEGER,
    eligibility_flags INTEGER,
    eligibility_source_fingerprint TEXT,
    eligibility_source_version INTEGER,
    scoring_material_fingerprint TEXT,
    updated_at TIMESTAMP,
    posted_at TIMESTAMP,
    first_seen_at TIMESTAMP,
    company_id TEXT,
    title TEXT,
    description_summary TEXT,
    required_skills TEXT,
    preferred_skills TEXT,
    locations TEXT,
    posting_url TEXT,
    expires_at TIMESTAMP,
    freshness TEXT,
    salary_min REAL,
    salary_max REAL,
    human_rating REAL,
    employment_type TEXT,
    seniority TEXT,
    work_mode TEXT
  )`;
  const createScoreTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} evaluation_scores (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    source_content_fingerprint TEXT,
    scoring_material_fingerprint TEXT,
    created_by_profile_id TEXT,
    tenant_id TEXT,
    owner_user_id TEXT,
    candidate_profile_id TEXT,
    updated_at TIMESTAMP,
    score REAL,
    recommendation TEXT,
    summary TEXT
  )`;
  const createCompanyTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} companies (
    id TEXT PRIMARY KEY,
    name TEXT
  )`;
  const createApplicationTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} applications (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    tenant_id TEXT,
    owner_user_id TEXT,
    candidate_profile_id TEXT,
    updated_at TIMESTAMP,
    status TEXT,
    resume_mode TEXT,
    cover_letter_mode TEXT
  )`;
  const createDecisionTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} decisions (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    tenant_id TEXT,
    owner_user_id TEXT,
    candidate_profile_id TEXT,
    decision TEXT,
    human_rating INTEGER,
    reason TEXT,
    decider_profile_id TEXT,
    decider_user_id TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
  )`;
  const createAssessmentTable = `CREATE ${
    dialect === 'postgres' ? 'TEMP ' : ''
  }TABLE${dialect === 'postgres' ? ' IF NOT EXISTS' : ''} opportunity_assessments (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    tenant_id TEXT,
    owner_user_id TEXT,
    candidate_profile_id TEXT,
    source_content_fingerprint TEXT,
    source_content_version INTEGER,
    candidate_material_fingerprint TEXT,
    preferences_fingerprint TEXT,
    contract_version TEXT,
    status TEXT,
    eligibility_bucket TEXT,
    eligibility_priority INTEGER,
    fit_score INTEGER,
    match_readiness TEXT,
    excluded BOOLEAN,
    updated_at TIMESTAMP
  )`;
  if (dialect === 'postgres') {
    // The opt-in suite never names a persistent table. `pg_temp` resolves only
    // for this test connection, so reset cannot touch the supplied database.
    await database.query(createOpportunityTable);
    await database.query(createScoreTable);
    await database.query(createCompanyTable);
    await database.query(createApplicationTable);
    await database.query(createDecisionTable);
    await database.query(createAssessmentTable);
    await database.query(
      'TRUNCATE TABLE pg_temp.evaluation_scores, pg_temp.opportunities, pg_temp.companies, pg_temp.applications, pg_temp.decisions, pg_temp.opportunity_assessments',
    );
  } else {
    await database.query('DROP TABLE IF EXISTS evaluation_scores');
    await database.query('DROP TABLE IF EXISTS opportunities');
    await database.query('DROP TABLE IF EXISTS companies');
    await database.query('DROP TABLE IF EXISTS applications');
    await database.query('DROP TABLE IF EXISTS decisions');
    await database.query('DROP TABLE IF EXISTS opportunity_assessments');
    await database.query(createOpportunityTable);
    await database.query(createScoreTable);
    await database.query(createCompanyTable);
    await database.query(createApplicationTable);
    await database.query(createDecisionTable);
    await database.query(createAssessmentTable);
  }
  const opportunityTable =
    dialect === 'postgres' ? 'pg_temp.opportunities' : 'opportunities';
  const scoreTable =
    dialect === 'postgres' ? 'pg_temp.evaluation_scores' : 'evaluation_scores';
  const assessmentTable =
    dialect === 'postgres'
      ? 'pg_temp.opportunity_assessments'
      : 'opportunity_assessments';
  const decisionTable =
    dialect === 'postgres' ? 'pg_temp.decisions' : 'decisions';
  const tabNewlineReject =
    dialect === 'postgres'
      ? "chr(9) || 'reject' || chr(10)"
      : "char(9) || 'reject' || char(10)";
  const nbspBomReject =
    dialect === 'postgres'
      ? "chr(160) || chr(65279) || 'reject' || chr(160)"
      : "char(160) || char(65279) || 'reject' || char(160)";
  await database.query(`INSERT INTO ${opportunityTable}
    (id, status, human_review_status, source_content_fingerprint, source_content_version, scoring_material_fingerprint, updated_at, posted_at)
    VALUES
    ('reject-100', 'recommended', '', 'current-reject', 1, 'material', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    ('recommend-96', 'recommended', '', 'current-recommend', 1, 'material', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
    ('score-96-tie', 'recommended', '', 'current-score-tie', 1, 'material', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
    ('unscored', 'recommended', '', 'current-unscored', 1, 'material', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
    ('unknown-90', 'recommended', '', 'current-unknown', 1, 'material', '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z'),
    ('reject-20', 'recommended', '', 'current-reject-low', 1, 'material', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z'),
    ('matches-list-context', 'found', '', 'match-current', 1, 'material', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    ('wrong-skill', 'found', '', 'wrong-skill-current', 1, 'material', '2026-02-02T00:00:00Z', '2026-02-02T00:00:00Z'),
    ('wrong-search', 'found', '', 'wrong-search-current', 1, 'material', '2026-02-03T00:00:00Z', '2026-02-03T00:00:00Z'),
    ('wrong-status', 'recommended', '', 'wrong-status-current', 1, 'material', '2026-02-04T00:00:00Z', '2026-02-04T00:00:00Z'),
    ('expired', 'found', '', 'expired-current', 1, 'material', '2026-02-05T00:00:00Z', '2026-02-05T00:00:00Z'),
    ('stale', 'found', '', 'stale-current', 1, 'material', '2026-02-06T00:00:00Z', '2026-02-06T00:00:00Z'),
    ('decided', 'found', 'apply', 'decided-current', 1, 'material', '2026-02-07T00:00:00Z', '2026-02-07T00:00:00Z')`);
  await database.query(`UPDATE ${opportunityTable}
    SET title = 'Platform Rust Engineer',
        description_summary = 'A platform role',
        required_skills = 'Rust, TypeScript',
        preferred_skills = 'PostgreSQL',
        locations = 'Remote',
        posting_url = 'https://example.test/platform-rust',
        expires_at = '2099-01-01T00:00:00Z',
        freshness = 'fresh',
        salary_min = 120000,
        salary_max = 160000,
        human_rating = 4
    WHERE id IN ('matches-list-context', 'wrong-skill', 'wrong-search', 'wrong-status', 'expired', 'stale', 'decided')`);
  await database.query(`UPDATE ${opportunityTable}
    SET required_skills = 'Java', preferred_skills = 'Kotlin'
    WHERE id = 'wrong-skill'`);
  await database.query(`UPDATE ${opportunityTable}
    SET title = 'Infrastructure Engineer', description_summary = 'A systems role',
        posting_url = 'https://example.test/infrastructure'
    WHERE id = 'wrong-search'`);
  await database.query(`UPDATE ${opportunityTable}
    SET expires_at = '2000-01-01T00:00:00Z' WHERE id = 'expired'`);
  await database.query(`UPDATE ${opportunityTable}
    SET freshness = 'stale' WHERE id = 'stale'`);
  await database.query(`INSERT INTO ${scoreTable}
    (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
     source_content_fingerprint, scoring_material_fingerprint, created_by_profile_id, updated_at, score, recommendation)
    VALUES
    ('reject-100-current', 'reject-100', 'tenant-a', 'user-a', 'profile-a', 'current-reject', 'material', '', '2026-01-06T00:00:00Z', 100, ${tabNewlineReject}),
    ('recommend-96-current', 'recommend-96', 'tenant-a', 'user-a', 'profile-a', 'current-recommend', 'material', '', '2026-01-06T00:00:00Z', 96, 'recommend'),
    ('score-96-tie-current', 'score-96-tie', 'tenant-a', 'user-a', 'profile-a', 'current-score-tie', 'material', '', '2026-01-06T00:00:00Z', 96, 'recommend'),
    ('unknown-90-current', 'unknown-90', 'tenant-a', 'user-a', 'profile-a', 'current-unknown', 'material', '', '2026-01-06T00:00:00Z', 90, 'unknown'),
    ('reject-20-current', 'reject-20', 'tenant-a', 'user-a', 'profile-a', 'current-reject-low', 'material', '', '2026-01-06T00:00:00Z', 20, ${nbspBomReject}),
    ('unscored-stale', 'unscored', 'tenant-a', 'user-a', 'profile-a', 'stale-content', 'material', '', '2026-01-07T00:00:00Z', 98, 'reject'),
    ('matches-list-context-score', 'matches-list-context', 'tenant-a', 'user-a', 'profile-a', 'match-current', 'material', '', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('wrong-skill-score', 'wrong-skill', 'tenant-a', 'user-a', 'profile-a', 'wrong-skill-current', 'material', '', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('wrong-search-score', 'wrong-search', 'tenant-a', 'user-a', 'profile-a', 'wrong-search-current', 'material', '', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('wrong-status-score', 'wrong-status', 'tenant-a', 'user-a', 'profile-a', 'wrong-status-current', 'material', '', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('expired-score', 'expired', 'tenant-a', 'user-a', 'profile-a', 'expired-current', 'material', '', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('stale-score', 'stale', 'tenant-a', 'user-a', 'profile-a', 'stale-current', 'material', '', '2026-02-08T00:00:00Z', 80, 'recommend'),
    ('decided-score', 'decided', 'tenant-a', 'user-a', 'profile-a', 'decided-current', 'material', '', '2026-02-08T00:00:00Z', 80, 'recommend')`);
  await database.query(`INSERT INTO ${assessmentTable}
    (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
     source_content_fingerprint, source_content_version,
     candidate_material_fingerprint, preferences_fingerprint, contract_version,
     status, eligibility_bucket, eligibility_priority, fit_score, match_readiness, excluded, updated_at)
    VALUES
    ('assessment-reject-100', 'reject-100', 'tenant-a', 'user-a', 'profile-a', 'current-reject', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 100, 'assessable', TRUE, '2026-01-06T00:00:00Z'),
    ('assessment-recommend-96', 'recommend-96', 'tenant-a', 'user-a', 'profile-a', 'current-recommend', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 96, 'assessable', FALSE, '2026-01-06T00:00:00Z'),
    ('assessment-score-96-tie', 'score-96-tie', 'tenant-a', 'user-a', 'profile-a', 'current-score-tie', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 96, 'assessable', FALSE, '2026-01-06T00:00:00Z'),
    ('assessment-unknown-90', 'unknown-90', 'tenant-a', 'user-a', 'profile-a', 'current-unknown', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'unknown', 9, 90, 'assessable', FALSE, '2026-01-06T00:00:00Z'),
    ('assessment-reject-20', 'reject-20', 'tenant-a', 'user-a', 'profile-a', 'current-reject-low', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 20, 'assessable', TRUE, '2026-01-06T00:00:00Z'),
    ('assessment-matches', 'matches-list-context', 'tenant-a', 'user-a', 'profile-a', 'match-current', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 80, 'assessable', FALSE, '2026-02-08T00:00:00Z'),
    ('assessment-wrong-skill', 'wrong-skill', 'tenant-a', 'user-a', 'profile-a', 'wrong-skill-current', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 80, 'assessable', FALSE, '2026-02-08T00:00:00Z'),
    ('assessment-wrong-search', 'wrong-search', 'tenant-a', 'user-a', 'profile-a', 'wrong-search-current', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 80, 'assessable', FALSE, '2026-02-08T00:00:00Z'),
    ('assessment-wrong-status', 'wrong-status', 'tenant-a', 'user-a', 'profile-a', 'wrong-status-current', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 80, 'assessable', FALSE, '2026-02-08T00:00:00Z'),
    ('assessment-expired', 'expired', 'tenant-a', 'user-a', 'profile-a', 'expired-current', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 80, 'assessable', FALSE, '2026-02-08T00:00:00Z'),
    ('assessment-stale', 'stale', 'tenant-a', 'user-a', 'profile-a', 'stale-current', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 80, 'assessable', FALSE, '2026-02-08T00:00:00Z'),
    ('assessment-decided', 'decided', 'tenant-a', 'user-a', 'profile-a', 'decided-current', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 80, 'assessable', FALSE, '2026-02-08T00:00:00Z')`);
  await database.query(`INSERT INTO ${decisionTable}
    (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id, decision, created_at)
    VALUES ('decision-decided', 'decided', 'tenant-a', 'user-a', 'profile-a', 'accept_to_apply', '2026-02-08T00:00:00Z')`);
}

function query(triageRejectDepriority = false) {
  return {
    candidateSkills: [],
    filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'score' as const },
    reviewFilter: 'unsorted',
    triageRejectDepriority,
    assessmentCandidateMaterialFingerprint: 'candidate-material',
    assessmentPreferencesFingerprint: 'preferences',
    workspaceSubject: TEST_WORKSPACE_SUBJECT,
  };
}

const listContextRankings = [
  {
    expected: [
      'reject-100',
      'recommend-96',
      'score-96-tie',
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
    ],
    sort: 'best' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'reject-100',
      'recommend-96',
      'score-96-tie',
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
    ],
    sort: 'best' as const,
    sortDirection: 'desc' as const,
  },
  {
    expected: [
      'reject-100',
      'recommend-96',
      'score-96-tie',
      'unscored',
      'unknown-90',
      'reject-20',
      'wrong-status',
    ],
    sort: 'newest' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'newest' as const,
    sortDirection: 'desc' as const,
  },
  {
    expected: [
      'reject-20',
      'wrong-status',
      'unknown-90',
      'recommend-96',
      'score-96-tie',
      'reject-100',
      'unscored',
    ],
    sort: 'score' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'reject-100',
      'recommend-96',
      'score-96-tie',
      'unknown-90',
      'wrong-status',
      'reject-20',
      'unscored',
    ],
    sort: 'score' as const,
    sortDirection: 'desc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'salary' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'salary' as const,
    sortDirection: 'desc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'rating' as const,
    sortDirection: 'asc' as const,
  },
  {
    expected: [
      'wrong-status',
      'reject-20',
      'unknown-90',
      'unscored',
      'recommend-96',
      'score-96-tie',
      'reject-100',
    ],
    sort: 'rating' as const,
    sortDirection: 'desc' as const,
  },
] as const;

function runSuite(
  label: string,
  config: { type: 'postgres' | 'sqlite'; url: string },
) {
  describe(label, () => {
    let database: DatabaseInterface;

    beforeAll(async () => {
      database = await getDatabase(
        config.type === 'postgres'
          ? { cache: false, ...config, max: 1 }
          : { cache: false, ...config },
      );
      mocks.config = { type: config.type };
      mocks.database = database;
    });

    beforeEach(async () => {
      await createTables(database, config.type);
    });

    afterAll(async () => {
      await database?.close?.();
      mocks.database = undefined;
    });

    it('orders current nonrejects before explicit rejects and preserves paging', async () => {
      const { listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const first = await listOpportunityPageIds({
        ...query(true),
        limit: 3,
        offset: 0,
      });
      const second = await listOpportunityPageIds({
        ...query(true),
        limit: 3,
        offset: 3,
      });

      expect(first).toEqual(['recommend-96', 'score-96-tie', 'unknown-90']);
      expect(second).toEqual(['stale', 'expired', 'wrong-status']);
    });

    it('does not change ordinary numeric score and newest ordering', async () => {
      const { listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const numeric = await listOpportunityPageIds({
        ...query(),
        limit: 10,
        offset: 0,
      });
      const newest = await listOpportunityPageIds({
        ...query(true),
        filters: { ...DEFAULT_OPPORTUNITY_FILTERS, sort: 'newest' },
        limit: 10,
        offset: 0,
      });

      expect(numeric).toEqual([
        'reject-100',
        'recommend-96',
        'score-96-tie',
        'unknown-90',
        'stale',
        'expired',
        'wrong-status',
        'wrong-search',
        'wrong-skill',
        'matches-list-context',
      ]);
      expect(newest).toEqual([
        'stale',
        'expired',
        'wrong-status',
        'wrong-search',
        'wrong-skill',
        'matches-list-context',
        'reject-20',
        'unknown-90',
        'unscored',
        'recommend-96',
      ]);
    });

    it('uses refreshed preference-scoped projection scores before pagination', async () => {
      const { listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const firstQuery = {
        ...query(true),
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          sort: 'score' as const,
          status: 'recommended',
        },
      };
      await expect(
        listOpportunityPageIds({ ...firstQuery, limit: 2, offset: 0 }),
      ).resolves.toEqual(['recommend-96', 'score-96-tie']);

      const assessmentTable =
        config.type === 'postgres'
          ? 'pg_temp.opportunity_assessments'
          : 'opportunity_assessments';
      await database.query(`UPDATE ${assessmentTable}
        SET preferences_fingerprint = 'preferences-weight-change',
            fit_score = CASE
              WHEN opportunity_id = 'recommend-96' THEN 95
              WHEN opportunity_id = 'score-96-tie' THEN 98
              ELSE fit_score
            END
        WHERE opportunity_id IN ('recommend-96', 'score-96-tie')`);

      await expect(
        listOpportunityPageIds({
          ...firstQuery,
          assessmentPreferencesFingerprint: 'preferences-weight-change',
          limit: 2,
          offset: 0,
        }),
      ).resolves.toEqual(['score-96-tie', 'recommend-96']);
    });

    it('keeps incomplete assessment fit out of score filtering and ordering', async () => {
      const opportunityTable =
        config.type === 'postgres' ? 'pg_temp.opportunities' : 'opportunities';
      const assessmentTable =
        config.type === 'postgres'
          ? 'pg_temp.opportunity_assessments'
          : 'opportunity_assessments';
      await database.query(`INSERT INTO ${opportunityTable}
        (id, status, human_review_status, source_content_fingerprint,
         source_content_version, scoring_material_fingerprint, updated_at)
        VALUES
          ('readiness-assessable', 'archived', '', 'readiness-a', 1, 'material', '2026-07-01T00:00:00Z'),
          ('readiness-incomplete', 'archived', '', 'readiness-b', 1, 'material', '2026-07-02T00:00:00Z')`);
      await database.query(`INSERT INTO ${assessmentTable}
        (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
         source_content_fingerprint, source_content_version,
         candidate_material_fingerprint, preferences_fingerprint,
         contract_version, status, eligibility_bucket, eligibility_priority,
         fit_score, match_readiness, excluded, updated_at)
        VALUES
          ('readiness-a', 'readiness-assessable', 'tenant-a', 'user-a', 'profile-a',
           'readiness-a', 1, 'candidate-material', 'preferences',
           '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 55,
           'assessable', FALSE, '2026-07-01T00:00:00Z'),
          ('readiness-b', 'readiness-incomplete', 'tenant-a', 'user-a', 'profile-a',
           'readiness-b', 1, 'candidate-material', 'preferences',
           '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 99,
           'needs_evidence', FALSE, '2026-07-02T00:00:00Z')`);
      const { listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const base = {
        ...query(),
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          sort: 'score' as const,
          sortDirection: 'desc' as const,
          status: 'archived',
        },
      };
      await expect(
        listOpportunityPageIds({ ...base, limit: 10, offset: 0 }),
      ).resolves.toEqual(['readiness-assessable', 'readiness-incomplete']);
      await expect(
        listOpportunityPageIds({
          ...base,
          filters: { ...base.filters, minScore: 1 },
          limit: 10,
          offset: 0,
        }),
      ).resolves.toEqual(['readiness-assessable']);
    });

    it.each(
      listContextRankings,
    )('orders the recommended list $sort/$sortDirection exactly', async ({
      expected,
      sort,
      sortDirection,
    }) => {
      const { countOpportunityRecords, listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const listQuery = {
        ...query(false),
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          sort,
          sortDirection,
          status: 'recommended',
        },
      };
      await expect(countOpportunityRecords(listQuery)).resolves.toBe(
        expected.length,
      );
      await expect(
        listOpportunityPageIds({
          ...listQuery,
          limit: 100,
          offset: 0,
        }),
      ).resolves.toEqual(expected);
    });

    it.runIf(config.type === 'postgres')(
      'matches the list query only when every inherited filter still matches',
      async () => {
        const { countOpportunityRecords, listOpportunityPageIds } =
          await import('./admin-opportunity-query');
        const matchingQuery = {
          candidateSkills: [],
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            excludeExpired: true,
            excludeStale: true,
            skills: ['Rust'],
            sort: 'score' as const,
            status: 'found',
          },
          reviewFilter: 'unsorted',
          search: 'platform',
          triageRejectDepriority: false,
          assessmentCandidateMaterialFingerprint: 'candidate-material',
          assessmentPreferencesFingerprint: 'preferences',
          workspaceSubject: TEST_WORKSPACE_SUBJECT,
        };

        await expect(countOpportunityRecords(matchingQuery)).resolves.toBe(1);
        await expect(
          listOpportunityPageIds({ ...matchingQuery, limit: 10, offset: 0 }),
        ).resolves.toEqual(['matches-list-context']);
      },
    );

    it('returns only bounded, fingerprint-current SQLite score context', async () => {
      const { listCurrentOpportunityScores } = await import(
        './admin-opportunity-query'
      );
      const scores = await listCurrentOpportunityScores(
        ['recommend-96', 'unscored'],
        TEST_WORKSPACE_SUBJECT,
      );

      expect(scores).toEqual(
        new Map([
          ['recommend-96', { recommendation: 'recommend', score: 96 }],
          ['unscored', { recommendation: '', score: null }],
        ]),
      );
    });

    it('filters current eligibility buckets with OR semantics and pages unknown fallbacks', async () => {
      const opportunityTable =
        config.type === 'postgres' ? 'pg_temp.opportunities' : 'opportunities';
      await database.query(`INSERT INTO ${opportunityTable}
        (id, status, human_review_status, source_content_fingerprint, source_content_version,
         eligibility_flags, eligibility_source_fingerprint, eligibility_source_version, updated_at)
        VALUES
          ('eligibility-canada-a', 'archived', '', 'canada-a', 1, 1, 'canada-a', 1, '2026-04-01T00:00:00Z'),
          ('eligibility-canada-b', 'archived', '', 'canada-b', 1, 1, 'canada-b', 1, '2026-04-02T00:00:00Z'),
          ('eligibility-sponsor-us', 'archived', '', 'sponsor-us', 1, 14, 'sponsor-us', 1, '2026-04-03T00:00:00Z'),
          ('eligibility-unknown', 'archived', '', 'unknown', 1, 32, 'unknown', 1, '2026-04-04T00:00:00Z'),
          ('eligibility-stale', 'archived', '', 'current', 1, 1, 'old', 1, '2026-04-05T00:00:00Z'),
          ('eligibility-invalid', 'archived', '', 'invalid', 1, 128, 'invalid', 1, '2026-04-06T00:00:00Z'),
          ('eligibility-incoherent', 'archived', '', 'incoherent', 1, 17, 'incoherent', 1, '2026-04-06T12:00:00Z'),
          ('eligibility-conflict', 'archived', '', 'conflict', 1, 16, 'conflict', 1, '2026-04-07T00:00:00Z')`);
      await database.query(`UPDATE ${opportunityTable}
        SET work_mode = CASE WHEN id = 'eligibility-sponsor-us' THEN 'onsite' ELSE 'remote' END
        WHERE id LIKE 'eligibility-%'`);
      const assessmentTable =
        config.type === 'postgres'
          ? 'pg_temp.opportunity_assessments'
          : 'opportunity_assessments';
      await database.query(`INSERT INTO ${assessmentTable}
        (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
         source_content_fingerprint, source_content_version,
         candidate_material_fingerprint, preferences_fingerprint, contract_version,
         status, eligibility_bucket, eligibility_priority, fit_score, match_readiness, excluded, updated_at)
        VALUES
          ('eligibility-assessment-canada-a', 'eligibility-canada-a', 'tenant-a', 'user-a', 'profile-a', 'canada-a', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 60, 'assessable', FALSE, '2026-04-01T00:00:00Z'),
          ('eligibility-assessment-canada-b', 'eligibility-canada-b', 'tenant-a', 'user-a', 'profile-a', 'canada-b', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'eligible', 1, 60, 'assessable', FALSE, '2026-04-02T00:00:00Z'),
          ('eligibility-assessment-sponsor', 'eligibility-sponsor-us', 'tenant-a', 'user-a', 'profile-a', 'sponsor-us', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'sponsorship_possible', 2, 60, 'assessable', FALSE, '2026-04-03T00:00:00Z'),
          ('eligibility-assessment-conflict', 'eligibility-conflict', 'tenant-a', 'user-a', 'profile-a', 'conflict', 1, 'candidate-material', 'preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}', 'current', 'conflicting', 9, 60, 'assessable', FALSE, '2026-04-07T00:00:00Z')`);
      const { countOpportunityRecords, listOpportunityPageIds } = await import(
        './admin-opportunity-query'
      );
      const base: WorkspaceOpportunityQuery = {
        assessmentCandidateMaterialFingerprint: 'candidate-material',
        assessmentPreferencesFingerprint: 'preferences',
        candidateSkills: [],
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          eligibilityBuckets: ['eligible', 'sponsorship_possible'],
          sort: 'eligibility' as const,
          sortDirection: 'asc' as const,
          status: 'archived',
        },
        reviewFilter: 'all',
        workspaceSubject: TEST_WORKSPACE_SUBJECT,
      };
      await expect(countOpportunityRecords(base)).resolves.toBe(3);
      await expect(
        listOpportunityPageIds({ ...base, limit: 2, offset: 0 }),
      ).resolves.toEqual(['eligibility-canada-b', 'eligibility-canada-a']);
      await expect(
        listOpportunityPageIds({ ...base, limit: 2, offset: 2 }),
      ).resolves.toEqual(['eligibility-sponsor-us']);
      await expect(
        listOpportunityPageIds({
          ...base,
          filters: { ...base.filters, workModes: ['remote'] },
          limit: 10,
          offset: 0,
        }),
      ).resolves.toEqual(['eligibility-canada-b', 'eligibility-canada-a']);
      await expect(
        listOpportunityPageIds({
          ...base,
          filters: { ...base.filters, eligibilityBuckets: ['unknown'] },
          limit: 10,
          offset: 0,
        }),
      ).resolves.toEqual([
        'eligibility-incoherent',
        'eligibility-invalid',
        'eligibility-stale',
        'eligibility-unknown',
      ]);
      await expect(
        listOpportunityPageIds({
          ...base,
          filters: { ...base.filters, eligibilityBuckets: ['conflicting'] },
          limit: 10,
          offset: 0,
        }),
      ).resolves.toEqual(['eligibility-conflict']);
    });

    it('selects only material-current auto scores while preserving current human scores', async () => {
      const opportunityTable =
        config.type === 'postgres' ? 'pg_temp.opportunities' : 'opportunities';
      const scoreTable =
        config.type === 'postgres'
          ? 'pg_temp.evaluation_scores'
          : 'evaluation_scores';
      await database.query(`INSERT INTO ${opportunityTable}
        (id,status,human_review_status,source_content_fingerprint,scoring_material_fingerprint,title)
        VALUES
          ('selection-auto','archived','','selection-auto-source','selection-material','Material selection auto'),
          ('selection-human','archived','','selection-human-source','selection-material','Material selection human'),
          ('selection-stale-human','archived','','selection-stale-source','selection-material','Material selection stale human')`);
      await database.query(`INSERT INTO ${scoreTable}
        (id,opportunity_id,tenant_id,owner_user_id,candidate_profile_id,source_content_fingerprint,scoring_material_fingerprint,created_by_profile_id,updated_at,score,recommendation)
        VALUES
          ('selection-auto-matching','selection-auto','tenant-a','user-a','profile-a','selection-auto-source','selection-material','','2026-03-01T00:00:00Z',60,'recommend'),
          ('selection-auto-wrong-newer','selection-auto','tenant-a','user-a','profile-a','selection-auto-source','wrong-material','','2026-03-03T00:00:00Z',100,'reject'),
          ('selection-auto-legacy-newest','selection-auto','tenant-a','user-a','profile-a','selection-auto-source','','','2026-03-04T00:00:00Z',99,'reject'),
          ('selection-human-auto-newer','selection-human','tenant-a','user-a','profile-a','selection-human-source','selection-material','','2026-03-04T00:00:00Z',99,'reject'),
          ('selection-human-current','selection-human','tenant-a','user-a','profile-a','selection-human-source','wrong-material','profile-1','2026-03-01T00:00:00Z',20,'recommend'),
          ('selection-stale-human','selection-stale-human','tenant-a','user-a','profile-a','stale-source','wrong-material','profile-1','2026-03-05T00:00:00Z',100,'reject')`);
      const { listCurrentOpportunityScores, listOpportunityPageIds } =
        await import('./admin-opportunity-query');
      await expect(
        listCurrentOpportunityScores(
          ['selection-auto', 'selection-human', 'selection-stale-human'],
          TEST_WORKSPACE_SUBJECT,
        ),
      ).resolves.toEqual(
        new Map([
          ['selection-auto', { recommendation: 'recommend', score: 60 }],
          ['selection-human', { recommendation: 'recommend', score: 20 }],
          ['selection-stale-human', { recommendation: '', score: null }],
        ]),
      );
      await expect(
        listOpportunityPageIds({
          ...query(),
          filters: {
            ...DEFAULT_OPPORTUNITY_FILTERS,
            sort: 'score',
            status: 'archived',
          },
          limit: 10,
          offset: 0,
        }),
      ).resolves.toEqual([
        'selection-auto',
        'selection-human',
        'selection-stale-human',
      ]);
      await database.query(`UPDATE ${opportunityTable}
        SET scoring_material_fingerprint = '' WHERE id = 'selection-auto'`);
      await expect(
        listCurrentOpportunityScores(
          ['selection-auto'],
          TEST_WORKSPACE_SUBJECT,
        ),
      ).resolves.toEqual(
        new Map([['selection-auto', { recommendation: '', score: null }]]),
      );
    });

    it('uses only this workspace’s current assessment, review, application, and score rows', async () => {
      const prefix = config.type === 'postgres' ? 'pg_temp.' : '';
      const subject = {
        profileId: 'profile-a',
        tenantId: 'tenant-a',
        userId: 'user-a',
      };
      await database.query(`INSERT INTO ${prefix}opportunities
        (id, status, source_content_fingerprint, source_content_version, updated_at)
        VALUES
          ('subject-a', 'found', 'source-a', 1, '2026-06-01T00:00:00Z'),
          ('subject-b', 'found', 'source-b', 1, '2026-06-02T00:00:00Z')`);
      await database.query(`INSERT INTO ${prefix}opportunity_assessments
        (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
         source_content_fingerprint, source_content_version,
         candidate_material_fingerprint, preferences_fingerprint,
         contract_version, status, eligibility_bucket, eligibility_priority,
         fit_score, match_readiness, excluded, updated_at)
        VALUES
          ('assessment-a-current', 'subject-a', 'tenant-a', 'user-a', 'profile-a',
           'source-a', 1, 'candidate-a', 'preferences-a', '${OPPORTUNITY_ASSESSMENT_VERSION}',
           'current', 'eligible', 1, 60, 'assessable', FALSE, '2026-06-01T00:00:00Z'),
          ('assessment-a-stale-source', 'subject-a', 'tenant-a', 'user-a', 'profile-a',
           'old-source', 1, 'candidate-a', 'preferences-a', '${OPPORTUNITY_ASSESSMENT_VERSION}',
           'current', 'eligible', 1, 99, 'assessable', FALSE, '2026-06-05T00:00:00Z'),
          ('assessment-a-stale-profile', 'subject-a', 'tenant-a', 'user-a', 'other-profile',
           'source-a', 1, 'candidate-a', 'preferences-a', '${OPPORTUNITY_ASSESSMENT_VERSION}',
           'current', 'eligible', 1, 98, 'assessable', FALSE, '2026-06-05T00:00:00Z'),
          ('assessment-a-stale-preferences', 'subject-a', 'tenant-a', 'user-a', 'profile-a',
           'source-a', 1, 'candidate-a', 'old-preferences', '${OPPORTUNITY_ASSESSMENT_VERSION}',
           'current', 'eligible', 1, 97, 'assessable', FALSE, '2026-06-05T00:00:00Z'),
          ('assessment-a-stale-contract', 'subject-a', 'tenant-a', 'user-a', 'profile-a',
           'source-a', 1, 'candidate-a', 'preferences-a', 'old-contract',
           'current', 'eligible', 1, 96, 'assessable', FALSE, '2026-06-05T00:00:00Z'),
          ('assessment-b-foreign-high', 'subject-b', 'tenant-b', 'user-b', 'profile-b',
           'source-b', 1, 'candidate-b', 'preferences-b', '${OPPORTUNITY_ASSESSMENT_VERSION}',
           'current', 'eligible', 1, 100, 'assessable', FALSE, '2026-06-05T00:00:00Z')`);
      await database.query(`INSERT INTO ${prefix}decisions
        (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
         decision, human_rating, created_at)
        VALUES
          ('decision-a-old', 'subject-a', 'tenant-a', 'user-a', 'profile-a',
           'defer', 2, '2026-06-01T00:00:00Z'),
          ('decision-a-current', 'subject-a', 'tenant-a', 'user-a', 'profile-a',
           'accept_to_apply', 6, '2026-06-02T00:00:00Z'),
          ('decision-b-foreign', 'subject-b', 'tenant-b', 'user-b', 'profile-b',
           'accept_to_apply', 10, '2026-06-05T00:00:00Z')`);
      await database.query(`INSERT INTO ${prefix}applications
        (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
         status, updated_at)
        VALUES
          ('application-a', 'subject-a', 'tenant-a', 'user-a', 'profile-a',
           'draft', '2026-06-02T00:00:00Z'),
          ('application-b-foreign', 'subject-b', 'tenant-b', 'user-b', 'profile-b',
           'submitted', '2026-06-05T00:00:00Z')`);
      await database.query(`INSERT INTO ${prefix}evaluation_scores
        (id, opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
         source_content_fingerprint, created_by_profile_id, updated_at, score, recommendation)
        VALUES
          ('score-a', 'subject-a', 'tenant-a', 'user-a', 'profile-a',
           'source-a', 'profile-a', '2026-06-02T00:00:00Z', 60, 'recommend'),
          ('score-b-foreign-high', 'subject-b', 'tenant-b', 'user-b', 'profile-b',
           'source-b', 'profile-b', '2026-06-05T00:00:00Z', 100, 'recommend')`);

      const {
        countOpportunityRecords,
        listCurrentOpportunityScores,
        listLatestOpportunityRelatedContext,
        listOpportunityFilterOptions,
        listOpportunityPageIds,
      } = await import('./admin-opportunity-query');
      const subjectQuery = {
        assessmentCandidateMaterialFingerprint: 'candidate-a',
        assessmentPreferencesFingerprint: 'preferences-a',
        candidateSkills: [],
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          minRating: 5,
          minScore: 50,
          sort: 'score' as const,
          status: 'found',
        },
        reviewFilter: 'apply',
        workspaceSubject: subject,
      };

      await expect(countOpportunityRecords(subjectQuery)).resolves.toBe(1);
      await expect(
        listOpportunityPageIds({ ...subjectQuery, limit: 10, offset: 0 }),
      ).resolves.toEqual(['subject-a']);
      await expect(
        listOpportunityFilterOptions('apply', subject),
      ).resolves.toMatchObject({ statuses: ['found'] });
      await expect(
        listCurrentOpportunityScores(['subject-a', 'subject-b'], subject),
      ).resolves.toEqual(
        new Map([
          ['subject-a', { recommendation: 'recommend', score: 60 }],
          ['subject-b', { recommendation: '', score: null }],
        ]),
      );
      await expect(
        listLatestOpportunityRelatedContext(
          ['subject-a', 'subject-b'],
          subject,
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            applicationId: 'application-a',
            humanReviewStatus: 'apply',
            opportunityId: 'subject-a',
            scoreId: 'score-a',
          }),
          expect.objectContaining({
            applicationId: null,
            opportunityId: 'subject-b',
            scoreId: null,
          }),
        ]),
      );
    });
  });
}

runSuite('triage ranking SQL on SQLite', { type: 'sqlite', url: ':memory:' });

describe.skipIf(!postgresUrl)('triage ranking SQL on PostgreSQL', () => {
  runSuite('isolated temporary tables', {
    type: 'postgres',
    url: postgresUrl ?? '',
  });
});
