import { randomUUID } from 'node:crypto';
import { generateSchemaDiff, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdminAssistantTurnReservation,
  createAdminAssistantTurnStore,
} from './admin-assistant-turn-store.js';
import './smrt.js';

const postgresUrl =
  process.env.ADMIN_ASSISTANT_TURN_POSTGRES_TEST_DATABASE_URL?.trim();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function fixtureConfig(url: string, schema: string) {
  const fixtureUrl = new URL(url);
  fixtureUrl.searchParams.set('options', `-c search_path=${schema},public`);
  return {
    cache: false,
    max: 1,
    type: 'postgres' as const,
    url: fixtureUrl.toString(),
  };
}

function reservation(
  overrides: Partial<AdminAssistantTurnReservation> = {},
): AdminAssistantTurnReservation {
  return {
    agentSessionId: '11111111-1111-4111-8111-111111111111',
    clientRequestId: 'request-1',
    contentHash: 'content-a',
    estimatedInputTokens: 100,
    maxOutputTokens: 128,
    model: 'openai/test',
    profile: 'admin-assistant',
    profileId: '22222222-2222-4222-8222-222222222222',
    requestId: '33333333-3333-4333-8333-333333333333',
    reservedSpendMicros: 60,
    sessionSpendLimitMicros: 100,
    tenantId: '44444444-4444-4444-8444-444444444444',
    threadId: '55555555-5555-4555-8555-555555555555',
    turnSpendLimitMicros: 80,
    userId: '66666666-6666-4666-8666-666666666666',
    ...overrides,
  };
}

describe.runIf(postgresUrl)(
  'admin assistant turn native PostgreSQL migration',
  () => {
    let control: DatabaseInterface;
    let database: DatabaseInterface;
    let schema: string;

    beforeAll(async () => {
      if (
        !postgresUrl?.includes('iolaus_willgriffin_public_disposable_tests')
      ) {
        throw new Error(
          'Assistant PostgreSQL proof requires the dedicated disposable test database.',
        );
      }
      schema = `hv_admin_assistant_turn_${randomUUID().replaceAll('-', '')}`;
      control = await getDatabase({
        cache: false,
        max: 1,
        type: 'postgres',
        url: postgresUrl,
      });
      await control.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      database = await getDatabase(fixtureConfig(postgresUrl, schema));
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

    it('applies registered native DDL atomically and enforces exact private retry ownership', async () => {
      const schemaDefinition = Object.values(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      ).find((candidate) => candidate.tableName === 'admin_assistant_turns');
      if (!schemaDefinition) {
        throw new Error('AdminAssistantTurn was not registered.');
      }

      const diff = await generateSchemaDiff(database, {
        AdminAssistantTurn: schemaDefinition,
      });
      expect(diff.added_tables).toHaveLength(1);
      const ddl = getDDLStrategy('postgres');
      const statements = [
        ddl.generateCreateTable(schemaDefinition),
        ...ddl.generateIndexes(schemaDefinition),
        ...ddl.generateTriggers(schemaDefinition),
      ];
      const tracker = new MigrationTracker({
        db: database,
        engineHint: 'postgres',
        useConcurrentIndexes: false,
      });
      const migration = createMigrationDefinition(
        `assistant-turn-native-${randomUUID()}`,
        statements,
        [],
        { description: 'Create private assistant turn reservation state.' },
      );
      const result = await tracker.applyAll([migration], {
        atomic: true,
        postgresSafe: false,
      });
      expect(result).toEqual([expect.objectContaining({ success: true })]);

      const indexes = await database.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = current_schema() AND tablename = 'admin_assistant_turns'`,
      );
      const indexDefinitions = indexes.rows
        .map((row) => String((row as { indexdef?: unknown }).indexdef ?? ''))
        .join('\n');
      expect(indexDefinitions).toContain('UNIQUE');
      for (const column of [
        'tenant_id',
        'owner_user_id',
        'candidate_profile_id',
        'thread_id',
        'client_request_id',
      ]) {
        expect(indexDefinitions).toContain(column);
      }

      const store = createAdminAssistantTurnStore(database as never);
      const firstInput = reservation();
      await expect(store.reserve(firstInput)).resolves.toMatchObject({
        kind: 'owner',
      });
      await expect(store.reserve(firstInput)).resolves.toMatchObject({
        kind: 'in_progress',
      });
      await expect(
        store.reserve({ ...firstInput, contentHash: 'content-b' }),
      ).resolves.toEqual({ kind: 'conflict' });

      const foreignInput = reservation({
        agentSessionId: '77777777-7777-4777-8777-777777777777',
        profileId: '88888888-8888-4888-8888-888888888888',
        requestId: '99999999-9999-4999-8999-999999999999',
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      await expect(store.reserve(foreignInput)).resolves.toMatchObject({
        kind: 'owner',
      });
      const rows = await database.query(
        `SELECT owner_user_id, candidate_profile_id
         FROM admin_assistant_turns
         WHERE tenant_id = ? AND thread_id = ? AND client_request_id = ?
         ORDER BY owner_user_id`,
        [firstInput.tenantId, firstInput.threadId, firstInput.clientRequestId],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            candidate_profile_id: firstInput.profileId,
            owner_user_id: firstInput.userId,
          }),
          expect.objectContaining({
            candidate_profile_id: foreignInput.profileId,
            owner_user_id: foreignInput.userId,
          }),
        ]),
      );
    });
  },
);
