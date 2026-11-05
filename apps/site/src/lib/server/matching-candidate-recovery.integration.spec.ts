import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import { runAsRevalidatedJobWorkspaceSubject } from './job-workspace-subject.js';
import {
  chunkMatchingCandidateEvidence,
  matchingCandidateDraftRequestId,
  matchingCandidateVerificationRequestId,
} from './matching-candidate-interpretation.js';
import { queueMatchingCandidateDraftRecovery } from './matching-candidate-recovery.js';
import {
  matchingCandidateCachePins,
  matchingCandidateEvidenceDigest,
} from './matching-candidate-store.js';
import {
  loadMatchingCandidateInput,
  loadMatchingVocabulary,
} from './matching-projection-input.js';
import type { MatchingDialect } from './matching-projection-read.js';
import { ensureMatchingProjectionSchema } from './matching-projection-schema.js';
import type { MatchingProfileScope } from './matching-projection-worker.js';

vi.mock('./job-workspace-subject.js', () => ({
  runAsRevalidatedJobWorkspaceSubject: vi.fn(),
}));

const asOwner = vi.mocked(runAsRevalidatedJobWorkspaceSubject);
const profileId = '11111111-0000-4000-8000-000000000001';
const requestId = 'recorded-original-request-id';
const postgresUrl = process.env.IOLAUS_MATCHING_TEST_DATABASE_URL;
const dialects: MatchingDialect[] = [
  'sqlite',
  ...(postgresUrl ? ['postgres' as const] : []),
];

afterEach(() => {
  vi.resetAllMocks();
});

it('refuses historical recovery for a remote database before entering the owner context', async () => {
  const database = {
    url: 'postgres://database.example.invalid/remote',
  } as DatabaseInterface;
  expect(
    await queueMatchingCandidateDraftRecovery(database, 'postgres', profileId, {
      observedRequestId: 'a'.repeat(64),
    }),
  ).toEqual({ state: 'ineligible' });
  expect(asOwner).not.toHaveBeenCalled();
});

async function seed(db: DatabaseInterface, dialect: MatchingDialect) {
  await db.query("INSERT INTO users VALUES ('owner','active')");
  await db.query("INSERT INTO tenants VALUES ('tenant','active')");
  await db.query(
    "INSERT INTO memberships VALUES ('tenant','owner','active','member')",
  );
  await db.query(
    `INSERT INTO candidate_profiles VALUES (?, TRUE, 'tenant', 'owner',
      '{"targetRoles":["Backend Engineer"],"locations":["Canada"]}',
      '{"facts":{},"version":1}', '{}')`,
    [profileId],
  );
  for (let index = 0; index < 40; index += 1)
    await db.query(
      `INSERT INTO resume_achievements (id, tenant_id, owner_user_id, candidate_profile_id, body)
       VALUES (?, 'tenant', 'owner', ?, ?)`,
      [`sample-${index}`, profileId, `Built sample service number ${index}.`],
    );
  await ensureMatchingProjectionSchema(db, dialect);
  await db.query(
    `CREATE TABLE ai_user_spend_entries (
      tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, feature TEXT NOT NULL,
      request_id TEXT NOT NULL, status TEXT NOT NULL, accounting_basis TEXT NOT NULL
    )`,
  );
  const {
    rows: [pins],
  } = await db.query(
    `SELECT pv.revision AS profile_revision, vv.revision AS vocabulary_revision
       FROM matching_profile_versions pv CROSS JOIN matching_vocabulary_version vv
       WHERE pv.profile_id = ? AND vv.id = 1`,
    [profileId],
  );
  const scope: MatchingProfileScope = {
    profileId,
    tenantId: 'tenant',
    userId: 'owner',
    profileRevision: String(pins.profile_revision),
    vocabularyRevision: String(pins.vocabulary_revision),
  };
  const input = await loadMatchingCandidateInput(db, scope);
  if (!input) throw new Error('Missing fixture input.');
  const vocabulary = await loadMatchingVocabulary(db);
  const [prefix, original] = chunkMatchingCandidateEvidence(input, vocabulary);
  if (!original || original.evidence.length < 2)
    throw new Error('Missing splittable fixture chunk.');
  const payload = JSON.stringify({
    assertions: [],
    reviewedSourceIds: prefix.evidence.map(({ id }) => id),
    unresolvedSourceIds: [],
  });
  await db.query(
    `INSERT INTO matching_candidate_interpretations (
      profile_id, tenant_id, user_id, vocabulary_revision, policy_version,
      contract_version, input_digest, request_id, state, payload_json, next_chunk
    ) VALUES (?, ?, ?, CAST(? AS BIGINT), ?, ?, ?, ?, 'failed', ?, 1)`,
    [
      ...matchingCandidateCachePins(scope),
      matchingCandidateEvidenceDigest(input),
      requestId,
      payload,
    ],
  );
  const draftReceipt = matchingCandidateDraftRequestId({
    subject: scope,
    input: original,
    requestId: `${requestId}-1-draft`,
  });
  const verifierReceipt = matchingCandidateVerificationRequestId({
    subject: scope,
    requestId: `${requestId}-1-verify`,
  });
  const receipt = async (
    id = draftReceipt,
    basis = 'actual',
    owner = 'owner',
    status = 'settled',
  ) =>
    db.query(
      "INSERT INTO ai_user_spend_entries VALUES ('tenant', ?, 'matching-candidate-interpretation', ?, ?, ?)",
      [owner, id, status, basis],
    );
  const recover = (dryRun = false, observedRequestId = draftReceipt) =>
    queueMatchingCandidateDraftRecovery(db, dialect, profileId, {
      observedRequestId,
      dryRun,
    });
  const read = async () => {
    const {
      rows: [row],
    } = await db.query(
      'SELECT state, payload_json, draft_json, request_id, split_chunk, next_chunk, lease FROM matching_candidate_interpretations WHERE profile_id = ?',
      [profileId],
    );
    return row;
  };
  asOwner.mockImplementation(async (current, capability, run) => {
    expect(current).toEqual(scope);
    expect(capability).toBe('profile.manage');
    return run(current, {} as Parameters<typeof run>[1]);
  });
  return { recover, receipt, read, verifierReceipt, payload, draftReceipt };
}

describe.each(dialects)('operator candidate draft recovery (%s)', (dialect) => {
  it('forecasts without mutation, then queues only the failed original chunk and preserves its verified prefix', async () => {
    const { database, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      const { recover, receipt, read, payload } = await seed(database, dialect);
      await receipt();
      expect(await recover(false, 'a'.repeat(64))).toEqual({
        state: 'ineligible',
      });
      const before = await read();
      const forecast = await recover(true);
      expect(forecast).toMatchObject({ state: 'eligible', chunk: 1 });
      if (forecast.state !== 'eligible') throw new Error('Missing forecast.');
      expect(forecast.reservedSpendMicros).toBeGreaterThan(0);
      expect(await read()).toEqual(before);
      if (dialect === 'postgres') {
        const concurrent = await Promise.all([recover(), recover()]);
        expect(concurrent).toEqual(
          expect.arrayContaining([
            { ...forecast, state: 'queued' },
            { state: 'ineligible' },
          ]),
        );
      } else {
        expect(await recover()).toEqual({ ...forecast, state: 'queued' });
      }
      expect(await read()).toMatchObject({
        state: 'pending',
        split_chunk: 1,
        next_chunk: 1,
        request_id: requestId,
        draft_json: '',
        payload_json: payload,
        lease: '',
      });
      expect(await recover()).toEqual({ state: 'ineligible' });
      expect(
        (await database.query('SELECT * FROM ai_user_spend_entries')).rows,
      ).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('rejects an absent, unrelated, non-actual, duplicate or already verified receipt', async () => {
    const { database, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      const { recover, receipt, read, verifierReceipt, draftReceipt } =
        await seed(database, dialect);
      const before = await read();
      expect(await recover()).toEqual({ state: 'ineligible' });
      await receipt(draftReceipt, 'actual', 'other');
      expect(await recover()).toEqual({ state: 'ineligible' });
      await receipt(draftReceipt, 'conservative');
      expect(await recover()).toEqual({ state: 'ineligible' });
      await receipt();
      expect(await recover()).toEqual({ state: 'ineligible' });
      await database.query(
        "DELETE FROM ai_user_spend_entries WHERE accounting_basis = 'conservative'",
      );
      await receipt(verifierReceipt, 'reserved', 'owner', 'reserved');
      expect(await recover()).toEqual({ state: 'ineligible' });
      expect(await read()).toEqual(before);
    } finally {
      await close();
    }
  });

  it('does not recover a malformed verified prefix or a scope revoked at the native fence', async () => {
    const { database, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      const { recover, receipt, read, payload } = await seed(database, dialect);
      await receipt();
      await database.query(
        "UPDATE matching_candidate_interpretations SET payload_json = '{}'",
      );
      expect(await recover()).toEqual({ state: 'ineligible' });
      await database.query(
        'UPDATE matching_candidate_interpretations SET payload_json = ?',
        [payload],
      );
      asOwner.mockImplementationOnce(async (scope, _capability, run) => {
        await database.query("UPDATE memberships SET status = 'inactive'");
        return run(scope, {} as Parameters<typeof run>[1]);
      });
      expect(await recover()).toEqual({ state: 'ineligible' });
      expect((await read())?.state).not.toBe('pending');
    } finally {
      await close();
    }
  });

  it('rejects an evidence edit racing the native owner entry', async () => {
    const { database, close } = await createMatchingProjectionFixture(
      dialect,
      postgresUrl,
    );
    try {
      const { recover, receipt, read } = await seed(database, dialect);
      await receipt();
      asOwner.mockImplementationOnce(async (scope, _capability, run) => {
        await database.query(
          "UPDATE resume_achievements SET body = 'Edited source' WHERE id = 'sample-0'",
        );
        return run(scope, {} as Parameters<typeof run>[1]);
      });
      expect(await recover()).toEqual({ state: 'ineligible' });
      expect(await read()).toBeUndefined();
    } finally {
      await close();
    }
  });
});
