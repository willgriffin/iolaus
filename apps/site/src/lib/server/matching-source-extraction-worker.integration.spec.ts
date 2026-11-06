import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import type { MatchingDialect } from './matching-projection-read.js';
import { ensureMatchingProjectionSchema } from './matching-projection-schema.js';
import { runMatchingTick } from './matching-projection-worker.js';
import {
  MATCHING_SOURCE_EXTRACTION_VERSION,
  parseMatchingSourceExtraction,
} from './matching-source-extraction-contract.js';
import { runMatchingSourceExtraction } from './matching-source-extraction-worker.js';
import {
  matchingSourceCaptureDigest,
  matchingSourceDecisionRequestId,
} from './matching-source-identity.js';
import {
  type MatchingSourceDecisionProfile,
  matchingSourceSemanticMaterial,
  matchingSourceSemanticProposalDigest,
  parseMatchingSourceSemanticProposal,
  verifyMatchingSourceSemanticProposal,
} from './matching-source-semantics.js';
import { OpportunityIntelligenceGovernanceError } from './opportunity-intelligence-governance.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const postingId = '11111111-0000-4000-8000-000000000001';
const profileId = '22222222-0000-4000-8000-000000000001';
const title = 'Backend Engineer';
const location = 'Remote (Canada)';
const clause =
  'The role calls for a working knowledge of Node.js or TypeScript.';
const postgresUrl = process.env.IOLAUS_MATCHING_TEST_DATABASE_URL;
const dialects: MatchingDialect[] = [
  'sqlite',
  ...(postgresUrl ? ['postgres' as const] : []),
];

async function writeCapture(
  db: DatabaseInterface,
  description: string,
  version: number,
) {
  const raw = {
    title,
    descriptionRaw: description,
    locationNotes: location,
    workMode: 'remote',
  };
  await db.query(
    `UPDATE opportunities SET source_content_json=?, source_content_fingerprint=?,
    source_content_version=? WHERE id=?`,
    [
      JSON.stringify(raw),
      fingerprintOpportunitySourceContent(raw),
      version,
      postingId,
    ],
  );
}

async function seed(db: DatabaseInterface) {
  await db.query("INSERT INTO sources VALUES ('source',TRUE,TRUE)");
  await db.query("INSERT INTO users VALUES ('owner','active')");
  await db.query("INSERT INTO tenants VALUES ('tenant','active')");
  await db.query(
    "INSERT INTO memberships VALUES ('tenant','owner','active','member')",
  );
  await db.query(
    `INSERT INTO candidate_profiles (id, active, tenant_id, owner_user_id, preferences_json, facts_json, target_work_country_json) VALUES (?, TRUE, 'tenant', 'owner', ?, ?, '{}')`,
    [
      profileId,
      JSON.stringify({
        targetRoles: [title],
        locations: ['Canada'],
        workModes: ['remote'],
      }),
      '{"version":1,"facts":{}}',
    ],
  );
  await db.query(
    "INSERT INTO resume_skills VALUES ('proof','tenant','owner',?,'Node.js')",
    [profileId],
  );
  await db.query(
    "INSERT INTO opportunities(id,title,source_id,status) VALUES(?,?,'source','found')",
    [postingId, title],
  );
  await writeCapture(db, clause, 1);
}

for (const dialect of dialects) {
  describe(`governed shared interpretation publication on ${dialect}`, () => {
    it('replaces a falsely verified capability inside a current bound exercise', async () => {
      const { database: db, close } = await createMatchingProjectionFixture(
        dialect,
        postgresUrl,
      );
      try {
        await seed(db);
        const description =
          'Take-home assignment:\nPlease complete the exercise.\nNode.js\nBuild a dashboard.\nInterview Process:\nDiscuss your approach.';
        const source = { title, description, location };
        await writeCapture(db, description, 1);
        await ensureMatchingProjectionSchema(db, dialect);
        await runMatchingTick(db, dialect);
        const profile: MatchingSourceDecisionProfile = {
          provider: 'typesafe',
          transport: 'direct',
          model: 'jev-1.14.0',
          revision: 'exercise',
          maxInputBytes: 8192,
          preparationVersion: 'matching-source-jev/v23',
        };
        const latest = {
          ...profile,
          preparationVersion: 'matching-source-jev/v24',
        };
        const material = matchingSourceSemanticMaterial(source);
        const run = (corrected: boolean) =>
          runMatchingSourceExtraction(db, dialect, 1000, {
            opportunityId: postingId,
            decisionProfile: corrected ? latest : profile,
            provider: async () => {
              const proposal = parseMatchingSourceSemanticProposal(
                {
                  role: null,
                  geography: null,
                  ledger: material.units.map(({ id }) =>
                    !corrected && id === 'd3'
                      ? {
                          id,
                          kind: 'requirement',
                          groups: [
                            {
                              alternatives: [
                                {
                                  conceptId: 'nodejs',
                                  years: null,
                                  context: null,
                                  unsupportedQualifier: false,
                                },
                              ],
                            },
                          ],
                        }
                      : {
                          id,
                          kind:
                            corrected && id === 'd4' ? 'unresolved' : 'context',
                          groups: [],
                        },
                  ),
                },
                source,
              );
              const proof = verifyMatchingSourceSemanticProposal(
                {
                  sourceDigest: material.sourceDigest,
                  proposalDigest:
                    matchingSourceSemanticProposalDigest(proposal),
                  roleCorrect: false,
                  geographyCorrect: false,
                  units: material.units.map(({ id }) => {
                    const pass = !corrected || id !== 'd4';
                    return {
                      id,
                      classificationCorrect: pass,
                      allConditionsRepresented: pass,
                      logicAndQualifiersPreserved: pass,
                    };
                  }),
                },
                source,
                proposal,
              );
              return {
                requestId: '',
                extraction: {
                  coverage: 'partial',
                  role: null,
                  geography: null,
                  noRequirements: null,
                  required: [],
                  preferred: [],
                  unresolved: [],
                  semantic: {
                    ...proof,
                    decision: {
                      ...(corrected ? latest : profile),
                      observedModels: [profile.model],
                      ...(corrected && {
                        hiringExercises: [
                          {
                            version: 1 as const,
                            anchorId: 'd1',
                            closingId: 'd5',
                            unitIds: ['d1', 'd2', 'd3', 'd4'],
                            assessedUnitIds: ['d1', 'd2', 'd3'],
                            participation: 'required' as const,
                            participationUnitId: 'd2',
                          },
                        ],
                      }),
                    },
                  },
                },
              };
            },
          });
        await expect(run(false)).resolves.toBe('published');
        await runMatchingTick(db, dialect);
        await expect(run(true)).resolves.toBe('published');
        await runMatchingTick(db, dialect);
        await expect(run(true)).resolves.toBe('idle');
        const {
          rows: [row],
        } = await db.query(
          'SELECT facts_json FROM matching_source_facts WHERE opportunity_id=?',
          [postingId],
        );
        const facts = JSON.parse(String(row.facts_json));
        expect(facts.applicationSteps).toMatchObject([
          {
            kind: 'assessment-required',
            citation: { text: 'Please complete the exercise.' },
          },
        ]);
        expect(facts.required).toEqual([]);
        expect(facts.uncertainties).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'posting-requirement-unknown',
              citations: expect.arrayContaining([
                expect.objectContaining({ text: 'Build a dashboard.' }),
              ]),
            }),
          ]),
        );
      } finally {
        await close();
      }
    });

    it.each([
      'publish',
      'provider-failure',
    ])('does not retain an unsafe old typed proof after %s', async (outcome) => {
      const { database: db, close } = await createMatchingProjectionFixture(
        dialect,
        postgresUrl,
      );
      try {
        await seed(db);
        const description =
          "What you'll do:\nExperience collaborating with product teams";
        await writeCapture(db, description, 1);
        await ensureMatchingProjectionSchema(db, dialect);
        await runMatchingTick(db, dialect);
        const source = { title, description, location };
        const profile: MatchingSourceDecisionProfile = {
          provider: 'typesafe',
          transport: 'direct',
          model: 'jev-1.14.0',
          revision: 'test-r1',
          maxInputBytes: 8192,
          preparationVersion: 'matching-source-jev/v21',
        };
        const next = {
          ...profile,
          preparationVersion: 'matching-source-jev/v23',
        };
        const material = matchingSourceSemanticMaterial(source);
        const extraction = (strategy: typeof profile, unsafe: boolean) => {
          const proposal = parseMatchingSourceSemanticProposal(
            {
              role: null,
              geography: null,
              ledger: material.units.map(({ id }) => ({
                id,
                kind: id === 'd2' && !unsafe ? 'unresolved' : 'context',
                groups: [],
              })),
            },
            source,
          );
          const semantic = verifyMatchingSourceSemanticProposal(
            {
              sourceDigest: material.sourceDigest,
              proposalDigest: matchingSourceSemanticProposalDigest(proposal),
              roleCorrect: false,
              geographyCorrect: false,
              units: material.units.map(({ id }) => {
                const confirmed = unsafe || id !== 'd2';
                return {
                  id,
                  classificationCorrect: confirmed,
                  allConditionsRepresented: confirmed,
                  logicAndQualifiersPreserved: confirmed,
                };
              }),
            },
            source,
            proposal,
          );
          return {
            coverage: 'partial' as const,
            role: null,
            geography: null,
            noRequirements: null,
            required: [],
            preferred: [],
            unresolved: [],
            semantic: {
              ...semantic,
              decision: { ...strategy, observedModels: [strategy.model] },
            },
          };
        };
        const {
          rows: [capture],
        } = await db.query(
          'SELECT source_content_json, source_content_fingerprint FROM opportunities WHERE id=?',
          [postingId],
        );
        await db.query(
          `INSERT INTO matching_source_interpretations
             (opportunity_id, source_fingerprint, source_content_version, contract_version, input_digest,
             state, lease, next_run_at, attempts, payload_json, request_id)
             VALUES (?, ?, 1, ?, ?, 'complete', '', 0, 1, ?, ?)`,
          [
            postingId,
            capture.source_content_fingerprint,
            MATCHING_SOURCE_EXTRACTION_VERSION,
            matchingSourceCaptureDigest(capture.source_content_json),
            JSON.stringify(extraction(profile, true)),
            matchingSourceDecisionRequestId(profile),
          ],
        );
        const sourceRevision = async () =>
          String(
            (
              await db.query(
                'SELECT revision FROM matching_source_versions WHERE opportunity_id=?',
                [postingId],
              )
            ).rows[0]?.revision,
          );
        const before = await sourceRevision();
        await expect(
          runMatchingSourceExtraction(db, dialect, 1000, {
            opportunityId: postingId,
            decisionProfile: next,
            provider: async () => {
              if (outcome === 'provider-failure')
                throw new Error('fixture failure');
              return { requestId: '', extraction: extraction(next, false) };
            },
          }),
        ).resolves.toBe(outcome === 'publish' ? 'published' : 'retry');
        expect(
          (
            await db.query(
              'SELECT request_id, state, payload_json FROM matching_source_interpretations WHERE opportunity_id=?',
              [postingId],
            )
          ).rows[0],
        ).toMatchObject({
          request_id: matchingSourceDecisionRequestId(next),
          state: outcome === 'publish' ? 'complete' : 'retry',
          payload_json:
            outcome === 'publish'
              ? expect.stringContaining('matching-source-jev/v23')
              : '',
        });
        expect(await sourceRevision()).not.toBe(before);
      } finally {
        await close();
      }
    });

    it('pins decision strategy, refuses a concurrent replacement, and reuses only the same completed strategy', async () => {
      const { database: db, close } = await createMatchingProjectionFixture(
        dialect,
        postgresUrl,
      );
      try {
        await seed(db);
        await ensureMatchingProjectionSchema(db, dialect);
        await runMatchingTick(db, dialect);
        const profile: MatchingSourceDecisionProfile = {
          provider: 'typesafe',
          transport: 'direct',
          model: 'jev-1.14.0',
          revision: 'test-r1',
          maxInputBytes: 8192,
          preparationVersion: 'test/v1',
        };
        const next = { ...profile, revision: 'test-r2' };
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let calls = 0;
        const provider: NonNullable<
          Parameters<typeof runMatchingSourceExtraction>[3]
        >['provider'] = async (source) => {
          calls++;
          entered.resolve();
          await release.promise;
          const material = matchingSourceSemanticMaterial(source);
          const proposal = parseMatchingSourceSemanticProposal(
            {
              role: null,
              geography: null,
              ledger: material.units.map(({ id }) =>
                id === 'd1'
                  ? {
                      id,
                      kind: 'requirement',
                      groups: [
                        {
                          alternatives: [
                            {
                              conceptId: 'nodejs',
                              years: null,
                              context: null,
                              unsupportedQualifier: false,
                            },
                          ],
                        },
                      ],
                    }
                  : { id, kind: 'context', groups: [] },
              ),
            },
            source,
          );
          const proof = verifyMatchingSourceSemanticProposal(
            {
              sourceDigest: material.sourceDigest,
              proposalDigest: matchingSourceSemanticProposalDigest(proposal),
              roleCorrect: false,
              geographyCorrect: false,
              units: material.units.map(({ id }) => ({
                id,
                classificationCorrect: true,
                allConditionsRepresented: true,
                logicAndQualifiersPreserved: true,
              })),
            },
            source,
            proposal,
          );
          return {
            requestId: 'ignored',
            extraction: {
              coverage: 'partial',
              role: null,
              geography: null,
              noRequirements: null,
              required: [],
              preferred: [],
              unresolved: [],
              semantic: {
                ...proof,
                decision: { ...profile, observedModels: [profile.model] },
              },
            },
          };
        };
        const {
          rows: [capture],
        } = await db.query(
          'SELECT source_content_json, source_content_fingerprint FROM opportunities WHERE id=?',
          [postingId],
        );
        const expectedCapture = {
          fingerprint: String(capture.source_content_fingerprint),
          title,
          sha256: createHash('sha256')
            .update(String(capture.source_content_json))
            .digest('hex'),
        };
        for (const wrong of [
          { title: 'Different captured title' },
          { fingerprint: '0'.repeat(64) },
          { sha256: '0'.repeat(64) },
        ]) {
          await expect(
            runMatchingSourceExtraction(db, dialect, 1000, {
              opportunityId: postingId,
              decisionProfile: profile,
              expectedCapture: { ...expectedCapture, ...wrong },
              provider,
            }),
          ).resolves.toBe('idle');
        }
        expect(calls).toBe(0);
        const first = runMatchingSourceExtraction(db, dialect, 1000, {
          opportunityId: postingId,
          decisionProfile: profile,
          expectedCapture,
          provider,
        });
        await entered.promise;
        try {
          await expect(
            runMatchingSourceExtraction(db, dialect, 1000, {
              opportunityId: postingId,
              decisionProfile: next,
              provider,
            }),
          ).resolves.toBe('idle');
        } finally {
          release.resolve();
        }
        await expect(first).resolves.toBe('published');
        await runMatchingTick(db, dialect);
        await expect(
          runMatchingSourceExtraction(db, dialect, 1000, {
            opportunityId: postingId,
            decisionProfile: profile,
            provider,
          }),
        ).resolves.toBe('idle');
        const stored = await db.query(
          'SELECT request_id, state FROM matching_source_interpretations WHERE opportunity_id=?',
          [postingId],
        );
        expect(stored.rows[0]).toMatchObject({
          state: 'complete',
          request_id: matchingSourceDecisionRequestId(profile),
        });
        await expect(
          runMatchingSourceExtraction(db, dialect, 1000, {
            opportunityId: postingId,
            decisionProfile: next,
            provider,
          }),
        ).resolves.toBe('retry');
        expect(calls).toBe(2);
        expect(
          (
            await db.query(
              'SELECT request_id, state FROM matching_source_interpretations WHERE opportunity_id=?',
              [postingId],
            )
          ).rows[0],
        ).toMatchObject({
          state: 'complete',
          request_id: matchingSourceDecisionRequestId(profile),
        });
      } finally {
        await close();
      }
    });

    it('does not hold a transaction during extraction; stale captures cannot publish, fresh exact evidence updates the same cheap feed once', async () => {
      const { database: db, close } = await createMatchingProjectionFixture(
        dialect,
        postgresUrl,
      );
      try {
        await seed(db);
        await ensureMatchingProjectionSchema(db, dialect);
        const drain = async () => {
          for (let i = 0; i < 4; i += 1) await runMatchingTick(db, dialect);
        };
        const status = async () =>
          (
            await db.query(
              'SELECT status FROM matching_results WHERE opportunity_id=? AND profile_id=?',
              [postingId, profileId],
            )
          ).rows[0]?.status;
        await drain();
        expect(await status()).toBe('insufficient-evidence');

        const failed: string[] = [];
        await expect(
          runMatchingSourceExtraction(db, dialect, 1000, {
            windowId: 'fixture-window',
            provider: async (_input, options) => {
              expect(options).toEqual({
                budgetMicros: 1000,
                windowId: 'fixture-window',
              });
              throw new OpportunityIntelligenceGovernanceError(
                'budget_exhausted',
                'Fixture: hourly ceiling reached',
              );
            },
            onFailure: (kind) => failed.push(kind),
          }),
        ).resolves.toBe('retry');
        expect(failed).toEqual(['Governance:budget_exhausted']);
        const {
          rows: [deferred],
        } = await db.query(
          'SELECT state, attempts, next_run_at FROM matching_source_interpretations WHERE opportunity_id=?',
          [postingId],
        );
        expect(deferred?.state).toBe('retry');
        expect(Number(deferred?.attempts)).toBe(0);
        expect(Number(deferred?.next_run_at)).toBeGreaterThan(Date.now());
        await expect(
          runMatchingSourceExtraction(db, dialect, 1000, {
            opportunityId: postingId,
            provider: async () => {
              throw new Error('Deferred work was invoked');
            },
          }),
        ).resolves.toBe('idle');
        // Advance the fixture clock for the persisted retry without sleeping.
        await db.query(
          'UPDATE matching_source_interpretations SET next_run_at=0 WHERE opportunity_id=?',
          [postingId],
        );

        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let calls = 0;
        const provider: NonNullable<
          Parameters<typeof runMatchingSourceExtraction>[3]
        >['provider'] = async (input) => {
          calls += 1;
          expect(Object.keys(input).sort()).toEqual([
            'description',
            'location',
            'opportunityId',
            'sourceContentFingerprint',
            'sourceContentVersion',
            'title',
          ]);
          if (calls === 1) {
            entered.resolve();
            await release.promise;
          }
          const quote = (
            field: 'title' | 'description' | 'location',
            value: string,
          ) => ({ field, quote: value, start: null });
          return {
            requestId: 'synthetic-governed-request',
            extraction: parseMatchingSourceExtraction(
              {
                coverage: 'complete',
                role: quote('title', title),
                geography: quote('location', location),
                noRequirements: null,
                required: [
                  {
                    clause: quote('description', clause),
                    alternatives: ['Node.js', 'TypeScript'].map((name) => ({
                      capability: quote('description', name),
                      years: null,
                      context: null,
                    })),
                  },
                ],
                preferred: [],
                unresolved: [],
              },
              input,
            ),
          };
        };

        const delayed = runMatchingSourceExtraction(db, dialect, 1000, {
          opportunityId: postingId,
          provider,
        });
        await entered.promise;
        // While the simulated provider is in flight, a real native mutation
        // commits. No DB transaction is held across the provider wait.
        await writeCapture(db, `About the role\n${clause}`, 2);
        release.resolve();
        await expect(delayed).resolves.toBe('obsolete');
        expect(
          (
            await db.query(
              "SELECT COUNT(*) AS n FROM matching_source_interpretations WHERE state='complete'",
            )
          ).rows[0]?.n,
        ).toSatisfy((value: unknown) => Number(value) === 0);

        await drain();
        await expect(
          runMatchingSourceExtraction(db, dialect, 1000, {
            opportunityId: postingId,
            provider,
          }),
        ).resolves.toBe('published');
        await drain();
        expect(await status()).toBe('qualified');
        await expect(
          runMatchingSourceExtraction(db, dialect, 1000, {
            opportunityId: postingId,
            provider,
          }),
        ).resolves.toBe('idle');
        expect(calls).toBe(2);
      } finally {
        await close();
      }
    }, 15_000);
  });
}
