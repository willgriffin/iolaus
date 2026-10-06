import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAiUserSpendStore } from './ai-usage-guard.js';
import './smrt.js';

const postgresUrl =
  process.env.AI_USER_SPEND_POSTGRES_TEST_DATABASE_URL?.trim();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function fixtureConfig(url: string, schema: string) {
  const fixtureUrl = new URL(url);
  fixtureUrl.searchParams.set('options', `-c search_path=${schema},public`);
  return {
    cache: false,
    max: 12,
    type: 'postgres' as const,
    url: fixtureUrl.toString(),
  };
}

const scope = { tenantId: 'tenant-pg', userId: 'user-pg' };

describe.runIf(postgresUrl)(
  'per-user AI spend ledger on PostgreSQL (native DDL, advisory locks)',
  () => {
    let control: DatabaseInterface;
    let database: DatabaseInterface;
    let schema: string;

    beforeAll(async () => {
      if (
        !postgresUrl?.includes('iolaus_willgriffin_public_disposable_tests')
      ) {
        throw new Error(
          'AI spend PostgreSQL proof requires the dedicated disposable test database.',
        );
      }
      schema = `hv_ai_user_spend_${randomUUID().replaceAll('-', '')}`;
      control = await getDatabase({
        cache: false,
        max: 1,
        type: 'postgres',
        url: postgresUrl,
      });
      await control.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      database = await getDatabase(fixtureConfig(postgresUrl, schema));
      const ddl = getDDLStrategy('postgres');
      for (const table of ['ai_user_spend_entries', 'ai_user_budgets']) {
        const definition = Object.values(
          ObjectRegistry.getAllSchemasAsDefinitions(),
        ).find((candidate) => candidate.tableName === table);
        if (!definition) throw new Error(`${table} was not registered.`);
        for (const statement of [
          ddl.generateCreateTable(definition),
          ...ddl.generateIndexes(definition),
          ...ddl.generateTriggers(definition),
        ]) {
          await database.query(statement);
        }
      }
    });

    afterAll(async () => {
      await database?.close?.();
      if (control && schema) {
        await control.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
        );
      }
      await control?.close?.();
    });

    it('never overspends the cap under 40 parallel reservations', async () => {
      const store = createAiUserSpendStore(database as never);
      const defaults = { lifetimeCapMicros: 1_050, monthlyCapMicros: 0 };
      const results = await Promise.all(
        Array.from({ length: 40 }, () =>
          store.reserve({
            defaults,
            feature: 'race',
            micros: 100,
            period: '2026-10',
            scope,
          }),
        ),
      );
      expect(
        results.filter((result) => result.kind === 'reserved'),
      ).toHaveLength(10);
      expect(
        results.filter((result) => result.kind === 'exhausted'),
      ).toHaveLength(30);
      const snapshot = await store.snapshot(scope, defaults, '2026-10');
      expect(snapshot.lifetimeSpentMicros).toBe(1_000);
      expect(snapshot.remainingMicros).toBe(50);
    });

    it('settles, releases, overrides caps and releases stale reservations', async () => {
      const store = createAiUserSpendStore(database as never);
      const other = { tenantId: 'tenant-pg', userId: 'user-pg-2' };
      const defaults = { lifetimeCapMicros: 500, monthlyCapMicros: 300 };
      const first = await store.reserve({
        defaults,
        feature: 'x',
        micros: 250,
        period: '2026-10',
        scope: other,
      });
      if (first.kind !== 'reserved') throw new Error('expected reservation');
      expect(
        (
          await store.reserve({
            defaults,
            feature: 'x',
            micros: 100,
            period: '2026-10',
            scope: other,
          })
        ).kind,
      ).toBe('exhausted');
      await store.settle(other, first.entryId, 50, 'actual');
      await store.setBudget(other, { monthlyCapMicros: 0, note: 'beta' });
      const next = await store.reserve({
        defaults,
        feature: 'x',
        micros: 400,
        period: '2026-10',
        scope: other,
      });
      expect(next.kind).toBe('reserved');
      await store.adjust(other, -25, 'credit', '2026-10');
      await database.query(
        "UPDATE ai_user_spend_entries SET created_at = CURRENT_TIMESTAMP - INTERVAL '3 hours' WHERE owner_user_id = ?",
        [other.userId],
      );
      expect(await store.releaseStale(other, 30)).toBe(1);
      const snapshot = await store.snapshot(other, defaults, '2026-10');
      expect(snapshot.lifetimeSpentMicros).toBe(25);
      expect(snapshot.monthlyCapMicros).toBe(0);
    });
  },
);
