import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicOpportunity } from '$lib/public-opportunity-contract.js';
import { createShortlistStore } from './shortlist-store.js';
import './smrt.js';

const url = process.env.SHORTLIST_POSTGRES_TEST_DATABASE_URL?.trim();
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
function quote(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

describe.runIf(url)('shortlist native PostgreSQL store', () => {
  let control: DatabaseInterface;
  let database: DatabaseInterface;
  let schema: string;
  beforeAll(async () => {
    if (!url?.includes('/shortlist_store_test'))
      throw new Error(
        'Shortlist PostgreSQL proof requires the dedicated shortlist_store_test database.',
      );
    schema = `hv_shortlist_${randomUUID().replaceAll('-', '')}`;
    control = await getDatabase({ cache: false, type: 'postgres', url });
    await control.query(`CREATE SCHEMA ${quote(schema)}`);
    const fixtureUrl = new URL(url);
    fixtureUrl.searchParams.set('options', `-c search_path=${schema},public`);
    database = await getDatabase({
      cache: false,
      type: 'postgres',
      url: fixtureUrl.toString(),
    });
    const ddl = getDDLStrategy('postgres');
    for (const tableName of [
      'shortlist_entries',
      'shortlist_mutation_receipts',
    ]) {
      const definition = Object.values(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      ).find((candidate) => candidate.tableName === tableName);
      if (!definition) throw new Error(`Missing ${tableName} schema.`);
      for (const statement of [
        ddl.generateCreateTable(definition),
        ...ddl.generateIndexes(definition),
        ...ddl.generateTriggers(definition),
      ])
        await database.query(statement);
    }
  }, 20_000);
  afterAll(async () => {
    await database?.close?.();
    if (control && schema)
      await control.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await control?.close?.();
  });
  it('serializes an account mutation and returns its receipt on retry', async () => {
    const store = createShortlistStore(database as never);
    const mutation = {
      mutationId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: 0,
      decision: 'later' as const,
    };
    const subject = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
    };
    const first = await store.mutate(subject, mutation, opportunity);
    expect(
      await store.mutate(
        { ...subject, profileId: 'any' },
        mutation,
        opportunity,
      ),
    ).toEqual(first);
    await expect(
      store.mutate(
        subject,
        {
          mutationId: randomUUID(),
          opportunityId: opportunity.id,
          expectedRevision: 0,
          opened: true,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    const updated = await store.mutate(
      subject,
      {
        mutationId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: 1,
        opened: true,
      },
      null,
    );
    expect(updated.revision).toBe(2);
    const other = await store.mutate(
      {
        tenantId: '33333333-3333-4333-8333-333333333333',
        userId: '44444444-4444-4444-844444444444',
      },
      {
        mutationId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: 0,
        decision: 'saved',
      },
      opportunity,
    );
    expect(other.revision).toBe(1);
    const merged = await store.merge(subject, [
      { ...updated, decision: 'passed', revision: 77 },
    ]);
    expect(merged.entries).toEqual([updated]);
    expect(
      (
        await store.merge(subject, [
          { ...updated, decision: 'passed', revision: 77 },
        ])
      ).entries,
    ).toEqual([updated]);
  });
  it('rolls back an entry when a PostgreSQL receipt trigger rejects it', async () => {
    await database.query(
      `CREATE FUNCTION shortlist_receipt_reject() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'receipt failed'; END; $$ LANGUAGE plpgsql`,
    );
    await database.query(
      `CREATE TRIGGER shortlist_receipt_reject BEFORE INSERT ON shortlist_mutation_receipts FOR EACH ROW EXECUTE FUNCTION shortlist_receipt_reject()`,
    );
    const store = createShortlistStore(database as never);
    const subject = {
      tenantId: '55555555-5555-4555-8555-555555555555',
      userId: '66666666-6666-4666-8666-666666666666',
    };
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
});
