import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import {
  createScreeningQuestion,
  deleteScreeningQuestion,
  listAssessmentScreeningQuestions,
  listScreeningQuestions,
  type ScreeningQuestionStoreDependencies,
  updateScreeningQuestion,
} from './screening-question-store.js';

const subject = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  profileId: 'profile-a',
};
const input = {
  text: 'Does this posting offer remote work?',
  kind: 'source',
  importance: 'preference',
  desiredAnswer: 'yes',
  weight: 3,
  active: true,
};
const principal: PrincipalRun = {
  context: {} as PrincipalRun['context'],
  permissions: ['workflow.profile.manage', 'workflow.assessment.execute'],
  allowedTools: [],
  isToolAllowed: () => false,
  assertToolAllowed: () => {
    throw new Error('No tools.');
  },
  assertOperation: vi.fn(async () => undefined as never),
};
async function fixture() {
  const db = await getDatabase({
    type: 'sqlite',
    url: ':memory:',
    cache: false,
  });
  await db.query(
    `CREATE TABLE preference_rules (id TEXT PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, candidate_profile_id TEXT NOT NULL, category TEXT, name TEXT, description TEXT, weight REAL, is_hard_filter BOOLEAN, rule_json TEXT, active BOOLEAN)`,
  );
  const profile = {
    id: subject.profileId,
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
    active: true,
    preferencesJson: '{"workModes":["remote"]}',
  };
  const getProfile = vi.fn(async () => profile);
  const freshSpy = vi.fn();
  const runFresh: NonNullable<
    ScreeningQuestionStoreDependencies['runFresh']
  > = async <T>(
    owned: typeof subject,
    capability: Parameters<
      NonNullable<ScreeningQuestionStoreDependencies['runFresh']>
    >[1],
    work: (owned: typeof subject, run: PrincipalRun) => Promise<T>,
  ) => {
    freshSpy(capability);
    return await work(owned, principal);
  };
  return {
    db,
    profile,
    getProfile,
    freshSpy,
    deps: { db, getProfile, runFresh },
  };
}
describe('owned screening question storage', () => {
  it('preserves over-limit questions for repair and bounds stored inserts without silently truncating', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 21; i++)
        await createScreeningQuestion(
          subject,
          { ...input, text: `Authored screening question ${i}?` },
          f.deps,
        );
      const snapshot = await listScreeningQuestions(subject, f.deps);
      expect(snapshot.questions).toHaveLength(21);
      expect(snapshot.errors).toEqual([
        'Enable at most 20 screening questions.',
      ]);
      expect(snapshot.questionSetFingerprint).toBe('');
      for (let i = 21; i < 40; i++)
        await createScreeningQuestion(
          subject,
          {
            ...input,
            text: `Inactive screening question ${i}?`,
            active: false,
          },
          f.deps,
        );
      await expect(
        createScreeningQuestion(subject, { ...input, active: false }, f.deps),
      ).rejects.toThrow('at most 40');
      expect(
        (await f.db.query('SELECT id FROM preference_rules')).rows,
      ).toHaveLength(40);
    } finally {
      await f.db.close?.();
    }
  });
  it('reads actual owned question rows with assessment-only capability and cannot use it for private CRUD', async () => {
    const f = await fixture();
    try {
      const authored = await createScreeningQuestion(subject, input, f.deps);
      const previousFresh = f.deps.runFresh;
      const assessmentOnly: typeof previousFresh = async <T>(
        owned: typeof subject,
        capability: Parameters<typeof previousFresh>[1],
        work: (owned: typeof subject, run: PrincipalRun) => Promise<T>,
      ) => {
        if (capability !== 'assessment.execute')
          throw new Error('Profile management is not granted.');
        return await previousFresh(owned, capability, work);
      };
      const deps = { ...f.deps, runFresh: assessmentOnly };
      const snapshot = await listAssessmentScreeningQuestions(subject, deps);
      expect(snapshot.questions).toEqual(authored.questions);
      expect(snapshot.questionSetFingerprint).toBe(
        authored.questionSetFingerprint,
      );
      expect(snapshot.invalidQuestions).toEqual([]);
      expect(f.freshSpy).toHaveBeenLastCalledWith('assessment.execute');
      await expect(
        createScreeningQuestion(subject, input, deps),
      ).rejects.toThrow('Profile management');
      await expect(
        updateScreeningQuestion(
          subject,
          {
            id: authored.questions[0]!.id,
            expectedRevision: authored.questions[0]!.revision,
            patch: { weight: 7 },
          },
          deps,
        ),
      ).rejects.toThrow('Profile management');
      await expect(
        deleteScreeningQuestion(
          subject,
          {
            id: authored.questions[0]!.id,
            expectedRevision: authored.questions[0]!.revision,
          },
          deps,
        ),
      ).rejects.toThrow('Profile management');
      expect(
        (await f.db.query('SELECT id FROM preference_rules')).rows,
      ).toHaveLength(1);
    } finally {
      await f.db.close?.();
    }
  });
  it('never saves suggestions on read and round-trips authored revisions through actual native rows', async () => {
    const f = await fixture();
    try {
      const empty = await listScreeningQuestions(subject, f.deps);
      expect(empty.questions).toEqual([]);
      expect(empty.suggestions).toHaveLength(1);
      expect(
        (await f.db.query('SELECT * FROM preference_rules')).rows,
      ).toHaveLength(0);
      const created = await createScreeningQuestion(subject, input, f.deps);
      const question = created.questions[0]!;
      const updated = await updateScreeningQuestion(
        subject,
        {
          id: question.id,
          expectedRevision: question.revision,
          patch: { weight: 9 },
        },
        f.deps,
      );
      expect(updated.questions[0]?.weight).toBe(9);
      expect(updated.questionSetFingerprint).not.toBe(
        created.questionSetFingerprint,
      );
      await expect(
        updateScreeningQuestion(
          subject,
          {
            id: question.id,
            expectedRevision: question.revision,
            patch: { text: 'stale edit' },
          },
          f.deps,
        ),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
      const deleted = await deleteScreeningQuestion(
        subject,
        { id: question.id, expectedRevision: updated.questions[0]!.revision },
        f.deps,
      );
      expect(deleted.questions).toEqual([]);
      expect(
        f.freshSpy.mock.calls.every(
          ([capability]) => capability === 'profile.manage',
        ),
      ).toBe(true);
    } finally {
      await f.db.close?.();
    }
  });
  it.each([
    { tenantId: 'other' },
    { userId: 'other' },
    { profileId: 'other' },
  ])('does not read or mutate another ownership tuple %j', async (changed) => {
    const f = await fixture();
    try {
      const question = (await createScreeningQuestion(subject, input, f.deps))
        .questions[0]!;
      const foreign = { ...subject, ...changed };
      f.getProfile.mockImplementation(async () => ({
        ...f.profile,
        id: foreign.profileId,
        tenantId: foreign.tenantId,
        ownerUserId: foreign.userId,
      }));
      expect((await listScreeningQuestions(foreign, f.deps)).questions).toEqual(
        [],
      );
      await expect(
        deleteScreeningQuestion(
          foreign,
          { id: question.id, expectedRevision: question.revision },
          f.deps,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (await f.db.query('SELECT * FROM preference_rules')).rows,
      ).toHaveLength(1);
    } finally {
      await f.db.close?.();
    }
  });
  it('rejects inactive, foreign-loaded profiles and revoked authority before any write', async () => {
    const f = await fixture();
    try {
      f.profile.active = false;
      await expect(
        createScreeningQuestion(subject, input, f.deps),
      ).rejects.toThrow('active profile');
      expect(f.getProfile).toHaveBeenCalledWith(subject.profileId);
      f.profile.active = true;
      f.profile.ownerUserId = 'foreign';
      await expect(
        createScreeningQuestion(subject, input, f.deps),
      ).rejects.toThrow('active profile');
      f.profile.ownerUserId = subject.userId;
      const denied: NonNullable<
        ScreeningQuestionStoreDependencies['runFresh']
      > = async () => {
        throw new Error('Permission revoked.');
      };
      await expect(
        createScreeningQuestion(subject, input, {
          ...f.deps,
          runFresh: denied,
        }),
      ).rejects.toThrow('revoked');
      expect(
        (await f.db.query('SELECT * FROM preference_rules')).rows,
      ).toHaveLength(0);
    } finally {
      await f.db.close?.();
    }
  });
  it('exposes malformed or generic-edited native rows for explicit CAS repair/delete and never silently falls back', async () => {
    const f = await fixture();
    try {
      const before = await createScreeningQuestion(subject, input, f.deps);
      const question = before.questions[0]!;
      await f.db.query(
        'UPDATE preference_rules SET name = ? WHERE id = ?',
        'Generic editor changed it',
        question.id,
      );
      const broken = await listScreeningQuestions(subject, f.deps);
      expect(broken.questions).toEqual([]);
      expect(broken.invalidQuestions).toHaveLength(1);
      await expect(
        deleteScreeningQuestion(
          subject,
          { id: question.id, expectedRevision: question.revision },
          f.deps,
        ),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
      const repaired = await updateScreeningQuestion(
        subject,
        {
          id: question.id,
          expectedRevision: broken.invalidQuestions[0]!.revision,
          patch: { ...input, text: 'Explicit repaired question' },
        },
        f.deps,
      );
      expect(repaired.invalidQuestions).toEqual([]);
      expect(repaired.questions[0]?.text).toBe('Explicit repaired question');
      await f.db.query(
        'UPDATE preference_rules SET rule_json = ? WHERE id = ?',
        '{invalid',
        question.id,
      );
      const malformed = await listScreeningQuestions(subject, f.deps);
      expect(malformed.invalidQuestions[0]).not.toHaveProperty('ruleJson');
      expect(
        (
          await deleteScreeningQuestion(
            subject,
            {
              id: question.id,
              expectedRevision: malformed.invalidQuestions[0]!.revision,
            },
            f.deps,
          )
        ).questions,
      ).toEqual([]);
    } finally {
      await f.db.close?.();
    }
  });
  it('derives generic active changes from native fields and refuses a race at the final write fence', async () => {
    const f = await fixture();
    try {
      const first = await createScreeningQuestion(subject, input, f.deps);
      const question = first.questions[0]!;
      await f.db.query(
        'UPDATE preference_rules SET active = FALSE WHERE id = ?',
        question.id,
      );
      const disabled = await listScreeningQuestions(subject, f.deps);
      expect(disabled.questions[0]?.active).toBe(false);
      expect(disabled.questionSetFingerprint).not.toBe(
        first.questionSetFingerprint,
      );
      const prior = f.deps.runFresh;
      let freshCalls = 0;
      const racing: typeof prior = async <T>(
        owned: typeof subject,
        capability: Parameters<typeof prior>[1],
        work: (owned: typeof subject, run: PrincipalRun) => Promise<T>,
      ) => {
        freshCalls++;
        if (freshCalls === 2)
          await f.db.query(
            'UPDATE preference_rules SET name = ? WHERE id = ?',
            'Racing generic change',
            question.id,
          );
        return await prior(owned, capability, work);
      };
      await expect(
        updateScreeningQuestion(
          subject,
          {
            id: question.id,
            expectedRevision: disabled.questions[0]!.revision,
            patch: { weight: 8 },
          },
          { ...f.deps, runFresh: racing },
        ),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(
        (await listScreeningQuestions(subject, f.deps)).invalidQuestions,
      ).toHaveLength(1);
    } finally {
      await f.db.close?.();
    }
  });
  it.each([
    { kind: 'other' },
    { weight: 0 },
    { active: 'yes' },
    { text: '' },
  ])('rejects malformed editor input %j without writing', async (changed) => {
    const f = await fixture();
    try {
      await expect(
        createScreeningQuestion(subject, { ...input, ...changed }, f.deps),
      ).rejects.toMatchObject({ code: 'invalid_question' });
      expect(
        (await f.db.query('SELECT * FROM preference_rules')).rows,
      ).toHaveLength(0);
    } finally {
      await f.db.close?.();
    }
  });
});
