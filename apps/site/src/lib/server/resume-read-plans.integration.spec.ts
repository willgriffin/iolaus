import { randomUUID } from 'node:crypto';
import {
  executeCollectionReadPlan,
  ObjectRegistry,
  resolveDatabase,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleResumeSourceFromRecords,
  type ResumeSourceRecords,
} from './resume-data.js';
import {
  LEGACY_RESUME_READ_PLAN,
  NORMALIZED_RESUME_READ_PLAN,
} from './resume-read-plans.js';
import './smrt.js';

const postgresUrl = process.env.RESUME_READ_PLAN_TEST_DATABASE_URL?.trim();

const readPlans = [
  ['normalized', NORMALIZED_RESUME_READ_PLAN],
  ['legacy', LEGACY_RESUME_READ_PLAN],
] as const;

const planClassNames = [
  ...new Set(
    readPlans.flatMap(([, plan]) =>
      Object.values(plan).map(([className]) => className),
    ),
  ),
];

function readPlanEntries() {
  return Object.fromEntries(
    readPlans.flatMap(([kind, plan]) =>
      Object.entries(plan).map(([key, [className, orderBy, readLimit]]) => [
        `${kind}:${key}`,
        { className, options: { limit: readLimit ?? 1000, orderBy } },
      ]),
    ),
  );
}

async function createFixtureDatabase(
  options: Parameters<typeof getTestDatabase>[0],
) {
  return await getTestDatabase({
    ...options,
    classes: planClassNames,
  });
}

async function assertReadPlansExecute(
  db: Awaited<ReturnType<typeof getTestDatabase>>,
) {
  await expect(
    executeCollectionReadPlan(
      {
        profileLinks: {
          className: 'CandidateProfileLink',
          options: { limit: 1000, orderBy: 'sortOrder ASC' },
        },
      },
      { collectionOptions: { db }, maxConcurrency: 1 },
    ),
  ).rejects.toMatchObject({
    code: 'INVALID_ORDER_BY_SENSITIVE',
    name: 'QueryOrderByError',
  });

  await expect(
    executeCollectionReadPlan(readPlanEntries(), {
      collectionOptions: { db },
      maxConcurrency: 2,
    }),
  ).resolves.toBeDefined();
}

function emptyNormalizedRecords(): ResumeSourceRecords {
  return Object.fromEntries(
    Object.keys(NORMALIZED_RESUME_READ_PLAN).map((key) => [key, []]),
  ) as unknown as ResumeSourceRecords;
}

async function assertProfileLinkProjection(
  db: Awaited<ReturnType<typeof getTestDatabase>>,
) {
  const profiles = await ObjectRegistry.getCollection('CandidateProfile', {
    db,
  });
  const links = await ObjectRegistry.getCollection('CandidateProfileLink', {
    db,
  });

  await profiles.create({
    active: true,
    isDefault: true,
    name: 'Published Default',
    profileKey: 'default',
    summary: 'Default summary',
    title: 'Default title',
  });
  await profiles.create({
    active: true,
    isDefault: false,
    name: 'Published Alternate',
    profileKey: 'alternate',
    summary: 'Alternate summary',
    title: 'Alternate title',
  });
  await links.create({
    id: '00000000-0000-4000-8000-000000000003',
    href: 'https://example.invalid/default-second',
    label: 'Default second',
    profileKey: 'default',
    sortOrder: 2,
  });
  await links.create({
    id: '00000000-0000-4000-8000-000000000002',
    href: 'https://example.invalid/default-first-b',
    label: 'Default first B',
    profileKey: 'default',
    sortOrder: 1,
  });
  await links.create({
    id: '00000000-0000-4000-8000-000000000001',
    href: 'https://example.invalid/default-first-a',
    label: 'Default first A',
    profileKey: 'default',
    sortOrder: 1,
  });
  await links.create({
    href: 'https://example.invalid/alternate',
    label: 'Alternate only',
    profileKey: 'alternate',
    sortOrder: 0,
  });

  const result = await executeCollectionReadPlan(
    {
      profileLinks: {
        className: 'CandidateProfileLink',
        options: { limit: 1001, orderBy: 'id ASC' },
      },
      profiles: {
        className: 'CandidateProfile',
        options: { limit: 1000, orderBy: 'profileKey ASC' },
      },
    },
    { collectionOptions: { db }, maxConcurrency: 2 },
  );

  const profileLinks = result.profileLinks as Array<
    SmrtObject & { sortOrder: number }
  >;
  expect(profileLinks).toHaveLength(4);
  expect(profileLinks[0]?.sortOrder).toEqual(expect.any(Number));
  expect(profileLinks[0]?.toPublicJSON()).not.toMatchObject({
    href: expect.anything(),
    label: expect.anything(),
    profileKey: expect.anything(),
    sortOrder: expect.anything(),
  });

  const records = emptyNormalizedRecords();
  records.profiles = JSON.parse(JSON.stringify(result.profiles));
  records.profileLinks = JSON.parse(
    JSON.stringify(
      [...profileLinks].sort((a, b) => {
        const difference = Number(a.sortOrder) - Number(b.sortOrder);
        return difference || String(a.id).localeCompare(String(b.id));
      }),
    ),
  );

  const defaultSource = assembleResumeSourceFromRecords(records);
  expect(defaultSource?.profile.links).toEqual([
    {
      href: 'https://example.invalid/default-first-a',
      label: 'Default first A',
    },
    {
      href: 'https://example.invalid/default-first-b',
      label: 'Default first B',
    },
    { href: 'https://example.invalid/default-second', label: 'Default second' },
  ]);
  expect(defaultSource?.profile).not.toHaveProperty('profileKey');
  expect(defaultSource?.profile.links[0]).not.toHaveProperty('sortOrder');

  const alternateSource = assembleResumeSourceFromRecords(records, {
    profileKey: 'alternate',
  });
  expect(alternateSource?.profile.links).toEqual([
    { href: 'https://example.invalid/alternate', label: 'Alternate only' },
  ]);
  expect(JSON.stringify(alternateSource)).not.toContain('Default first A');
}

describe('published resume SMRT read plans (SQLite)', () => {
  it('executes every normalized and legacy ordering term through the real collection executor', async () => {
    const db = await createFixtureDatabase({ type: 'sqlite' });
    try {
      await assertReadPlansExecute(db);
      await assertProfileLinkProjection(db);
    } finally {
      await db.close?.();
    }
  });
});

describe.runIf(Boolean(postgresUrl))(
  'published resume SMRT read plans (PostgreSQL)',
  () => {
    let db: Awaited<ReturnType<typeof getTestDatabase>>;

    beforeAll(async () => {
      if (!postgresUrl)
        throw new Error('RESUME_READ_PLAN_TEST_DATABASE_URL is required.');
      const parsed = new URL(postgresUrl);
      const databaseName = parsed.pathname.replace(/^\/+/, '');
      if (
        !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ||
        !databaseName.includes('resume_read_plan_test')
      ) {
        throw new Error(
          'PostgreSQL read-plan integration requires a local resume_read_plan_test database.',
        );
      }
      const database = await resolveDatabase(
        { type: 'postgres', url: postgresUrl },
        { dbid: `resume-read-plan-${randomUUID()}` },
      );
      db = await createFixtureDatabase({ db: database, type: 'postgres' });
    });

    afterAll(async () => {
      await db?.close?.();
    });

    it('preserves the same guarded read-plan and published-link semantics', async () => {
      await assertReadPlansExecute(db);
      await assertProfileLinkProjection(db);
    });
  },
);
