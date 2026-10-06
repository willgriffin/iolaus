import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSchemaDiff, ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdminAssistantTurnStore } from './admin-assistant-turn-store.js';
import './smrt.js';

describe('admin assistant turn native SQLite schema', () => {
  let database: DatabaseInterface;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'iolaus-assistant-native-schema-'),
    );
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'assistant-native.sqlite'),
    });
  });

  afterEach(async () => {
    await database.close?.();
    await rm(directory, { force: true, recursive: true });
  });

  it('creates its hidden owner-tuple table and conflict index from the registered native model DDL', async () => {
    const schema = Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions(),
    ).find((candidate) => candidate.tableName === 'admin_assistant_turns');
    if (!schema) throw new Error('AdminAssistantTurn was not registered.');

    const schemas = { AdminAssistantTurn: schema };
    const before = await generateSchemaDiff(database, schemas);
    expect(before.added_tables).toHaveLength(1);
    const ddl = getDDLStrategy('sqlite');
    for (const statement of [
      ddl.generateCreateTable(schema),
      ...ddl.generateIndexes(schema),
      ...ddl.generateTriggers(schema),
    ]) {
      await database.query(statement);
    }

    // SQLite's generic schema differ deliberately leaves this manifest table
    // in its add bucket after direct DDL execution because the model's UUID
    // shape is normalized through the framework's migration path. Inspect the
    // actual native DDL outcome instead of accepting a hand-written stand-in.
    const persisted = await database.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ['admin_assistant_turns'],
    );
    expect(persisted.rows).toHaveLength(1);
    const table = await database.getTableSchema?.('admin_assistant_turns');
    expect(Object.keys(table?.columns ?? {})).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'owner_user_id',
        'candidate_profile_id',
        'thread_id',
        'client_request_id',
        'content_hash',
      ]),
    );

    const store = createAdminAssistantTurnStore(database as never);
    const base = {
      agentSessionId: 'session-1',
      clientRequestId: 'request-1',
      contentHash: 'content-1',
      estimatedInputTokens: 10,
      maxOutputTokens: 128,
      model: 'openai/test',
      profile: 'admin-assistant',
      profileId: 'profile-1',
      requestId: 'request-1',
      reservedSpendMicros: 10,
      sessionSpendLimitMicros: 100,
      tenantId: 'tenant-1',
      threadId: 'thread-1',
      turnSpendLimitMicros: 20,
      userId: 'user-1',
    };
    await expect(store.reserve(base)).resolves.toMatchObject({ kind: 'owner' });
    await expect(store.reserve(base)).resolves.toMatchObject({
      kind: 'in_progress',
    });
    await expect(
      store.reserve({ ...base, contentHash: 'different-content' }),
    ).resolves.toEqual({ kind: 'conflict' });
  });
});
