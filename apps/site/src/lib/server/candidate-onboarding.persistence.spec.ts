import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateAnswer } from '../objects/CandidateAnswer.js';
import type { CandidateProfile } from '../objects/CandidateProfile.js';
import type { ResumeAsset } from '../objects/ResumeAsset.js';
import {
  type CandidateOnboardingCollections,
  claimResumeAssetAtomically,
  DEFAULT_CANDIDATE_PROFILE_ID,
  persistCandidateOnboarding,
} from './candidate-onboarding.js';
import { getCollection } from './smrt.js';

function requiredId(value: { id?: string | null }): string {
  if (!value.id) throw new Error('Fixture record must have an ID.');
  return value.id;
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    /\bSQLITE_BUSY\b/.test(error.message)
  );
}

function isConcurrentWriteConflict(error: unknown): boolean {
  return (
    isSqliteBusyError(error) ||
    (typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string' &&
      /Revision conflict/.test(error.message))
  );
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

  it('converges concurrent first saves on one canonical profile', async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-onboarding-profile-'));
    const databasePath = join(directory, 'candidate-onboarding.sqlite');
    const first = await getDatabase({
      type: 'sqlite',
      url: databasePath,
      cache: false,
    });
    databases.push(first);
    await getTestDatabase({
      db: first,
      type: 'sqlite',
      classes: ['CandidateAnswer', 'CandidateProfile', 'ResumeAsset'],
    });
    const second = await getDatabase({
      type: 'sqlite',
      url: databasePath,
      cache: false,
    });
    databases.push(second);

    // Initialize SMRT's system tables on both independent handles before the
    // race. The scenario below is about the application-level profile upsert,
    // not concurrent framework migration bootstrap.
    for (const database of [first, second]) {
      await getCollection<CandidateProfile>('CandidateProfile', {
        db: database,
      });
    }

    const save = async (database: DatabaseInterface, firstName: string) => {
      return await persistCandidateOnboarding({ firstName }, {
        candidateAnswers: await getCollection<CandidateAnswer>(
          'CandidateAnswer',
          { db: database },
        ),
        candidateProfiles: await getCollection<CandidateProfile>(
          'CandidateProfile',
          { db: database },
        ),
        resumeAssets: await getCollection<ResumeAsset>('ResumeAsset', {
          db: database,
        }),
      } as unknown as CandidateOnboardingCollections);
    };
    const retryBusySave = async (
      database: DatabaseInterface,
      firstName: string,
    ) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          return await save(database, firstName);
        } catch (error) {
          if (!isConcurrentWriteConflict(error)) throw error;
          lastError = error;
          await new Promise((resolve) =>
            setTimeout(resolve, 25 * (attempt + 1)),
          );
        }
      }
      throw lastError;
    };

    const attempts = await Promise.allSettled([
      save(first, 'Fictional A'),
      save(second, 'Fictional B'),
    ]);
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === 'rejected',
    );
    expect(
      rejected.every((attempt) => isConcurrentWriteConflict(attempt.reason)),
    ).toBe(true);

    // SQLite may reject simultaneous writers. Retrying those ordinary busy
    // result must still converge on the same canonical row rather than create
    // the duplicate that the stable ID and conflict target are preventing.
    for (const [index, attempt] of attempts.entries()) {
      if (attempt.status === 'rejected') {
        await retryBusySave(index === 0 ? first : second, 'Fictional retry');
      }
    }
    const profiles = await getCollection<CandidateProfile>('CandidateProfile', {
      db: first,
    });
    const rows = await profiles.list({
      limit: 10,
      where: { profileKey: 'default' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(DEFAULT_CANDIDATE_PROFILE_ID);
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
    const claim = async (
      handle: DatabaseInterface,
      profile: CandidateProfile,
      beforeClaim?: () => Promise<void>,
    ) => {
      const transaction = handle.transaction;
      if (!transaction) {
        throw new Error('Test database must support transactions.');
      }
      return await transaction.call(handle, async (transaction) => {
        const profileId = requiredId(profile);
        await beforeClaim?.();
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
        return profileId;
      });
    };

    let releaseClaims: (() => void) | undefined;
    const claimsReleased = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    let markBothClaimsReady: (() => void) | undefined;
    const bothClaimsReady = new Promise<void>((resolve) => {
      markBothClaimsReady = resolve;
    });
    let readyClaims = 0;
    const waitForConcurrentClaim = async () => {
      readyClaims += 1;
      if (readyClaims === 2) markBothClaimsReady?.();
      await claimsReleased;
    };
    // Two transaction callbacks from independent adapters pause at the same
    // pre-claim barrier, then submit their conditional UPDATE statements
    // together. SQLite may report a busy loser or serialize it to a false
    // predicate, but never permits two successful ownership claims.
    const contenders = [
      { database, profile: firstProfile },
      { database: contenderDatabase, profile: secondProfile },
    ];
    const outcomesPromise = Promise.allSettled(
      contenders.map(
        async ({ database, profile }) =>
          await claim(database, profile, waitForConcurrentClaim),
      ),
    );
    await bothClaimsReady;
    releaseClaims?.();
    const outcomes = await outcomesPromise;
    const successfulIndexes = outcomes.flatMap((outcome, index) =>
      outcome.status === 'fulfilled' ? [index] : [],
    );
    expect(successfulIndexes).toHaveLength(1);
    const winnerIndex = successfulIndexes[0];
    if (winnerIndex === undefined)
      throw new Error('Expected one claim winner.');
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winner = contenders[winnerIndex];
    const loser = contenders[loserIndex];
    if (!winner || !loser)
      throw new Error('Fixture contenders are unavailable.');

    let loserDatabase = loser.database;
    const loserOutcome = outcomes[loserIndex];
    if (
      loserOutcome?.status === 'rejected' &&
      isSqliteBusyError(loserOutcome.reason)
    ) {
      // libSQL keeps a failed concurrent writer reservation on its adapter.
      // A newly opened handle makes the durable-predicate retry deterministic.
      await loserDatabase.close?.();
      databases.splice(databases.indexOf(loserDatabase), 1);
      loserDatabase = await getDatabase({
        type: 'sqlite',
        url: databasePath,
        cache: false,
      });
      databases.push(loserDatabase);
    }

    const loserTransaction = loserDatabase.transaction;
    if (!loserTransaction) {
      throw new Error('Test database must support transactions.');
    }
    // The losing retry has already mutated profile state when its durable
    // predicate rejects the claim, so the transaction must roll that mutation
    // back rather than leaving an orphaned resume selection attempt.
    await expect(
      loserTransaction.call(loserDatabase, async (transaction) => {
        const transactionProfiles = await getCollection<CandidateProfile>(
          'CandidateProfile',
          { db: transaction },
        );
        const persisted = await transactionProfiles.get(
          requiredId(loser.profile),
        );
        if (!persisted) throw new Error('Fixture profile is unavailable.');
        persisted.summary = `attempt-${requiredId(loser.profile)}`;
        await persisted.save();
        const claimed = await claimResumeAssetAtomically(
          transaction,
          assetId,
          requiredId(loser.profile),
        );
        if (!claimed) {
          throw new Error(
            'Resume asset was already claimed by another profile.',
          );
        }
      }),
    ).rejects.toThrow('Resume asset was already claimed by another profile.');

    const persistedProfiles = await profiles.list({ limit: 10 });
    const winningProfile = persistedProfiles.find(
      (profile) => profile.id === winner.profile.id,
    );
    const losingProfile = persistedProfiles.find(
      (profile) => profile.id === loser.profile.id,
    );
    expect(winningProfile).toBeDefined();
    expect(losingProfile?.summary).toBe('');
    expect((await assets.get(assetId))?.candidateProfileId).toBe(
      winner.profile.id,
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
            requiredId(winner.profile),
          ),
      ),
    ).resolves.toBe(true);
  });
});
