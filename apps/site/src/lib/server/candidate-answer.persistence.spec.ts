import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateAnswer } from '../objects/CandidateAnswer.js';
import { normalizeAnswerLabel } from './candidate-answers.js';
import { getCollection } from './smrt.js';

const subject = { tenantId: 'tenant-fixture', userId: 'user-fixture' };

describe('CandidateAnswer persistence', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  it('keeps punctuation-distinct labels and profile-scoped answers separate', async () =>
    withTenant(subject, async () => {
      // getTestDatabase uses SMRT's production schema generator, so this covers
      // the actual unique index and ON CONFLICT target rather than a collection
      // mock. C++ and C# intentionally share SMRT's generated slug.
      db = await getTestDatabase({
        classes: ['CandidateAnswer', 'CandidateProfile'],
      });
      const answers = await getCollection<CandidateAnswer>('CandidateAnswer', {
        db,
      });
      const profiles = await getCollection('CandidateProfile', { db });
      const primary = await profiles.create({
        ownerUserId: subject.userId,
        tenantId: subject.tenantId,
        profileKey: 'default',
      });
      const alternate = await profiles.create({
        ownerUserId: subject.userId,
        tenantId: subject.tenantId,
        profileKey: 'alternate',
      });
      if (!primary.id || !alternate.id)
        throw new Error('Fixture profiles need IDs.');
      const cPlusPlusKey = normalizeAnswerLabel('C++');
      const cSharpKey = normalizeAnswerLabel('C#');

      await answers.create({
        ownerUserId: subject.userId,
        tenantId: subject.tenantId,
        label: 'C++',
        labelKey: cPlusPlusKey,
        candidateProfileId: primary.id,
        profileKey: 'default',
        value: 'Primary C++ answer',
      });
      await answers.create({
        ownerUserId: subject.userId,
        tenantId: subject.tenantId,
        label: 'C#',
        labelKey: cSharpKey,
        candidateProfileId: primary.id,
        profileKey: 'default',
        value: 'Primary C# answer',
      });
      await answers.create({
        ownerUserId: subject.userId,
        tenantId: subject.tenantId,
        label: 'C++',
        labelKey: cPlusPlusKey,
        candidateProfileId: alternate.id,
        profileKey: 'alternate',
        value: 'Alternate C++ answer',
      });

      // The same natural key updates its row, while the two slug collisions and
      // the second profile keep their own rows.
      await answers.create({
        ownerUserId: subject.userId,
        tenantId: subject.tenantId,
        label: 'C++',
        labelKey: cPlusPlusKey,
        candidateProfileId: primary.id,
        profileKey: 'default',
        value: 'Updated primary C++ answer',
      });

      const saved = await answers.list({ limit: 10 });
      expect(saved).toHaveLength(3);
      expect(
        new Map(
          saved.map((answer) => [
            `${answer.profileKey}:${answer.labelKey}`,
            answer.value,
          ]),
        ),
      ).toEqual(
        new Map([
          [`default:${cPlusPlusKey}`, 'Updated primary C++ answer'],
          [`default:${cSharpKey}`, 'Primary C# answer'],
          [`alternate:${cPlusPlusKey}`, 'Alternate C++ answer'],
        ]),
      );
    }));
});
