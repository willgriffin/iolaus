import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';
import {
  countOpportunityRecords,
  listCurrentDiscoveryMatches,
  listOpportunityFilterOptions,
  listOpportunityMatchingIds,
  listOpportunityPageIds,
  listOpportunityRevisionsByIds,
} from './admin-opportunity-query.js';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import { readMatchingDiscoveryCoverage } from './matching-discovery-coverage.js';
import { lockMatchingWriteRevision } from './matching-projection-read.js';
import { ensureMatchingProjectionSchema } from './matching-projection-schema.js';
import { MATCHING_POLICY_VERSION } from './normalized-matching.js';

const scoped = vi.hoisted(() => ({
  db: undefined as DatabaseInterface | undefined,
  dialect: 'sqlite' as 'sqlite' | 'postgres',
}));
vi.mock('@happyvertical/smrt-users', async (original) => ({
  ...(await original<typeof import('@happyvertical/smrt-users')>()),
  getRequestScopedDatabase: () => scoped.db,
}));
vi.mock('./db.js', async (original) => ({
  ...(await original<typeof import('./db.js')>()),
  getDbConfig: () => ({ type: scoped.dialect }),
}));

const postgresUrl = process.env.IOLAUS_MATCHING_TEST_DATABASE_URL?.trim();
for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.runIf(dialect === 'sqlite' || postgresUrl)(
    `opportunity discovery on ${dialect}`,
    () => {
      it('ranks and pages only current qualified rows, uses the same facet and bulk set, and keeps explicit history', async () => {
        const { database: db, close } = await createMatchingProjectionFixture(
          dialect,
          postgresUrl,
        );
        scoped.dialect = dialect;
        scoped.db = db;
        try {
          for (const col of [
            'posted_at',
            'first_seen_at',
            'employment_type',
            'seniority',
            'freshness',
            'required_skills',
            'preferred_skills',
          ])
            await db.query(`ALTER TABLE opportunities ADD COLUMN ${col} TEXT`);
          await db.query(`CREATE TABLE decisions (
          id TEXT PRIMARY KEY, opportunity_id TEXT, tenant_id TEXT, owner_user_id TEXT,
          candidate_profile_id TEXT, decision TEXT, created_at TEXT, human_rating INTEGER,
          reason TEXT, decider_profile_id TEXT, decider_user_id TEXT
        )`);
          await db.query("INSERT INTO sources VALUES ('board', TRUE, TRUE)");
          await db.query(
            "INSERT INTO users VALUES ('owner', 'active'), ('sibling', 'active')",
          );
          await db.query("INSERT INTO tenants VALUES ('tenant', 'active')");
          await db.query(
            "INSERT INTO memberships VALUES ('tenant', 'owner', 'active', 'member'), ('tenant', 'sibling', 'active', 'member')",
          );
          const owner = {
            profileId: randomUUID(),
            tenantId: 'tenant',
            userId: 'owner',
          };
          const sibling = {
            ...owner,
            profileId: randomUUID(),
            userId: 'sibling',
          };
          for (const subject of [owner, sibling])
            await db.query(
              'INSERT INTO candidate_profiles (id, tenant_id, owner_user_id, active) VALUES (?, ?, ?, TRUE)',
              [subject.profileId, subject.tenantId, subject.userId],
            );
          const best = randomUUID();
          const newest = randomUUID();
          const stale = randomUUID();
          const unprocessed = randomUUID();
          const unresolved = randomUUID();
          const conflict = randomUUID();
          const revisionTime = '2026-02-01T00:00:00.000Z';
          for (const [id, skill, day] of [
            [best, 'TypeScript', '01'],
            [newest, 'JavaScript', '02'],
            [stale, 'Stale skill', '04'],
            [unprocessed, 'Unprocessed skill', '05'],
            [unresolved, 'Unknown required skill', '07'],
            [conflict, 'Conflict skill', '06'],
          ]) {
            await db.query(
              `INSERT INTO opportunities
            (id, title, source_id, status, posted_at, updated_at, required_skills)
            VALUES (?, ?, 'board', 'found', ?, ?, ?)`,
              [
                id,
                `${skill} Engineer`,
                `2026-02-${day}`,
                revisionTime,
                'Legacy label',
              ],
            );
          }
          await db.query(
            "INSERT INTO skill_terms (skill_slug, label, status) VALUES ('typescript', 'TypeScript', 'confirmed'), ('javascript', 'JavaScript', 'seed')",
          );
          await ensureMatchingProjectionSchema(db, dialect);
          // Supply projection outputs to exercise real SQL selection. The worker
          // integration suite separately covers publishing from raw inputs.
          for (const [id, score, status] of [
            [best, 95, 'qualified'],
            [newest, 85, 'qualified'],
            [stale, 100, 'qualified'],
            [conflict, 100, 'conflict'],
          ] as const) {
            await db.query(
              `INSERT INTO matching_results (
            profile_id, tenant_id, user_id, opportunity_id, profile_revision, source_revision,
            source_listing_revision, vocabulary_revision, policy_version, status, score, reasons_json)
            SELECT p.profile_id, 'tenant', 'owner', s.opportunity_id, p.revision, s.revision,
              l.revision, v.revision, ?, ?, ?, '[{"message":"Supported criteria"}]'
            FROM matching_profile_versions p, matching_source_versions s,
              matching_source_listing_versions l, matching_vocabulary_version v
            WHERE p.profile_id = ? AND s.opportunity_id = ? AND l.source_id = 'board'`,
              [MATCHING_POLICY_VERSION, status, score, owner.profileId, id],
            );
          }
          const unresolvedReasons = JSON.stringify([
            {
              code: 'posting-source-interpretation-missing',
              outcome: 'unknown',
            },
            { code: 'posting-requirement-unsupported', outcome: 'unknown' },
            { code: 'posting-requirement-unknown', outcome: 'unknown' },
            { code: 'posting-requirement-unknown', outcome: 'unknown' },
            { code: 'required-capability', outcome: 'unknown' },
          ]);
          await db.query(
            `
            INSERT INTO matching_results (
              profile_id, tenant_id, user_id, opportunity_id, profile_revision, source_revision,
              source_listing_revision, vocabulary_revision, policy_version, status, score, reasons_json)
            SELECT p.profile_id, 'tenant', 'owner', s.opportunity_id, p.revision, s.revision,
              l.revision, v.revision, ?, 'insufficient-evidence', 0, ?
            FROM matching_profile_versions p, matching_source_versions s,
              matching_source_listing_versions l, matching_vocabulary_version v
            WHERE p.profile_id = ? AND s.opportunity_id = ? AND l.source_id = 'board'
          `,
            [
              MATCHING_POLICY_VERSION,
              unresolvedReasons,
              owner.profileId,
              unresolved,
            ],
          );
          for (const [index, id, slug] of [
            [1, best, 'typescript'],
            [2, newest, 'javascript'],
            [3, stale, 'rust'],
          ] as const) {
            const group = { alternatives: [{ slug }] };
            const facts = JSON.stringify({
              required: index === 1 ? [group] : [],
              preferred: index !== 1 ? [group] : [],
              uncertainties: [],
            });
            await db.query(
              `INSERT INTO matching_source_facts (
              opportunity_id, source_revision, source_listing_revision, vocabulary_revision,
              policy_version, facts_json, work_revision
            ) SELECT opportunity_id, source_revision, source_listing_revision, vocabulary_revision,
              policy_version, ?, ? FROM matching_results WHERE opportunity_id = ?`,
              [facts, index, id],
            );
          }
          await db.query(
            "UPDATE opportunities SET description_raw = 'Material edit' WHERE id = ?",
            [stale],
          );
          await db.query(
            "INSERT INTO decisions VALUES ('saved', ?, 'tenant', 'owner', ?, 'defer', '2026-02-06', 7, 'saved review', ?, 'owner')",
            [stale, owner.profileId, owner.profileId],
          );
          const query = {
            candidateSkills: [],
            currentQualified: true,
            filters: DEFAULT_OPPORTUNITY_FILTERS,
            reviewFilter: 'unsorted',
            workspaceSubject: owner,
          };
          expect(await countOpportunityRecords(query)).toBe(2);
          expect(
            await listOpportunityPageIds({ ...query, limit: 1, offset: 0 }),
          ).toEqual([best]);
          expect(
            await listOpportunityPageIds({ ...query, limit: 1, offset: 1 }),
          ).toEqual([newest]);
          expect(
            await listOpportunityPageIds({
              ...query,
              filters: { ...query.filters, sort: 'newest' },
              limit: 2,
              offset: 0,
            }),
          ).toEqual([newest, best]);
          expect(
            await listOpportunityPageIds({
              ...query,
              filters: { ...query.filters, minScore: 90 },
              limit: 3,
              offset: 0,
            }),
          ).toEqual([best]);
          expect(
            (await listOpportunityFilterOptions('unsorted', owner, true))
              .skills,
          ).toEqual(['JavaScript', 'TypeScript']);
          const skillQuery = {
            ...query,
            filters: { ...query.filters, skills: ['TypeScript'] },
          };
          expect(await countOpportunityRecords(skillQuery)).toBe(1);
          expect(
            await listOpportunityPageIds({
              ...skillQuery,
              limit: 3,
              offset: 0,
            }),
          ).toEqual([best]);
          expect(
            await countOpportunityRecords({
              ...query,
              filters: { ...query.filters, skills: ['Legacy label'] },
            }),
          ).toBe(0);

          expect(
            (await listOpportunityMatchingIds(query, { limit: 5 }))
              .map((row) => row.id)
              .sort(),
          ).toEqual([best, newest].sort());
          expect(
            (
              await listOpportunityRevisionsByIds(
                [best, stale, unprocessed],
                owner,
                'unsorted',
              )
            ).map((row) => row.id),
          ).toEqual([best]);
          expect(
            (
              await listOpportunityRevisionsByIds([best, stale], owner, 'maybe')
            ).map((row) => row.id),
          ).toEqual([stale]);
          expect(
            (await listCurrentDiscoveryMatches([best, stale], owner)).get(best),
          ).toMatchObject({ score: 95, reasons: ['Supported criteria'] });
          expect(
            await countOpportunityRecords({
              ...query,
              workspaceSubject: sibling,
            }),
          ).toBe(0);
          expect(
            await countOpportunityRecords({
              ...query,
              workspaceSubject: { ...owner, tenantId: 'foreign' },
            }),
          ).toBe(0);
          // The same current projection reaches reads and selections, while
          // the write fence distinguishes manual dispositions from Apply.
          const privateQuote =
            'Operated the fictional Citrus API in production';
          const locator = {
            field: 'evidence',
            id: 'fictional-project-1',
            start: 4,
            end: 4 + privateQuote.length,
            evidenceDigest: 'versioned-quote',
          };
          await db.query(
            `INSERT INTO matching_profile_facts (
              profile_id, tenant_id, user_id, profile_revision, vocabulary_revision,
              policy_version, facts_json, status
            ) SELECT p.profile_id, ?, ?, p.revision, v.revision, ?, ?, 'pending'
              FROM matching_profile_versions p, matching_vocabulary_version v
              WHERE p.profile_id = ?`,
            [
              owner.tenantId,
              owner.userId,
              MATCHING_POLICY_VERSION,
              JSON.stringify({
                evidence: [{ citation: { ...locator, text: privateQuote } }],
              }),
              owner.profileId,
            ],
          );
          await db.query(
            'UPDATE matching_results SET screened_with_gaps = TRUE, score = 55, reasons_json = ? WHERE opportunity_id = ?',
            [
              JSON.stringify([
                {
                  code: 'required-capability',
                  outcome: 'unknown',
                  message: 'Evidence gap',
                  citations: [{ ...locator, evidenceDigest: 'wrong-digest' }],
                },
                {
                  code: 'candidate-interpretation-partial',
                  outcome: 'unknown',
                  message: 'Partial interpretation',
                },
                {
                  code: 'required-capability',
                  outcome: 'supported',
                  message: 'Evidence confirmed',
                  citations: [locator, { ...locator, field: 'question' }],
                },
                {
                  code: 'work-location',
                  outcome: 'supported',
                  message: 'Compatible location',
                },
              ]),
              unresolved,
            ],
          );
          expect(await countOpportunityRecords(query)).toBe(3);
          expect(
            await listOpportunityPageIds({ ...query, limit: 3, offset: 0 }),
          ).toEqual([best, newest, unresolved]);
          expect(
            await listOpportunityPageIds({
              ...query,
              filters: { ...query.filters, sort: 'newest' },
              limit: 3,
              offset: 0,
            }),
          ).toEqual([unresolved, newest, best]);
          expect(
            await countOpportunityRecords({
              ...query,
              filters: { ...query.filters, fit: 'have' },
            }),
          ).toBe(2);
          expect(
            await countOpportunityRecords({
              ...query,
              filters: {
                ...query.filters,
                fit: 'gaps',
                eligibilityBuckets: ['eligible'],
              },
            }),
          ).toBe(1);
          const listMatch = (
            await listCurrentDiscoveryMatches([unresolved], owner)
          ).get(unresolved);
          expect(listMatch).toMatchObject({
            status: 'screened-with-gaps',
            score: 55,
            reasons: ['Evidence gap'],
            evidence: {
              supported: [{ message: 'Evidence confirmed' }],
              gaps: [{ message: 'Evidence gap' }],
              interpretation:
                'Matching could interpret only part of your evidence.',
            },
          });
          expect(JSON.stringify(listMatch)).not.toContain(privateQuote);
          expect(JSON.stringify(listMatch)).not.toContain(locator.id);
          const detailOptions = { includePrivateEvidence: true } as const;
          const detailMatch = (
            await listCurrentDiscoveryMatches(
              [unresolved],
              owner,
              detailOptions,
            )
          ).get(unresolved);
          expect(detailMatch?.evidence).toEqual({
            supported: [
              { message: 'Evidence confirmed', excerpts: [privateQuote] },
            ],
            gaps: [{ message: 'Evidence gap' }],
            interpretation:
              'Matching could interpret only part of your evidence.',
          });
          expect(
            await listCurrentDiscoveryMatches(
              [unresolved],
              sibling,
              detailOptions,
            ),
          ).toEqual(new Map());
          expect(
            await listCurrentDiscoveryMatches(
              [unresolved],
              { ...owner, tenantId: 'foreign' },
              detailOptions,
            ),
          ).toEqual(new Map());
          await db.query(
            'UPDATE matching_profile_facts SET profile_revision = profile_revision + 1 WHERE profile_id = ?',
            [owner.profileId],
          );
          const staleDetail = (
            await listCurrentDiscoveryMatches(
              [unresolved],
              owner,
              detailOptions,
            )
          ).get(unresolved);
          expect(staleDetail?.evidence).toEqual(listMatch?.evidence);
          const [screened] = await listOpportunityRevisionsByIds(
            [unresolved],
            owner,
            'unsorted',
          );
          expect(screened?.matchingStatus).toBe('screened-with-gaps');
          const expected = {
            opportunityId: unresolved,
            updatedAt: screened?.updatedAt ?? '',
            matchingRevision: screened?.matchingRevision ?? '',
          };
          await db.transaction?.(async (tx) => {
            expect(
              await lockMatchingWriteRevision(tx, dialect, owner, expected),
            ).toBe(false);
            expect(
              await lockMatchingWriteRevision(tx, dialect, owner, expected, {
                allowScreened: true,
              }),
            ).toBe(true);
          });
          await db.query(
            'UPDATE matching_results SET screened_with_gaps = FALSE, score = 0, reasons_json = ? WHERE opportunity_id = ?',
            [
              JSON.stringify([
                {
                  code: 'posting-source-interpretation-missing',
                  outcome: 'unknown',
                },
                { code: 'posting-requirement-unsupported', outcome: 'unknown' },
                { code: 'posting-requirement-unknown', outcome: 'unknown' },
                { code: 'required-capability', outcome: 'unknown' },
              ]),
              unresolved,
            ],
          );
          const emptyCoverage = {
            conflicts: 0,
            missingSource: 0,
            unsupported: 0,
            unresolvedSource: 0,
            unresolvedEvidence: 0,
            pendingInterpretation: 0,
            failedInterpretation: 0,
            partialInterpretation: 0,
          };
          expect(
            await readMatchingDiscoveryCoverage(db, dialect, owner),
          ).toEqual({
            ...emptyCoverage,
            conflicts: 1,
            missingSource: 1,
            unsupported: 1,
            unresolvedSource: 1,
            unresolvedEvidence: 1,
          });
          expect(
            await readMatchingDiscoveryCoverage(db, dialect, sibling),
          ).toEqual(emptyCoverage);
          expect(
            await readMatchingDiscoveryCoverage(db, dialect, {
              ...owner,
              tenantId: 'foreign',
            }),
          ).toEqual(emptyCoverage);
          for (const [state, key] of [
            ['pending', 'pendingInterpretation'],
            ['failed', 'failedInterpretation'],
            ['partial', 'partialInterpretation'],
          ] as const) {
            await db.query(
              'UPDATE matching_results SET reasons_json = ? WHERE opportunity_id = ?',
              [
                JSON.stringify([
                  { code: 'required-capability', outcome: 'unknown' },
                  {
                    code: `candidate-interpretation-${state}`,
                    outcome: 'unknown',
                  },
                ]),
                unresolved,
              ],
            );
            expect(
              await readMatchingDiscoveryCoverage(db, dialect, owner),
            ).toEqual({
              ...emptyCoverage,
              conflicts: 1,
              [key]: 1,
            });
          }
          await db.query(
            "UPDATE opportunities SET description_raw = 'Source changed' WHERE id = ?",
            [unresolved],
          );
          expect(
            await readMatchingDiscoveryCoverage(db, dialect, owner),
          ).toEqual({ ...emptyCoverage, conflicts: 1 });
          await db.query(
            "UPDATE memberships SET status = 'suspended' WHERE user_id = 'owner'",
          );
          expect(
            await readMatchingDiscoveryCoverage(db, dialect, owner),
          ).toEqual(emptyCoverage);
          expect(await countOpportunityRecords(query)).toBe(0);
        } finally {
          scoped.db = undefined;
          await close();
        }
      });
    },
  );
}
