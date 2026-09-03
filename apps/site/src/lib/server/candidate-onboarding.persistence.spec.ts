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
      beforeMutation?: () => Promise<void>,
    ) => {
      const transaction = handle.transaction;
      if (!transaction) {
        throw new Error('Test database must support transactions.');
      }
      return await transaction.call(handle, async (transaction) => {
        const profileId = requiredId(profile);
        // Both transactions are opened before either writes. Holding this
        // contender before its first statement lets the other independent
        // handle commit, then exercises the losing mutation + conditional
        // claim in the first transaction without SQLite writer-lock retries.
        await beforeMutation?.();
        const transactionProfiles = await getCollection<CandidateProfile>(
          'CandidateProfile',
          { db: transaction },
        );
        const persisted = await transactionProfiles.get(profileId);
        if (!persisted) throw new Error('Fixture profile is unavailable.');
        // A losing attempt has already mutated this profile when its conditional
        // claim returns false, so its transaction must roll it back.
        persisted.summary = `attempt-${profileId}`;
        await persisted.save();
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
        persisted.resumeAssetId = assetId;
        await persisted.save();
        return profileId;
      });
    };

    let releaseFirstContender: (() => void) | undefined;
    const firstContenderReleased = new Promise<void>((resolve) => {
      releaseFirstContender = resolve;
    });
    let markFirstContenderReady: (() => void) | undefined;
    const firstContenderReady = new Promise<void>((resolve) => {
      markFirstContenderReady = resolve;
    });
    const firstAttempt = associate(database, firstProfile, async () => {
      markFirstContenderReady?.();
      await firstContenderReleased;
    });
    await firstContenderReady;
    // The first transaction is live on one adapter when the second adapter
    // claims and commits. Releasing the first one afterwards verifies that its
    // pre-claim profile mutation rolls back when the predicate rejects it.
    await expect(associate(contenderDatabase, secondProfile)).resolves.toBe(
      requiredId(secondProfile),
    );
    releaseFirstContender?.();
    await expect(firstAttempt).rejects.toThrow(
      'Resume asset was already claimed by another profile.',
    );

    const persistedProfiles = await profiles.list({ limit: 10 });
    const losingProfile = persistedProfiles.find(
      (profile) => profile.id === firstProfile.id,
    );
    const winningProfile = persistedProfiles.find(
      (profile) => profile.id === secondProfile.id,
    );
    expect(losingProfile?.resumeAssetId).toBe('');
    expect(losingProfile?.summary).toBe('');
    expect(winningProfile?.resumeAssetId).toBe(assetId);
    expect((await assets.get(assetId))?.candidateProfileId).toBe(
      secondProfile.id,
    );

    const winnerTransaction = database.transaction;
    if (!winnerTransaction) {
      throw new Error('Test database must support transactions.');
    }
    await expect(
      winnerTransaction.call(
        database,
        async (transaction) =>
          await claimResumeAssetAtomically(
            transaction,
            assetId,
            requiredId(secondProfile),
          ),
      ),
    ).resolves.toBe(true);
  });
});
