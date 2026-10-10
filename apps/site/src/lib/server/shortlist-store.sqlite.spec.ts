import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicOpportunity } from '$lib/public-opportunity-contract.js';
import {
  createShortlistStore,
  type ShortlistStoreError,
} from './shortlist-store.js';
import './smrt.js';
import { seedShortlistOwner } from './fixtures/shortlist-owner.js';

const subject = { tenantId: 'tenant', userId: 'user' };
const opportunity: PublicOpportunity = {
  id: 'opportunity-1',
  title: 'Role',
  normalized_title: 'role',
  company: null,
  location: { text: '', countries: [], remote: true, timezones: [] },
  seniority: 'mid',
  function: 'engineering',
  employment_type: 'full_time',
  work_mode: 'remote',
  skills: { required: [], preferred: [] },
  compensation: null,
  posted_at: null,
  updated_at: '2026-10-08T00:00:00.000Z',
  expires_at: null,
  analysis_version: 'v1',
  source_content_version: 1,
  posting_url: 'https://example.test/jobs/1',
  url: 'https://example.test/opportunities/1',
};

describe('shortlist native SQLite store', () => {
  let directory: string;
  let database: DatabaseInterface;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-shortlist-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'shortlist.sqlite'),
    });
    await seedShortlistOwner(database, subject);
    await seedShortlistOwner(database, {
      tenantId: 'other-tenant',
      userId: 'other-user',
    });
    const ddl = getDDLStrategy('sqlite');
    for (const tableName of [
      'shortlist_entries',
      'shortlist_mutation_receipts',
    ]) {
      const schema = Object.values(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      ).find((candidate) => candidate.tableName === tableName);
      if (!schema) throw new Error(`Missing ${tableName} schema.`);
      for (const statement of [
        ddl.generateCreateTable(schema),
        ...ddl.generateIndexes(schema),
        ...ddl.generateTriggers(schema),
      ])
        await database.query(statement);
    }
  });
  afterEach(async () => {
    await database?.close?.();
    await rm(directory, { force: true, recursive: true });
  });
  it('keeps an account-wide owner tuple, revision conflict, and idempotent receipt atomic', async () => {
    const store = createShortlistStore(database as never);
    const mutation = {
      mutationId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: 0,
      decision: 'saved' as const,
    };
    const first = await store.mutate(subject, mutation, opportunity);
    expect(first).toMatchObject({
      decision: 'saved',
      revision: 1,
      opportunity: { id: opportunity.id },
    });
    await expect(store.mutate(subject, mutation, opportunity)).resolves.toEqual(
      first,
    );
    await expect(
      store.mutate(
        subject,
        { ...mutation, mutationId: randomUUID(), expectedRevision: 0 },
        opportunity,
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
    } satisfies Partial<ShortlistStoreError>);
    const changed = await store.mutate(
      subject,
      {
        mutationId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: 1,
        opened: true,
      },
      null,
    );
    expect(changed).toMatchObject({
      revision: 2,
      openedAt: expect.any(String),
    });
    expect(
      await store.list({ ...subject, profileId: 'different-profile' }),
    ).toHaveLength(1);
    const other = await store.mutate(
      { tenantId: 'other-tenant', userId: 'other-user' },
      {
        mutationId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: 0,
        decision: 'saved',
      },
      opportunity,
    );
    expect(other.opportunity.id).toBe(opportunity.id);
    expect(await store.list(subject)).toHaveLength(1);
  });
  it('rolls back the entry when its receipt cannot be recorded', async () => {
    await database.query(
      `CREATE TRIGGER shortlist_receipt_reject BEFORE INSERT ON shortlist_mutation_receipts BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`,
    );
    const store = createShortlistStore(database as never);
    await expect(
      store.mutate(
        subject,
        {
          mutationId: randomUUID(),
          opportunityId: opportunity.id,
          expectedRevision: 0,
          decision: 'saved',
        },
        opportunity,
      ),
    ).rejects.toThrow('receipt failed');
    await expect(store.list(subject)).resolves.toEqual([]);
  });
  it('preserves existing account decisions and makes repeated guest merges safe', async () => {
    const store = createShortlistStore(database as never);
    const saved = await store.mutate(
      subject,
      {
        mutationId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: 0,
        decision: 'saved',
      },
      opportunity,
    );
    const guest = {
      ...saved,
      decision: 'passed' as const,
      revision: 99,
      firstSeenAt: '2020-01-01T00:00:00.000Z',
    };
    const once = await store.merge(subject, [guest]);
    const twice = await store.merge(subject, [guest]);
    expect(once.entries).toEqual([
      expect.objectContaining({ decision: 'saved', revision: 1, opportunity }),
    ]);
    expect(twice.entries).toEqual([
      expect.objectContaining({ decision: 'saved', revision: 1, opportunity }),
    ]);
    expect(once.acknowledgedIds).toEqual([opportunity.id]);
  });
});
