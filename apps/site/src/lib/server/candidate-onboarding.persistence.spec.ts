import { getTestDatabase } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateProfile } from '../objects/CandidateProfile.js';
import type { ResumeAsset } from '../objects/ResumeAsset.js';
import { claimResumeAssetAtomically } from './candidate-onboarding.js';
import { getCollection } from './smrt.js';

function requiredId(value: { id?: string | null }): string {
  if (!value.id) throw new Error('Fixture record must have an ID.');
  return value.id;
}

describe('Candidate onboarding persistence', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  it('atomically assigns a resume to one contender, leaves the loser untouched, and permits owner replay', async () => {
    const database = await getTestDatabase({
      classes: ['CandidateProfile', 'ResumeAsset'],
    });
    db = database;
    const profiles = await getCollection<CandidateProfile>('CandidateProfile', {
      db: database,
    });
    const assets = await getCollection<ResumeAsset>('ResumeAsset', {
      db: database,
    });
    const firstProfile = await profiles.create({
      name: 'Fictional first contender',
      profileKey: 'fixture-first',
    });
    const secondProfile = await profiles.create({
      name: 'Fictional second contender',
      profileKey: 'fixture-second',
    });
    const asset = await assets.create({
      assetType: 'resume',
      title: 'Synthetic concurrency resume',
    });
    const assetId = requiredId(asset);
    const runTransaction = database.transaction;
    if (!runTransaction)
      throw new Error('Test database must support transactions.');

    const associate = async (profile: CandidateProfile) =>
      await runTransaction.call(database, async (transaction) => {
        const profileId = requiredId(profile);
        const claimed = await claimResumeAssetAtomically(
          transaction,
          assetId,
          profileId,
        );
        if (!claimed) {
          throw new Error(
            'Resume asset was already claimed by another profile.',
          );
        }
        const transactionProfiles = await getCollection<CandidateProfile>(
          'CandidateProfile',
          { db: transaction },
        );
        const persisted = await transactionProfiles.get(profileId);
        if (!persisted) throw new Error('Fixture profile is unavailable.');
        persisted.resumeAssetId = assetId;
        await persisted.save();
        return profileId;
      });

    const outcomes = await Promise.allSettled([
      associate(firstProfile),
      associate(secondProfile),
    ]);
    const winner = outcomes.find(
      (outcome): outcome is PromiseFulfilledResult<string> =>
        outcome.status === 'fulfilled',
    );

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect(winner).toBeDefined();
    if (!winner) throw new Error('Expected a successful resume claim.');

    const persistedProfiles = await profiles.list({ limit: 10 });
    const winnerProfile = persistedProfiles.find(
      (profile) => profile.id === winner?.value,
    );
    const loserProfile = persistedProfiles.find(
      (profile) => profile.id !== winner?.value,
    );
    expect(winnerProfile?.resumeAssetId).toBe(assetId);
    expect(loserProfile?.resumeAssetId).toBe('');
    expect((await assets.get(assetId))?.candidateProfileId).toBe(winner.value);

    await expect(
      runTransaction.call(
        database,
        async (transaction) =>
          await claimResumeAssetAtomically(transaction, assetId, winner.value),
      ),
    ).resolves.toBe(true);
  });
});
