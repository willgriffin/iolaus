import { createHash, randomUUID } from 'node:crypto';
import { detectEngine, type resolveDatabase } from '@happyvertical/smrt-core';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

type TurnStatus = 'blocked' | 'completed' | 'failed' | 'reserved' | 'running';

export type AdminAssistantTurnIdentity = Pick<
  CandidateWorkspaceSubject,
  'profileId' | 'tenantId' | 'userId'
> & {
  agentSessionId: string;
  clientRequestId: string;
  contentHash: string;
  threadId: string;
};

export type AdminAssistantTurnReservation = AdminAssistantTurnIdentity & {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  model: string;
  profile: string;
  requestId: string;
  reservedSpendMicros: number;
  sessionSpendLimitMicros: number;
  turnSpendLimitMicros: number;
};

export type StoredAdminAssistantTurn = AdminAssistantTurnIdentity & {
  accountingBasis: string;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualSpendMicros: number;
  assistantMessageId: string | null;
  errorCode: string;
  id: string;
  providerRequestId: string | null;
  requestId: string;
  reservedSpendMicros: number;
  status: TurnStatus;
  userMessageId: string | null;
};

export type AdminAssistantTurnReserveResult =
  | { kind: 'owner'; turn: StoredAdminAssistantTurn }
  | { kind: 'completed'; turn: StoredAdminAssistantTurn }
  | { kind: 'in_progress'; turn: StoredAdminAssistantTurn }
  | { kind: 'blocked'; turn: StoredAdminAssistantTurn }
  | { kind: 'failed'; turn: StoredAdminAssistantTurn }
  | { kind: 'conflict' };

export class AdminAssistantTurnStoreError extends Error {
  constructor(
    readonly code:
      | 'content_conflict'
      | 'missing_transaction'
      | 'reservation_exceeds_turn_limit'
      | 'session_spend_limit',
    message: string,
  ) {
    super(message);
    this.name = 'AdminAssistantTurnStoreError';
  }
}

type SqlRow = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function nullableText(value: unknown): string | null {
  const result = text(value).trim();
  return result || null;
}

function integer(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(result) ? result : 0;
}

function status(value: unknown): TurnStatus {
  return value === 'blocked' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'running'
    ? value
    : 'reserved';
}

function turnFromRow(row: SqlRow): StoredAdminAssistantTurn {
  return {
    accountingBasis: text(row.accountingBasis),
    actualInputTokens: integer(row.actualInputTokens),
    actualOutputTokens: integer(row.actualOutputTokens),
    actualSpendMicros: integer(row.actualSpendMicros),
    agentSessionId: text(row.agentSessionId),
    assistantMessageId: nullableText(row.assistantMessageId),
    clientRequestId: text(row.clientRequestId),
    contentHash: text(row.contentHash),
    errorCode: text(row.errorCode),
    id: text(row.id),
    profileId: text(row.candidateProfileId),
    providerRequestId: nullableText(row.providerRequestId),
    requestId: text(row.requestId),
    reservedSpendMicros: integer(row.reservedSpendMicros),
    status: status(row.status),
    tenantId: text(row.tenantId),
    threadId: text(row.threadId),
    userId: text(row.ownerUserId),
    userMessageId: nullableText(row.userMessageId),
  };
}

const TURN_COLUMNS = `
  id,
  tenant_id AS "tenantId",
  owner_user_id AS "ownerUserId",
  candidate_profile_id AS "candidateProfileId",
  thread_id AS "threadId",
  client_request_id AS "clientRequestId",
  content_hash AS "contentHash",
  agent_session_id AS "agentSessionId",
  status,
  user_message_id AS "userMessageId",
  assistant_message_id AS "assistantMessageId",
  request_id AS "requestId",
  provider_request_id AS "providerRequestId",
  reserved_spend_micros AS "reservedSpendMicros",
  actual_input_tokens AS "actualInputTokens",
  actual_output_tokens AS "actualOutputTokens",
  actual_spend_micros AS "actualSpendMicros",
  accounting_basis AS "accountingBasis",
  error_code AS "errorCode"
`;

function tupleParameters(identity: AdminAssistantTurnIdentity): string[] {
  return [
    identity.tenantId,
    identity.userId,
    identity.profileId,
    identity.threadId,
    identity.clientRequestId,
  ];
}

/**
 * Reserve every turn in one assistant session under a common lock. A request
 * key alone would make idempotency safe, but two different request IDs could
 * otherwise both observe the same pre-reservation session budget.
 */
function sessionLockKey(identity: AdminAssistantTurnIdentity): string {
  return createHash('sha256')
    .update(
      [
        identity.tenantId,
        identity.userId,
        identity.profileId,
        identity.agentSessionId,
      ].join('\u0000'),
    )
    .digest('hex');
}

function isSqlite(db: SmrtDatabase): boolean {
  return Boolean(db.url && detectEngine(db.url) === 'sqlite');
}

function rowForTerminalResult(
  row: StoredAdminAssistantTurn,
): AdminAssistantTurnReserveResult {
  if (row.status === 'completed') return { kind: 'completed', turn: row };
  if (row.status === 'blocked') return { kind: 'blocked', turn: row };
  if (row.status === 'failed') return { kind: 'failed', turn: row };
  return { kind: 'in_progress', turn: row };
}

export function createAdminAssistantTurnStore(database: SmrtDatabase) {
  if (typeof database.transaction !== 'function') {
    throw new AdminAssistantTurnStoreError(
      'missing_transaction',
      'Administrative assistant turns require transactional database support.',
    );
  }

  const withWriteLock = async <T>(
    identity: AdminAssistantTurnIdentity,
    work: (transaction: SmrtDatabase) => Promise<T>,
  ): Promise<T> => {
    const run = async () =>
      await database.transaction!(async (transaction) => {
        if (!isSqlite(database)) {
          await transaction.query("SET LOCAL lock_timeout = '15s'");
          await transaction.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
            `admin-assistant-session:${sessionLockKey(identity)}`,
          ]);
        }
        return await work(transaction);
      });
    return isSqlite(database)
      ? await withSqliteOperationLock(
          `admin-assistant-session:${sessionLockKey(identity)}`,
          run,
        )
      : await run();
  };

  const lookup = async (
    db: SmrtDatabase,
    identity: AdminAssistantTurnIdentity,
  ): Promise<StoredAdminAssistantTurn | null> => {
    const result = await db.query(
      `SELECT ${TURN_COLUMNS}
       FROM admin_assistant_turns
       WHERE tenant_id = ?
         AND owner_user_id = ?
         AND candidate_profile_id = ?
         AND thread_id = ?
         AND client_request_id = ?
       LIMIT 1`,
      tupleParameters(identity),
    );
    return result.rows[0] ? turnFromRow(result.rows[0] as SqlRow) : null;
  };

  return {
    async reserve(
      reservation: AdminAssistantTurnReservation,
    ): Promise<AdminAssistantTurnReserveResult> {
      if (reservation.reservedSpendMicros > reservation.turnSpendLimitMicros) {
        throw new AdminAssistantTurnStoreError(
          'reservation_exceeds_turn_limit',
          'The assistant turn exceeds its configured per-turn spend limit.',
        );
      }
      return await withWriteLock(reservation, async (transaction) => {
        const existing = await lookup(transaction, reservation);
        if (existing) {
          if (
            existing.contentHash !== reservation.contentHash ||
            existing.agentSessionId !== reservation.agentSessionId
          ) {
            return { kind: 'conflict' };
          }
          return rowForTerminalResult(existing);
        }

        const spend = await transaction.query(
          `SELECT COALESCE(SUM(
             CASE WHEN status IN ('completed', 'failed') THEN actual_spend_micros
                  WHEN status IN ('reserved', 'running') THEN reserved_spend_micros
                  ELSE 0 END
           ), 0) AS "spentMicros"
           FROM admin_assistant_turns
           WHERE tenant_id = ?
             AND owner_user_id = ?
             AND candidate_profile_id = ?
             AND agent_session_id = ?`,
          [
            reservation.tenantId,
            reservation.userId,
            reservation.profileId,
            reservation.agentSessionId,
          ],
        );
        const spentMicros = integer(spend.rows[0]?.spentMicros);
        const blocked =
          spentMicros + reservation.reservedSpendMicros >
          reservation.sessionSpendLimitMicros;
        const id = randomUUID();
        await transaction.query(
          `INSERT INTO admin_assistant_turns (
             id, slug, context, tenant_id, owner_user_id, candidate_profile_id, thread_id,
             client_request_id, content_hash, agent_session_id, status,
             request_id, profile, model, provider,
             estimated_input_tokens, max_output_tokens, reserved_spend_micros,
             accounting_basis, error_code, created_at, updated_at
           ) VALUES (?, ?, 'admin-assistant-turn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bifrost', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            id,
            reservation.requestId,
            reservation.tenantId,
            reservation.userId,
            reservation.profileId,
            reservation.threadId,
            reservation.clientRequestId,
            reservation.contentHash,
            reservation.agentSessionId,
            blocked ? 'blocked' : 'reserved',
            reservation.requestId,
            reservation.profile,
            reservation.model,
            reservation.estimatedInputTokens,
            reservation.maxOutputTokens,
            reservation.reservedSpendMicros,
            blocked ? 'session_limit' : 'reserved',
            blocked ? 'session_spend_limit' : '',
          ],
        );
        const turn = await lookup(transaction, reservation);
        if (!turn)
          throw new Error('Assistant turn reservation was not persisted.');
        return blocked ? { kind: 'blocked', turn } : { kind: 'owner', turn };
      });
    },

    async markRunning(
      identity: AdminAssistantTurnIdentity,
      turnId: string,
      userMessageId: string,
    ): Promise<void> {
      await withWriteLock(identity, async (transaction) => {
        const result = await transaction.query(
          `UPDATE admin_assistant_turns
           SET status = 'running', user_message_id = ?, started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?
             AND thread_id = ? AND client_request_id = ? AND content_hash = ?
             AND status = 'reserved'`,
          [
            userMessageId,
            turnId,
            ...tupleParameters(identity),
            identity.contentHash,
          ],
        );
        if (integer(result.rowCount) !== 1) {
          throw new Error(
            'Assistant turn lost its reservation before provider execution.',
          );
        }
      });
    },

    async complete(
      identity: AdminAssistantTurnIdentity,
      turnId: string,
      values: {
        accountingBasis: 'actual' | 'conservative';
        actualInputTokens: number;
        actualOutputTokens: number;
        actualSpendMicros: number;
        assistantMessageId: string;
        providerRequestId: string;
      },
    ): Promise<void> {
      await withWriteLock(identity, async (transaction) => {
        const result = await transaction.query(
          `UPDATE admin_assistant_turns
           SET status = 'completed', assistant_message_id = ?, provider_request_id = ?,
             actual_input_tokens = ?, actual_output_tokens = ?,
             actual_total_tokens = ?, actual_spend_micros = ?, accounting_basis = ?,
             error_code = '', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?
             AND thread_id = ? AND client_request_id = ? AND content_hash = ?
             AND status = 'running'`,
          [
            values.assistantMessageId,
            values.providerRequestId,
            values.actualInputTokens,
            values.actualOutputTokens,
            values.actualInputTokens + values.actualOutputTokens,
            values.actualSpendMicros,
            values.accountingBasis,
            turnId,
            ...tupleParameters(identity),
            identity.contentHash,
          ],
        );
        if (integer(result.rowCount) !== 1) {
          throw new Error(
            'Assistant turn could not be completed from its running state.',
          );
        }
      });
    },

    async fail(
      identity: AdminAssistantTurnIdentity,
      turnId: string,
      errorCode: string,
      values: {
        accountingBasis: 'actual' | 'conservative';
        actualInputTokens: number;
        actualOutputTokens: number;
        actualSpendMicros: number;
        providerRequestId?: string;
      },
    ): Promise<void> {
      await withWriteLock(identity, async (transaction) => {
        await transaction.query(
          `UPDATE admin_assistant_turns
           SET status = 'failed', provider_request_id = ?, actual_input_tokens = ?,
             actual_output_tokens = ?, actual_total_tokens = ?, actual_spend_micros = ?,
             accounting_basis = ?, error_code = ?, finished_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?
             AND thread_id = ? AND client_request_id = ? AND content_hash = ?
             AND status IN ('reserved', 'running')`,
          [
            values.providerRequestId ?? null,
            values.actualInputTokens,
            values.actualOutputTokens,
            values.actualInputTokens + values.actualOutputTokens,
            values.actualSpendMicros,
            values.accountingBasis,
            errorCode.slice(0, 120),
            turnId,
            ...tupleParameters(identity),
            identity.contentHash,
          ],
        );
      });
    },
  };
}

export type AdminAssistantTurnStore = ReturnType<
  typeof createAdminAssistantTurnStore
>;
