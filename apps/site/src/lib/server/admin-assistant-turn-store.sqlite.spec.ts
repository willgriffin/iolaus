import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AdminAssistantTurnReservation,
  createAdminAssistantTurnStore,
} from './admin-assistant-turn-store.js';

describe('admin assistant turn store on SQLite', () => {
  let database: DatabaseInterface;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-assistant-turn-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'assistant-turns.sqlite'),
    });
    await database.query(`
      CREATE TABLE admin_assistant_turns (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        candidate_profile_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        user_message_id TEXT,
        assistant_message_id TEXT,
        request_id TEXT NOT NULL,
        provider_request_id TEXT,
        profile TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        estimated_input_tokens INTEGER NOT NULL,
        max_output_tokens INTEGER NOT NULL,
        reserved_spend_micros INTEGER NOT NULL,
        actual_input_tokens INTEGER NOT NULL DEFAULT 0,
        actual_output_tokens INTEGER NOT NULL DEFAULT 0,
        actual_total_tokens INTEGER NOT NULL DEFAULT 0,
        actual_spend_micros INTEGER NOT NULL DEFAULT 0,
        accounting_basis TEXT NOT NULL,
        error_code TEXT NOT NULL,
        started_at TIMESTAMP,
        finished_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (tenant_id, owner_user_id, candidate_profile_id, thread_id, client_request_id)
      )
    `);
  });

  afterEach(async () => {
    await database.close?.();
    await rm(directory, { force: true, recursive: true });
  });

  function reservation(
    overrides: Partial<AdminAssistantTurnReservation> = {},
  ): AdminAssistantTurnReservation {
    return {
      agentSessionId: 'session-1',
      clientRequestId: 'request-1',
      contentHash: 'content-a',
      estimatedInputTokens: 100,
      maxOutputTokens: 128,
      model: 'openai/test',
      profile: 'admin-assistant',
      profileId: 'profile-1',
      requestId: 'provider-request-1',
      reservedSpendMicros: 60,
      sessionSpendLimitMicros: 100,
      tenantId: 'tenant-1',
      threadId: 'thread-1',
      turnSpendLimitMicros: 80,
      userId: 'user-1',
      ...overrides,
    };
  }

  it('keeps an identical retry in progress, rejects altered content, and never re-reserves it', async () => {
    const store = createAdminAssistantTurnStore(database as never);
    const first = await store.reserve(reservation());
    expect(first.kind).toBe('owner');

    await expect(store.reserve(reservation())).resolves.toMatchObject({
      kind: 'in_progress',
    });
    await expect(
      store.reserve(reservation({ contentHash: 'different-content' })),
    ).resolves.toEqual({ kind: 'conflict' });

    const rows = await database.query(
      'SELECT COUNT(*) AS count FROM admin_assistant_turns',
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });

  it('settles exactly the owner turn and replays it without a second provider reservation', async () => {
    const store = createAdminAssistantTurnStore(database as never);
    const input = reservation();
    const result = await store.reserve(input);
    if (result.kind !== 'owner') throw new Error('Expected owner reservation.');

    await store.markRunning(input, result.turn.id, 'user-message-1');
    await store.complete(input, result.turn.id, {
      accountingBasis: 'actual',
      actualInputTokens: 30,
      actualOutputTokens: 10,
      actualSpendMicros: 25,
      assistantMessageId: 'assistant-message-1',
      providerRequestId: 'provider-request-1',
    });

    await expect(store.reserve(input)).resolves.toMatchObject({
      kind: 'completed',
      turn: {
        actualSpendMicros: 25,
        assistantMessageId: 'assistant-message-1',
        userMessageId: 'user-message-1',
      },
    });
  });

  it('serializes different request IDs in one session before enforcing its aggregate spending ceiling', async () => {
    const store = createAdminAssistantTurnStore(database as never);
    const firstInput = reservation();
    const first = await store.reserve(firstInput);
    if (first.kind !== 'owner') throw new Error('Expected owner reservation.');
    await store.markRunning(firstInput, first.turn.id, 'user-message-1');
    await store.complete(firstInput, first.turn.id, {
      accountingBasis: 'actual',
      actualInputTokens: 10,
      actualOutputTokens: 10,
      actualSpendMicros: 50,
      assistantMessageId: 'assistant-message-1',
      providerRequestId: 'provider-request-1',
    });

    await expect(
      store.reserve(
        reservation({
          clientRequestId: 'request-2',
          contentHash: 'content-b',
          requestId: 'provider-request-2',
          reservedSpendMicros: 60,
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'blocked',
      turn: { errorCode: 'session_spend_limit' },
    });
  });

  it('records a pre-provider transcript failure without consuming the model budget', async () => {
    const store = createAdminAssistantTurnStore(database as never);
    const firstInput = reservation();
    const first = await store.reserve(firstInput);
    if (first.kind !== 'owner') throw new Error('Expected owner reservation.');
    await store.fail(firstInput, first.turn.id, 'chat_write_failed', {
      accountingBasis: 'actual',
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualSpendMicros: 0,
    });

    await expect(
      store.reserve(
        reservation({
          clientRequestId: 'request-2',
          contentHash: 'content-b',
          requestId: 'provider-request-2',
        }),
      ),
    ).resolves.toMatchObject({ kind: 'owner' });
  });
});
