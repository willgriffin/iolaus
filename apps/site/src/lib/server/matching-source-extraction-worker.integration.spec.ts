import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import type { MatchingDialect } from './matching-projection-read.js';
import { ensureMatchingProjectionSchema } from './matching-projection-schema.js';
import { runMatchingTick } from './matching-projection-worker.js';
import { parseMatchingSourceExtraction } from './matching-source-extraction-contract.js';
import { runMatchingSourceExtraction } from './matching-source-extraction-worker.js';
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
    `INSERT INTO candidate_profiles VALUES (?, TRUE, 'tenant', 'owner', ?, ?, '{}')`,
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
