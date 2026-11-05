import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { AiUsageRefusedError } from './ai-usage-guard.js';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import { MatchingCandidateInterpretationError } from './matching-candidate-interpretation.js';
import { runMatchingCandidateInterpretation } from './matching-candidate-worker.js';
import { loadMatchingCandidateInput } from './matching-projection-input.js';
import type { MatchingDialect } from './matching-projection-read.js';
import { ensureMatchingProjectionSchema } from './matching-projection-schema.js';
import { runMatchingTick } from './matching-projection-worker.js';

const owner = '11111111-0000-4000-8000-000000000001';
const other = '11111111-0000-4000-8000-000000000002';
const sourceText = 'Instrumented observability for production services.';
const postgresUrl = process.env.IOLAUS_MATCHING_TEST_DATABASE_URL;
const dialects: MatchingDialect[] = [
  'sqlite',
  ...(postgresUrl ? ['postgres' as const] : []),
];

async function seed(db: DatabaseInterface, dialect: MatchingDialect) {
  await db.query(
    "INSERT INTO users VALUES ('owner','active'),('other','active')",
  );
  await db.query(
    "INSERT INTO tenants VALUES ('tenant-a','active'),('tenant-b','active')",
  );
  await db.query(
    "INSERT INTO memberships VALUES ('tenant-a','owner','active','member'),('tenant-b','other','active','member')",
  );
  for (const [profileId, tenant, user] of [
    [owner, 'tenant-a', 'owner'],
    [other, 'tenant-b', 'other'],
  ]) {
    await db.query(
      `INSERT INTO candidate_profiles VALUES (?, TRUE, ?, ?, ?, '{"facts":{},"version":1}', '{}')`,
      [
        profileId,
        tenant,
        user,
        '{"targetRoles":["Backend Engineer"],"locations":["Canada"]}',
      ],
    );
  }
  await db.query(
    "INSERT INTO resume_achievements (id, tenant_id, owner_user_id, candidate_profile_id, body) VALUES ('achievement', 'tenant-a', 'owner', ?, ?), ('foreign', 'tenant-b', 'other', ?, 'Foreign evidence')",
    [owner, sourceText, owner],
  );
  await ensureMatchingProjectionSchema(db, dialect);
  await runMatchingTick(db, dialect);
}

type WorkerOptions = NonNullable<
  Parameters<typeof runMatchingCandidateInterpretation>[2]
>;
type Provider = NonNullable<WorkerOptions['interpret']>;
type Verifier = NonNullable<WorkerOptions['verify']>;
const allowed: NonNullable<WorkerOptions['asOwner']> = async (scope, work) => {
  expect(scope).toMatchObject({
    tenantId: 'tenant-a',
    userId: 'owner',
    profileId: owner,
  });
  return await work();
};
const oneChunk: NonNullable<WorkerOptions['chunk']> = (input) => [input];

function proof(input: Parameters<Provider>[0]['input']) {
  expect(input.evidence).toHaveLength(1);
  const [source] = input.evidence;
  expect(source.text).toBe(sourceText);
  return {
    assertions: [
      {
        sourceId: source.id,
        conceptId: 'observability',
        quote: source.text,
        support: 'action' as const,
        context: 'production' as const,
        polarity: 'positive' as const,
        period: null,
        duration: null,
        activityQuote: null,
      },
    ],
    reviewedSourceIds: [source.id],
    unresolvedSourceIds: [],
  };
}

async function cache(db: DatabaseInterface) {
  const result = await db.query(
    'SELECT state, payload_json, draft_json, request_id FROM matching_candidate_interpretations WHERE profile_id = ?',
    [owner],
  );
  return result.rows[0];
}

describe.each(
  dialects,
)('private candidate matching lifecycle (%s)', (dialect) => {
  it.each([
    'complete',
    'failed',
  ] as const)('persists a split across preflight retries and ends %s', async (outcome) => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      for (const id of ['second', 'third', 'unread'])
        await db.query(
          "INSERT INTO resume_achievements (id, tenant_id, owner_user_id, candidate_profile_id, body) VALUES (?, 'tenant-a', 'owner', ?, ?)",
          [id, owner, sourceText],
        );
      for (let tick = 0; tick < 5; tick += 1)
        await runMatchingTick(db, dialect);
      const chunk: NonNullable<WorkerOptions['chunk']> = ({ evidence }) => [
        { evidence: evidence.slice(0, 1) },
        { evidence: evidence.slice(1, 3) },
        { evidence: evidence.slice(3) },
      ];
      let now = Date.now();
      let rightAttempts = 0;
      const attempted: string[] = [];
      const interpret: Provider = async ({ input, requestId, revalidate }) => {
        if (requestId.endsWith('-split-right-draft') && rightAttempts++ === 0)
          throw new AiUsageRefusedError('user_budget_exhausted', 'budget');
        await revalidate();
        attempted.push(requestId);
        if (input.evidence.length === 2)
          throw new MatchingCandidateInterpretationError(
            'candidate_interpretation_provider_incomplete',
            'response_length',
          );
        if (outcome === 'failed' && requestId.endsWith('-split-right-draft'))
          throw new MatchingCandidateInterpretationError(
            'candidate_interpretation_provider_incomplete',
            'content_filter',
          );
        return { interpretation: proof(input), requestId };
      };
      const verify: Verifier = async ({ draft, requestId, revalidate }) => {
        await revalidate();
        attempted.push(requestId);
        return { interpretation: draft, requestId };
      };
      const options = {
        profileId: owner,
        asOwner: allowed,
        chunk,
        interpret,
        verify,
        now: () => now,
      };
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('retry');
      const original = await cache(db);
      const ids = (row: Awaited<ReturnType<typeof cache>>) =>
        JSON.parse(String(row.payload_json)).reviewedSourceIds;
      expect(ids(original)).toEqual([
        'achievement:achievement',
        'achievement:second',
      ]);
      now += 60 * 60_000;
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe(outcome);
      expect(ids(await cache(db))).toEqual([
        ...ids(original),
        ...(outcome === 'complete'
          ? ['achievement:third', 'achievement:unread']
          : []),
      ]);
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('idle');
      expect(
        attempted.map((id) => id.slice(String(original.request_id).length + 1)),
      ).toEqual([
        '0-draft',
        '0-verify',
        '1-draft',
        '1-split-left-draft',
        '1-split-left-verify',
        '1-split-right-draft',
        ...(outcome === 'complete'
          ? ['1-split-right-verify', '2-draft', '2-verify']
          : []),
      ]);
    } finally {
      await close();
    }
  });

  it('does not subdivide a filtered draft', async () => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      await db.query(
        "INSERT INTO resume_achievements (id, tenant_id, owner_user_id, candidate_profile_id, body) VALUES ('second', 'tenant-a', 'owner', ?, ?)",
        [owner, sourceText],
      );
      for (let tick = 0; tick < 5; tick += 1)
        await runMatchingTick(db, dialect);
      const interpret = vi.fn<Provider>(async ({ revalidate }) => {
        await revalidate();
        throw new MatchingCandidateInterpretationError(
          'candidate_interpretation_provider_incomplete',
          'content_filter',
        );
      });
      expect(
        await runMatchingCandidateInterpretation(db, dialect, {
          profileId: owner,
          asOwner: allowed,
          chunk: oneChunk,
          interpret,
        }),
      ).toBe('failed');
      expect(interpret).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it('refreshes ongoing comparisons on the next UTC day while retaining the evidence request', async () => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      await db.query(
        "INSERT INTO resume_positions (id, tenant_id, owner_user_id, candidate_profile_id, role, start, end_label) VALUES ('ongoing', 'tenant-a', 'owner', ?, 'Backend Engineer', '2016', 'Present')",
        [owner],
      );
      const day = Date.UTC(2026, 10, 5);
      for (let tick = 0; tick < 5; tick += 1)
        await runMatchingTick(db, dialect, day);
      const read = async () => {
        const {
          rows: [row],
        } = await db.query(
          'SELECT profile_revision, facts_json FROM matching_profile_facts WHERE profile_id = ?',
          [owner],
        );
        return {
          revision: row.profile_revision,
          candidate: JSON.parse(String(row.facts_json)),
        };
      };
      const before = await read();
      const pinned = await cache(db);
      expect(before.candidate.ongoingExperienceAsOf).toBe(day);
      const next = day + 86_400_000;
      for (let tick = 0; tick < 6; tick += 1)
        await runMatchingTick(db, dialect, next);
      const after = await read();
      expect(after.candidate.ongoingExperienceAsOf).toBe(next);
      expect(after.revision).not.toEqual(before.revision);
      expect(await cache(db)).toEqual(pinned);
    } finally {
      await close();
    }
  });

  it('binds career evidence only to a current project in the same owned experience', async () => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      await db.query(
        "INSERT INTO experiences VALUES ('exp', 'tenant-a', 'owner', ?, 'Owned experience', TRUE)",
        [owner],
      );
      await db.query(
        "INSERT INTO projects VALUES ('project', 'tenant-a', 'owner', ?, 'exp', 'Owned project', 'Owned summary', TRUE), ('foreign-project', 'tenant-b', 'other', ?, 'exp', 'Foreign project', 'Foreign summary', TRUE)",
        [owner, owner],
      );
      await db.query(
        "INSERT INTO duties VALUES ('linked', 'tenant-a', 'owner', ?, 'exp', 'project', 'Owned duty', 'Body', TRUE), ('mismatch', 'tenant-a', 'owner', ?, 'other-exp', 'project', 'Mismatched duty', 'Body', TRUE), ('foreign', 'tenant-a', 'owner', ?, 'exp', 'foreign-project', 'Foreign reference', 'Body', TRUE)",
        [owner, owner, owner],
      );
      const input = await loadMatchingCandidateInput(db, {
        profileId: owner,
        tenantId: 'tenant-a',
        userId: 'owner',
      });
      const byId = new Map(
        input?.evidence.map((source) => [source.id, source]),
      );
      expect(byId.get('career-duty:linked')).toMatchObject({
        activityId: 'career-experience:exp',
        projectActivityId: 'career-project:project',
      });
      expect(
        byId.get('career-duty:mismatch')?.projectActivityId,
      ).toBeUndefined();
      expect(
        byId.get('career-duty:foreign')?.projectActivityId,
      ).toBeUndefined();
      expect(byId.has('career-project:foreign-project')).toBe(false);
      expect(await cache(db)).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('publishes one scoped interpretation, reuses it after preference and posting edits, and purges it on deletion', async () => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      const original = await cache(db);
      const interpret = vi.fn<Provider>(
        async ({ input, revalidate, requestId }) => {
          await revalidate();
          return { interpretation: proof(input), requestId };
        },
      );
      const options = {
        profileId: owner,
        asOwner: allowed,
        interpret,
        verify: vi.fn<Verifier>(async ({ draft, requestId, revalidate }) => {
          await revalidate();
          return { interpretation: draft, requestId };
        }),
        chunk: oneChunk,
      };
      expect(original).toMatchObject({ state: 'pending', payload_json: '' });
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('complete');
      expect(await cache(db)).toMatchObject({
        state: 'complete',
        request_id: original.request_id,
      });
      await db.query(
        'UPDATE candidate_profiles SET preferences_json = ? WHERE id = ?',
        [
          '{"targetRoles":["Backend Engineer"],"locations":["Canada"],"workModes":["remote"]}',
          owner,
        ],
      );
      await db.query("INSERT INTO sources VALUES ('listed',TRUE,TRUE)");
      await db.query(
        "INSERT INTO opportunities (id,title,description_raw,locations,work_mode,source_id,status) VALUES ('33333333-0000-4000-8000-000000000001','Backend Engineer','Required skills: Observability','Remote (Canada)','remote','listed','found')",
      );
      for (let index = 0; index < 5; index += 1)
        await runMatchingTick(db, dialect);
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('idle');
      expect(interpret).toHaveBeenCalledTimes(1);
      expect(options.verify).toHaveBeenCalledTimes(1);
      expect(await cache(db)).toMatchObject({
        state: 'complete',
        request_id: original.request_id,
      });
      await db.query(
        "DELETE FROM resume_achievements WHERE id = 'achievement'",
      );
      expect(await cache(db)).toBeUndefined();
      expect(
        (
          await db.query(
            'SELECT 1 FROM matching_profile_facts WHERE profile_id = ?',
            [owner],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('resumes a paid draft after a verifier preflight refusal without a duplicate extraction', async () => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      let now = Date.now();
      const interpret = vi.fn<Provider>(
        async ({ input, requestId, revalidate }) => {
          await revalidate();
          return { interpretation: proof(input), requestId };
        },
      );
      const verify = vi
        .fn<Verifier>(async ({ draft, requestId, revalidate }) => {
          await revalidate();
          return { interpretation: draft, requestId };
        })
        .mockRejectedValueOnce(
          new AiUsageRefusedError('user_budget_exhausted', 'budget'),
        );
      const options = {
        profileId: owner,
        asOwner: allowed,
        chunk: oneChunk,
        interpret,
        verify,
        now: () => now,
      };
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('retry');
      expect(await cache(db)).toMatchObject({
        state: 'pending',
        payload_json: '',
        draft_json: expect.any(String),
      });
      expect((await cache(db))?.draft_json).not.toBe('');
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('idle');
      now += 60 * 60_000;
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('complete');
      expect(interpret).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(verify.mock.calls[0][0].requestId).toEqual(
        verify.mock.calls[1][0].requestId,
      );
      expect(interpret.mock.calls[0][0].requestId).not.toEqual(
        verify.mock.calls[0][0].requestId,
      );
      expect(await cache(db)).toMatchObject({
        state: 'complete',
        draft_json: '',
      });
    } finally {
      await close();
    }
  });

  it('retains independently verified earlier chunks when a later paid output fails', async () => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      await db.query(
        "INSERT INTO resume_achievements (id, tenant_id, owner_user_id, candidate_profile_id, body) VALUES ('later', 'tenant-a', 'owner', ?, 'Unread later source')",
        [owner],
      );
      for (let tick = 0; tick < 5; tick += 1)
        await runMatchingTick(db, dialect);
      const interpret = vi.fn<Provider>(
        async ({ input, requestId, revalidate }) => {
          await revalidate();
          if (input.evidence[0].id === 'achievement:later')
            throw new Error('Malformed later output');
          return { interpretation: proof(input), requestId };
        },
      );
      const verify = vi.fn<Verifier>(
        async ({ draft, requestId, revalidate }) => {
          await revalidate();
          return { interpretation: draft, requestId };
        },
      );
      expect(
        await runMatchingCandidateInterpretation(db, dialect, {
          profileId: owner,
          asOwner: allowed,
          chunk: ({ evidence }) =>
            evidence.map((source) => ({ evidence: [source] })),
          interpret,
          verify,
        }),
      ).toBe('failed');
      const retained = await cache(db);
      expect(retained).toMatchObject({ state: 'failed', draft_json: '' });
      expect(JSON.parse(String(retained.payload_json))).toMatchObject({
        reviewedSourceIds: ['achievement:achievement'],
        assertions: [expect.objectContaining({ conceptId: 'observability' })],
      });
      expect(interpret).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it('refuses an unauthorized subject before invoking the provider and blocks stale publication on transfer', async () => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      const denied = vi.fn<Provider>();
      const base = { profileId: owner, chunk: oneChunk };
      expect(
        await runMatchingCandidateInterpretation(db, dialect, {
          ...base,
          asOwner: async () => {
            throw new Error('not authorized');
          },
          interpret: denied,
        }),
      ).toBe('failed');
      expect(denied).not.toHaveBeenCalled();
      expect(await cache(db)).toMatchObject({
        state: 'failed',
        payload_json: '',
      });

      await db.query(
        "UPDATE resume_achievements SET metric = 'Fictional metric' WHERE id = 'achievement'",
      );
      for (let index = 0; index < 5; index += 1)
        await runMatchingTick(db, dialect);
      const transfer = vi.fn<Provider>(
        async ({ revalidate, requestId, input }) => {
          await revalidate();
          await db.query(
            "UPDATE candidate_profiles SET owner_user_id = 'other', tenant_id = 'tenant-b' WHERE id = ?",
            [owner],
          );
          return {
            requestId,
            interpretation: {
              assertions: [],
              reviewedSourceIds: [input.evidence[0].id],
              unresolvedSourceIds: [],
            },
          };
        },
      );
      expect(
        await runMatchingCandidateInterpretation(db, dialect, {
          ...base,
          asOwner: allowed,
          interpret: transfer,
        }),
      ).toBe('stale');
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(await cache(db)).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('rolls back cache deletion with the evidence transaction and does not retry a potentially paid attempt', async () => {
    const { database: db, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      await seed(db, dialect);
      const original = await cache(db);
      if (!db.transaction)
        throw new Error('Test requires native transactions.');
      await expect(
        db.transaction(async (tx) => {
          await tx.query(
            "DELETE FROM resume_achievements WHERE id = 'achievement'",
          );
          expect(await cache(tx)).toBeUndefined();
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await cache(db)).toEqual(original);

      const interpret = vi.fn<Provider>(async ({ revalidate }) => {
        await revalidate();
        throw new Error('ambiguous provider outcome');
      });
      const options = {
        profileId: owner,
        asOwner: allowed,
        chunk: oneChunk,
        interpret,
      };
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('failed');
      expect(
        await runMatchingCandidateInterpretation(db, dialect, options),
      ).toBe('idle');
      expect(await cache(db)).toMatchObject({
        state: 'failed',
        payload_json: '',
      });
      expect(interpret).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });
});
