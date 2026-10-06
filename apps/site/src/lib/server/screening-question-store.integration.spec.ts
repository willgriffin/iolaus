import { randomUUID } from 'node:crypto';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import type { WorkspaceSubject } from './private-workspace.js';
import {
  createScreeningQuestion,
  deleteScreeningQuestion,
  listScreeningQuestions,
  type ScreeningQuestionStoreDependencies,
  updateScreeningQuestion,
} from './screening-question-store.js';

const databaseUrl = process.env.SCREENING_QUESTION_STORE_POSTGRES_URL;
const enabled = !!databaseUrl;
/** Opt-in disposable localhost database only; a session-local native table shadows production. */
describe.runIf(enabled)(
  'screening question PostgreSQL persistence isolation',
  () => {
    it('round-trips canonical rows, rejects stale CAS and foreign tuple, and invalidates generic edits', async () => {
      const url = new URL(databaseUrl!);
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname))
        throw new Error(
          'Screening question integration requires a disposable localhost database.',
        );
      const db = await resolveDatabase(
        { type: 'postgres', url: url.toString() },
        { dbid: `screening-question-test-${randomUUID()}` },
      );
      if (!db.acquireSession)
        throw new Error('PostgreSQL coverage requires a dedicated session.');
      const session = await db.acquireSession();
      const subject: WorkspaceSubject = {
        tenantId: randomUUID(),
        userId: 'question-owner',
        profileId: randomUUID(),
      };
      const principal: PrincipalRun = {
        context: {} as PrincipalRun['context'],
        permissions: ['workflow.profile.manage'],
        allowedTools: [],
        isToolAllowed: () => false,
        assertToolAllowed: () => {
          throw new Error('No tools.');
        },
        assertOperation: async () => undefined as never,
      };
      const runFresh: NonNullable<
        ScreeningQuestionStoreDependencies['runFresh']
      > = async <T>(
        owned: typeof subject,
        _capability: Parameters<
          NonNullable<ScreeningQuestionStoreDependencies['runFresh']>
        >[1],
        work: (owned: typeof subject, run: PrincipalRun) => Promise<T>,
      ) => await work(owned, principal);
      const deps: ScreeningQuestionStoreDependencies = {
        db: session,
        runFresh,
        getProfile: async (id) => ({
          id,
          tenantId: subject.tenantId,
          ownerUserId: subject.userId,
          active: true,
        }),
      };
      try {
        await session.query(
          `CREATE TEMP TABLE preference_rules (id UUID PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tenant_id UUID NOT NULL, owner_user_id TEXT NOT NULL, candidate_profile_id TEXT NOT NULL, category TEXT, name TEXT, description TEXT, weight REAL, is_hard_filter BOOLEAN, rule_json TEXT, active BOOLEAN)`,
        );
        const created = await createScreeningQuestion(
          subject,
          {
            text: 'Is remote work in Canada explicitly offered?',
            kind: 'source',
            importance: 'must_have',
            desiredAnswer: 'yes',
            weight: 5,
            active: true,
          },
          deps,
        );
        const original = created.questions[0]!;
        const changed = await updateScreeningQuestion(
          subject,
          {
            id: original.id,
            expectedRevision: original.revision,
            patch: { weight: 8 },
          },
          deps,
        );
        expect(changed.questions[0]?.weight).toBe(8);
        await expect(
          updateScreeningQuestion(
            subject,
            {
              id: original.id,
              expectedRevision: original.revision,
              patch: { weight: 2 },
            },
            deps,
          ),
        ).rejects.toThrow('changed');
        const foreign = { ...subject, userId: 'foreign-owner' };
        const foreignDeps = {
          ...deps,
          getProfile: async (id: string) => ({
            id,
            tenantId: foreign.tenantId,
            ownerUserId: foreign.userId,
            active: true,
          }),
        };
        expect(
          (await listScreeningQuestions(foreign, foreignDeps)).questions,
        ).toEqual([]);
        await expect(
          deleteScreeningQuestion(
            foreign,
            {
              id: original.id,
              expectedRevision: changed.questions[0]!.revision,
            },
            foreignDeps,
          ),
        ).rejects.toThrow('not found');
        await session.query(
          'UPDATE preference_rules SET active = FALSE WHERE id = ?',
          original.id,
        );
        const disabled = await listScreeningQuestions(subject, deps);
        expect(disabled.questions[0]?.active).toBe(false);
        expect(disabled.questionSetFingerprint).not.toBe(
          changed.questionSetFingerprint,
        );
        await session.query(
          'UPDATE preference_rules SET rule_json = ? WHERE id = ?',
          '{broken',
          original.id,
        );
        const invalid = await listScreeningQuestions(subject, deps);
        expect(invalid.questions).toEqual([]);
        expect(invalid.invalidQuestions).toHaveLength(1);
        await deleteScreeningQuestion(
          subject,
          {
            id: original.id,
            expectedRevision: invalid.invalidQuestions[0]!.revision,
          },
          deps,
        );
        expect(
          (await session.query('SELECT id FROM preference_rules')).rows,
        ).toEqual([]);
      } finally {
        await session.query('DROP TABLE IF EXISTS pg_temp.preference_rules');
        await session.release();
      }
    });
  },
);
