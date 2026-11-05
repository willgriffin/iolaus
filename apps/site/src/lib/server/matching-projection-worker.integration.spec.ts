import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import {
  currentQualifiedMatchJoin,
  lockMatchingWriteRevision,
  MATCHING_REVISION_SQL,
  type MatchingDialect,
  readMatchingDiscoveryProgress,
} from './matching-projection-read.js';
import { ensureMatchingProjectionSchema } from './matching-projection-schema.js';
import {
  publishMatchingBatch,
  runMatchingTick,
} from './matching-projection-worker.js';

const profiles = [
  '11111111-0000-4000-8000-000000000001',
  '11111111-0000-4000-8000-000000000002',
  '11111111-0000-4000-8000-000000000003',
];
const jobs = [
  '22222222-0000-4000-8000-000000000001',
  '22222222-0000-4000-8000-000000000002',
  '22222222-0000-4000-8000-000000000003',
  '22222222-0000-4000-8000-000000000004',
];
const positive =
  'Required skills: Node.js and either PostgreSQL or SQLite\nPreferred skills: Kubernetes';
const preferences = JSON.stringify({
  targetRoles: ['Backend Engineer'],
  locations: ['Canada'],
  workModes: ['remote'],
});
const owner = {
  profileId: profiles[0]!,
  tenantId: 'tenant-a',
  userId: 'owner',
};
const sibling = { ...owner, profileId: profiles[1]! };
const other = {
  profileId: profiles[2]!,
  tenantId: 'tenant-b',
  userId: 'other',
};
const postgresUrl = process.env.IOLAUS_MATCHING_TEST_DATABASE_URL;
const dialects: MatchingDialect[] = [
  'sqlite',
  ...(postgresUrl ? ['postgres' as const] : []),
];

async function seed(db: DatabaseInterface) {
  await db.query(
    "INSERT INTO users VALUES ('owner','active'),('other','active')",
  );
  await db.query(
    "INSERT INTO tenants VALUES ('tenant-a','active'),('tenant-b','active')",
  );
  await db.query(
    "INSERT INTO memberships VALUES ('tenant-a','owner','active','member'),('tenant-b','other','active','member')",
  );
  await db.query("INSERT INTO sources VALUES ('source',TRUE,TRUE)");
  for (const subject of [owner, sibling, other]) {
    await db.query(
      'INSERT INTO candidate_profiles VALUES (?, TRUE, ?, ?, ?, ?, ?)',
      [
        subject.profileId,
        subject.tenantId,
        subject.userId,
        preferences,
        '{"facts":{},"version":1}',
        '{}',
      ],
    );
  }
  await db.query('INSERT INTO resume_skills VALUES (?,?,?,?,?),(?,?,?,?,?)', [
    'skill-a',
    owner.tenantId,
    owner.userId,
    owner.profileId,
    'Node.js',
    'skill-b',
    owner.tenantId,
    owner.userId,
    owner.profileId,
    'Postgres',
  ]);
  for (const [index, [title, location, description]] of [
    ['Senior Backend Engineer', 'Remote (Canada)', positive],
    ['Backend Engineer', 'Remote (Canada)', 'Required skills: TypeScript'],
    ['Backend Engineer', 'Remote (United States)', positive],
    ['Product Manager', 'Remote (Canada)', positive],
  ].entries()) {
    await db.query(
      `INSERT INTO opportunities(id,title,description_raw,locations,work_mode,source_id,status)
      VALUES(?,?,?,?, 'remote','source','found')`,
      [jobs[index], title, description, location],
    );
  }
}

async function discover(
  db: DatabaseInterface,
  dialect: MatchingDialect,
  subject: typeof owner,
) {
  const values: unknown[] = [];
  const gate = currentQualifiedMatchJoin(
    subject,
    (value) => {
      values.push(value);
      return '?';
    },
    'o',
    dialect,
  );
  return (
    await db.query(
      `SELECT CAST(o.id AS TEXT) AS id FROM opportunities o ${gate} ORDER BY o.id`,
      values,
    )
  ).rows.map(({ id }) => id);
}

for (const dialect of dialects) {
  describe(`matching pipeline on ${dialect}`, () => {
    it('uses original discipline preferences through the worker and discovery', async () => {
      const { database: db, close } = await createMatchingProjectionFixture(
        dialect,
        postgresUrl,
      );
      try {
        await seed(db);
        await db.query('UPDATE opportunities SET title=? WHERE id=?', [
          'Sales Manager',
          jobs[3],
        ]);
        await ensureMatchingProjectionSchema(db, dialect);
        const saved =
          '{ "targetRoles": ["Software engineering", "Other idea"], "locations": ["Canada"], "workModes": ["remote"] }';
        await db.query(
          'UPDATE candidate_profiles SET preferences_json=? WHERE id=?',
          [saved, owner.profileId],
        );
        const converge = async () => {
          for (let i = 0; i < 6; i += 1) await runMatchingTick(db, dialect);
        };
        await converge();
        expect(await discover(db, dialect, owner)).toEqual([jobs[0]]);
        expect(await discover(db, dialect, sibling)).toEqual([]);
        expect(await readMatchingDiscoveryProgress(db, dialect, owner)).toEqual(
          {
            status: 'ready',
            hasUnsupportedRoleChoices: true,
          },
        );
        expect(
          await readMatchingDiscoveryProgress(db, dialect, {
            ...owner,
            tenantId: other.tenantId,
          }),
        ).toEqual({ status: 'pending' });
        expect(
          (
            await db.query(
              'SELECT preferences_json FROM candidate_profiles WHERE id=?',
              [owner.profileId],
            )
          ).rows[0]?.preferences_json,
        ).toBe(saved);

        await db.query(
          'UPDATE candidate_profiles SET preferences_json=? WHERE id=?',
          [
            saved.replace('Software engineering', 'Ambiguous role'),
            owner.profileId,
          ],
        );
        // The current read gate hides old matches even before reprocessing.
        expect(await discover(db, dialect, owner)).toEqual([]);
        expect(await readMatchingDiscoveryProgress(db, dialect, owner)).toEqual(
          { status: 'pending' },
        );
        await converge();
        expect(await discover(db, dialect, owner)).toEqual([]);
        expect(await readMatchingDiscoveryProgress(db, dialect, owner)).toEqual(
          { status: 'unsupported-target-roles' },
        );
      } finally {
        await close();
      }
    });

    it('pins a confirmed match through a durable write and rejects a generation changed before the write fence', async () => {
      const { database: db, close } = await createMatchingProjectionFixture(
        dialect,
        postgresUrl,
      );
      try {
        await seed(db);
        const updatedAt = '2026-11-04T17:00:00.000Z';
        await db.query('UPDATE opportunities SET updated_at=? WHERE id=?', [
          updatedAt,
          jobs[0],
        ]);
        await ensureMatchingProjectionSchema(db, dialect);
        await db.query('CREATE TABLE write_receipts (id TEXT PRIMARY KEY)');
        const converge = async () => {
          for (let i = 0; i < 5; i += 1) await runMatchingTick(db, dialect);
        };
        const snapshot = async () => {
          const params: unknown[] = [];
          const gate = currentQualifiedMatchJoin(
            owner,
            (value) => {
              params.push(value);
              return '?';
            },
            'o',
            dialect,
          );
          const {
            rows: [row],
          } = await db.query(
            `SELECT ${MATCHING_REVISION_SQL} AS revision
            FROM opportunities o ${gate} WHERE o.id=?`,
            [...params, jobs[0]],
          );
          expect(row?.revision).toBeTruthy();
          return {
            opportunityId: jobs[0]!,
            updatedAt,
            matchingRevision: String(row?.revision),
          };
        };
        const write = async (
          receipt: string,
          selected: Awaited<ReturnType<typeof snapshot>>,
        ) =>
          db.transaction!(async (tx) => {
            if (
              !(await lockMatchingWriteRevision(tx, dialect, owner, selected))
            )
              return false;
            await tx.query('INSERT INTO write_receipts VALUES (?)', [receipt]);
            return true;
          });
        await converge();
        const beforeEdit = await snapshot();
        // Preview/apply has resolved its selection, but the durable writer
        // has not yet acquired its revision locks.
        await db.query(
          "UPDATE sources SET public_listing=FALSE WHERE id='source'",
        );
        await expect(write('obsolete', beforeEdit)).resolves.toBe(false);
        await db.query(
          "UPDATE sources SET public_listing=TRUE WHERE id='source'",
        );
        await converge();
        await expect(write('replaced-generation', beforeEdit)).resolves.toBe(
          false,
        );
        const current = await snapshot();
        await expect(write('current', current)).resolves.toBe(true);
        expect(
          (await db.query('SELECT id FROM write_receipts')).rows.map(
            ({ id }) => id,
          ),
        ).toEqual(['current']);

        if (dialect === 'postgres') {
          const competing = await getDatabase({
            type: 'postgres',
            url: db.url,
            cache: false,
          });
          try {
            const acquired = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const protectedWrite = db.transaction!(async (tx) => {
              await expect(
                lockMatchingWriteRevision(tx, dialect, owner, current),
              ).resolves.toBe(true);
              acquired.resolve();
              await release.promise;
              await tx.query("INSERT INTO write_receipts VALUES ('locked')");
            });
            try {
              await acquired.promise;
              // A truly separate executor cannot commit its trigger and
              // revoke eligibility while the selected write is in flight.
              await expect(
                competing.transaction!(async (tx) => {
                  await tx.query("SET LOCAL lock_timeout='100ms'");
                  await tx.query(
                    "UPDATE sources SET public_listing=FALSE WHERE id='source'",
                  );
                }),
              ).rejects.toThrow(/lock timeout/i);
            } finally {
              release.resolve();
              await protectedWrite;
            }
            await competing.query(
              "UPDATE sources SET public_listing=FALSE WHERE id='source'",
            );
            await expect(write('after-revocation', current)).resolves.toBe(
              false,
            );
          } finally {
            await competing.close?.();
          }
        }
      } finally {
        await close();
      }
    }, 15_000);

    it('publishes raw evidence only for the live owned profile and rejects a delayed publisher', async () => {
      const { database: db, close } = await createMatchingProjectionFixture(
        dialect,
        postgresUrl,
      );
      try {
        await seed(db);
        await ensureMatchingProjectionSchema(db, dialect);
        const converge = async () => {
          for (let i = 0; i < profiles.length + 1; i += 1)
            await runMatchingTick(db, dialect);
        };
        await expect(discover(db, dialect, owner)).resolves.toEqual([]);
        await converge();
        await expect(discover(db, dialect, owner)).resolves.toEqual([jobs[0]]);
        await expect(discover(db, dialect, sibling)).resolves.toEqual([]);
        await expect(discover(db, dialect, other)).resolves.toEqual([]);
        await expect(
          discover(db, dialect, { ...owner, tenantId: other.tenantId }),
        ).resolves.toEqual([]);
        await expect(
          discover(db, dialect, { ...owner, userId: other.userId }),
        ).resolves.toEqual([]);

        const {
          rows: [current],
        } = await db.query(
          `SELECT * FROM matching_results
          WHERE profile_id=? AND opportunity_id=?`,
          [owner.profileId, jobs[0]],
        );
        const snapshot = {
          ...owner,
          profileRevision: String(current?.profile_revision),
          vocabularyRevision: String(current?.vocabulary_revision),
        };
        const pending = {
          opportunityId: jobs[0]!,
          sourceRevision: String(current?.source_revision),
          listingRevision: String(current?.source_listing_revision),
          status: 'qualified' as const,
          score: Number(current?.score),
          reasonsJson: String(current?.reasons_json),
        };
        // Hold a computed snapshot outside the publication transaction as a
        // delayed worker while a different operation commits a raw edit.
        const { promise, resolve } = Promise.withResolvers<void>();
        const delayed = promise.then(() =>
          db.transaction!((tx) =>
            publishMatchingBatch(tx, dialect, snapshot, [pending]),
          ),
        );
        await db.query(
          'UPDATE opportunities SET description_raw=? WHERE id=?',
          ['Required skills: TypeScript', jobs[0]],
        );
        resolve();
        await expect(delayed).resolves.toBe(0);
        await expect(discover(db, dialect, owner)).resolves.toEqual([]);
        await converge();
        await expect(discover(db, dialect, owner)).resolves.toEqual([]);

        await db.query(
          'UPDATE opportunities SET description_raw=? WHERE id=?',
          [positive, jobs[0]],
        );
        await converge();
        await expect(discover(db, dialect, owner)).resolves.toEqual([jobs[0]]);

        await expect(
          db.transaction!(async (tx) => {
            await tx.query(
              "UPDATE sources SET public_listing=FALSE WHERE id='source'",
            );
            await expect(discover(tx, dialect, owner)).resolves.toEqual([]);
            throw new Error('roll back listing change');
          }),
        ).rejects.toThrow('roll back listing change');
        await expect(discover(db, dialect, owner)).resolves.toEqual([jobs[0]]);

        await db.query(
          "UPDATE sources SET public_listing=FALSE WHERE id='source'",
        );
        await expect(discover(db, dialect, owner)).resolves.toEqual([]);
        await db.query(
          "UPDATE sources SET public_listing=TRUE WHERE id='source'",
        );
        await expect(discover(db, dialect, owner)).resolves.toEqual([]);
        await converge();
        await expect(discover(db, dialect, owner)).resolves.toEqual([jobs[0]]);

        await db.query("DELETE FROM resume_skills WHERE id='skill-a'");
        await expect(discover(db, dialect, owner)).resolves.toEqual([]);
        await converge();
        await expect(discover(db, dialect, owner)).resolves.toEqual([]);
        await db.query('INSERT INTO resume_skills VALUES (?,?,?,?,?)', [
          'skill-a',
          owner.tenantId,
          owner.userId,
          owner.profileId,
          'Node.js',
        ]);
        await converge();
        await expect(discover(db, dialect, owner)).resolves.toEqual([jobs[0]]);
        await db.query(
          "UPDATE memberships SET status='suspended' WHERE user_id='owner'",
        );
        await expect(discover(db, dialect, owner)).resolves.toEqual([]);
        await expect(
          db.transaction!((tx) =>
            publishMatchingBatch(tx, dialect, snapshot, [pending]),
          ),
        ).resolves.toBe(0);
      } finally {
        await close();
      }
    }, 15_000);
  });
}
