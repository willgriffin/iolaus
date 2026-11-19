import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';
import { countOpportunityRecords } from './admin-opportunity-query.js';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import {
  assertLocalApplicationSchemaReady,
  prepareLocalApplicationSchema,
} from './local-application-schema.js';

const scoped = vi.hoisted(() => ({
  db: undefined as DatabaseInterface | undefined,
}));
vi.mock('@happyvertical/smrt-users', async (original) => ({
  ...(await original<typeof import('@happyvertical/smrt-users')>()),
  getRequestScopedDatabase: () => scoped.db,
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({ type: 'sqlite' }) }));

async function nativeFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'iolaus-local-schema-')),
  );
  const options = {
    type: 'sqlite' as const,
    url: join(root, 'application.sqlite'),
    cache: false,
    secureFile: {
      driver: 'node:sqlite' as const,
      custody: 'trusted-parent' as const,
      root,
    },
  };
  let database = await getDatabase(options);
  const seed = await createMatchingProjectionFixture('sqlite');
  try {
    for (const row of (
      await seed.database.query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
    ).rows)
      await database.query(String(row.sql));
  } finally {
    await seed.close();
  }
  return {
    database,
    async reopen() {
      await database.close();
      database = await getDatabase(options);
      return database;
    },
    async close() {
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('explicit local application schema preparation', () => {
  it('requires setup without writing, then supports an empty opportunities read and repeated preparation', async () => {
    const { database: db, close, reopen } = await nativeFixture();
    scoped.db = db;
    try {
      for (const name of [
        'posted_at',
        'first_seen_at',
        'employment_type',
        'seniority',
        'freshness',
        'required_skills',
        'preferred_skills',
      ])
        await db.query(`ALTER TABLE opportunities ADD COLUMN ${name} TEXT`);
      await db.query(
        'CREATE TABLE decisions (id TEXT PRIMARY KEY, opportunity_id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, decision TEXT, created_at TEXT, human_rating INTEGER, reason TEXT, decider_profile_id TEXT, decider_user_id TEXT)',
      );
      const query = {
        candidateSkills: [],
        currentQualified: true,
        filters: DEFAULT_OPPORTUNITY_FILTERS,
        reviewFilter: 'unsorted',
        workspaceSubject: {
          tenantId: 'synthetic',
          userId: 'owner',
          profileId: 'profile',
        },
      };
      await expect(assertLocalApplicationSchemaReady(db)).rejects.toThrow(
        'run pnpm app:setup',
      );
      await expect(countOpportunityRecords(query)).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT name FROM sqlite_master WHERE name LIKE 'matching_%'",
          )
        ).rows,
      ).toHaveLength(0);
      await prepareLocalApplicationSchema(db);
      await expect(countOpportunityRecords(query)).resolves.toBe(0);
      await db.query(
        "UPDATE matching_worker_cursor SET source_cursor = 'preserve-progress' WHERE id = 1",
      );
      await prepareLocalApplicationSchema(db);
      await expect(
        assertLocalApplicationSchemaReady(db),
      ).resolves.toBeUndefined();
      const restarted = await reopen();
      scoped.db = restarted;
      await expect(
        assertLocalApplicationSchemaReady(restarted),
      ).resolves.toBeUndefined();
      await expect(countOpportunityRecords(query)).resolves.toBe(0);
      expect(
        (
          await restarted.query(
            'SELECT source_cursor FROM matching_worker_cursor WHERE id = 1',
          )
        ).rows[0]?.source_cursor,
      ).toBe('preserve-progress');
    } finally {
      scoped.db = undefined;
      await close();
    }
  });

  it('rolls back application projection installation if native input schema is incomplete', async () => {
    const { database: db, close } = await nativeFixture();
    try {
      await db.query('DROP TABLE skill_terms');
      await expect(prepareLocalApplicationSchema(db)).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT name FROM sqlite_master WHERE name LIKE 'matching_%'",
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            "SELECT name FROM sqlite_master WHERE name = 'opportunities'",
          )
        ).rows,
      ).toHaveLength(1);
      await expect(assertLocalApplicationSchemaReady(db)).rejects.toThrow(
        'run pnpm app:setup',
      );
    } finally {
      await close();
    }
  });
});
