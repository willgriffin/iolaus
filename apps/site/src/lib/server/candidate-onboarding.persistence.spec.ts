import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
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
  const databases: DatabaseInterface[] = [];
  let directory: string | undefined;

  afterEach(async () => {
    await Promise.all(
      databases.map(async (database) => await database.close?.()),
    );
    databases.length = 0;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('atomically assigns a resume across independent SQLite handles, rolls back the loser, and permits owner replay', async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-onboarding-'));
    const databasePath = join(directory, 'candidate-onboarding.sqlite');
    // `cache: false` is intentional: separate adapters to the same file avoid
    // the per-connection transaction queue and exercise cross-handle claims.
    const database = await getDatabase({
      type: 'sqlite',
      url: databasePath,
      cache: false,
    });
    databases.push(database);
    await getTestDatabase({
      db: database,
      type: 'sqlite',
      classes: ['CandidateProfile', 'ResumeAsset'],
    });
    const contenderDatabase = await getDatabase({
      type: 'sqlite',
      url: databasePath,
      cache: false,
    });
    databases.push(contenderDatabase);
    expect(contenderDatabase).not.toBe(database);
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
    const associate = async (
      handle: DatabaseInterface,
      profile: CandidateProfile,
    ) => {
      const transaction = handle.transaction;
      if (!transaction) {
        throw new Error('Test database must support transactions.');
      }
      return await transaction.call(handle, async (transaction) => {
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
    };

    const firstAttempt = associate(database, firstProfile);
    // SQLite admits only one writer. Start the second independently submitted
    // contender immediately after the first commit so it observes the durable
    // conditional claim rather than an adapter-specific lock error.
    const secondAttempt = firstAttempt.then(
      async () => await associate(contenderDatabase, secondProfile),
    );
    const outcomes = await Promise.allSettled([firstAttempt, secondAttempt]);
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
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({
      message: 'Resume asset was already claimed by another profile.',
    });
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

    const winnerDatabase =
      winner.value === requiredId(firstProfile) ? database : contenderDatabase;
    const winnerTransaction = winnerDatabase.transaction;
    if (!winnerTransaction) {
      throw new Error('Test database must support transactions.');
    }
    await expect(
      winnerTransaction.call(
        winnerDatabase,
        async (transaction) =>
          await claimResumeAssetAtomically(transaction, assetId, winner.value),
      ),
    ).resolves.toBe(true);
  });
});
