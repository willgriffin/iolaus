import type {
  DataSurfaceActionStateStore,
  DataSurfaceIdempotencyRecord,
  DataSurfaceIdempotencyReservation,
  DataSurfacePreviewTokenRecord,
} from '@happyvertical/smrt-agents/server';
import { resolveDatabase } from '@happyvertical/smrt-core';
import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import { getDbConfig } from './db.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

type QueryResult =
  | { rows?: Record<string, unknown>[]; rowCount?: number }
  | Record<string, unknown>[];

/**
 * Expired tokens older than this are removed opportunistically. Keeping a
 * grace window past expiry means a just-expired apply still finds its token
 * and reports `confirmation_expired` rather than the indistinguishable
 * `confirmation_not_found`.
 */
const EXPIRED_TOKEN_GRACE_MS = 60 * 60 * 1000;
/** Bound on one sweep so a large backlog cannot stall a request. */
const EXPIRED_TOKEN_SWEEP_LIMIT = 500;

function rowsFrom(result: QueryResult): Record<string, unknown>[] {
  if (Array.isArray(result)) return result;
  return result?.rows ?? [];
}

function affectedRows(result: QueryResult): number {
  if (Array.isArray(result)) return result.length;
  if (typeof result?.rowCount === 'number') return result.rowCount;
  return result?.rows?.length ?? 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function epochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Durable, cross-process data-surface action state backed by PostgreSQL.
 *
 * Every method that must be atomic is written as a single conditional
 * statement rather than a read-modify-write through `save()`. Two reasons:
 * the guarantees here are about winning a race between concurrent replicas,
 * which only the database can arbitrate; and SMRT's own `save()` is itself a
 * compare-and-swap on `updated_at` that would raise a revision conflict on
 * exactly the contended path this store exists to serialize.
 *
 * Shaped to the `@happyvertical/smrt-agents/server` interface so it can be
 * replaced by the upstream implementation when happyvertical/smrt#2597 ships.
 */
export class SmrtDataSurfaceActionStateStore
  implements DataSurfaceActionStateStore
{
  private readonly db: SmrtDatabase;

  constructor(db: SmrtDatabase) {
    this.db = db;
  }

  static async create(
    db?: SmrtDatabase,
  ): Promise<SmrtDataSurfaceActionStateStore> {
    return new SmrtDataSurfaceActionStateStore(
      db ?? (await resolveDatabase(getDbConfig())),
    );
  }

  private async run(sql: string, values: unknown[]): Promise<QueryResult> {
    return (await this.db.query(sql, ...values)) as QueryResult;
  }

  async putToken(
    token: string,
    record: DataSurfacePreviewTokenRecord,
  ): Promise<void> {
    await this.run(
      // `slug` is SmrtObject's required business key and carries the token, so
      // the base (slug, context) uniqueness agrees with the token uniqueness
      // rather than contradicting it.
      `INSERT INTO data_surface_preview_tokens (
        id, slug, context, token, expires_at, actor_user_id, tenant_id,
        on_behalf_of_user_id, acts_as_profile_id, agent_class, identity_key,
        action_id, action_fingerprint, revision, query_fingerprint,
        selection_fingerprint, resolved_rows_fingerprint, request_fingerprint,
        consumed_by, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, 'data-surface-preview-token', $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14, $15,
        $16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT (token) DO NOTHING`,
      [
        token,
        new Date(record.expiresAt),
        record.actorUserId,
        record.tenantId,
        record.onBehalfOfUserId,
        record.actsAsProfileId,
        record.agentClass,
        record.identityKey,
        record.actionId,
        record.actionFingerprint,
        record.revision,
        record.queryFingerprint,
        record.selectionFingerprint,
        record.resolvedRowsFingerprint,
        record.requestFingerprint,
        record.consumedBy ?? '',
      ],
    );
    await this.sweepExpiredTokens();
  }

  async getToken(
    token: string,
  ): Promise<DataSurfacePreviewTokenRecord | undefined> {
    const [row] = rowsFrom(
      await this.run(
        `SELECT * FROM data_surface_preview_tokens WHERE token = $1 LIMIT 1`,
        [token],
      ),
    );
    if (!row) return undefined;
    return {
      expiresAt: epochMs(row.expires_at),
      actorUserId: text(row.actor_user_id),
      tenantId: nullableText(row.tenant_id),
      onBehalfOfUserId: nullableText(row.on_behalf_of_user_id),
      actsAsProfileId: nullableText(row.acts_as_profile_id),
      agentClass: nullableText(row.agent_class),
      identityKey: text(row.identity_key),
      actionId: text(row.action_id),
      actionFingerprint: text(row.action_fingerprint),
      revision: Number(row.revision ?? 0),
      queryFingerprint: text(row.query_fingerprint),
      selectionFingerprint: text(row.selection_fingerprint),
      resolvedRowsFingerprint: text(row.resolved_rows_fingerprint),
      requestFingerprint: text(row.request_fingerprint),
      consumedBy: text(row.consumed_by),
    };
  }

  /**
   * Claim a token for one idempotency key.
   *
   * Admitting a token already consumed by the *same* key is what makes an
   * interrupted apply retryable: the retry re-presents its confirmation and
   * still reaches the idempotency record holding the original outcome. Any
   * other key is refused, so one preview authorizes exactly one decision.
   *
   * A *first* consumption additionally requires the token to be live by the
   * database's own clock. The adapter checks expiry in process before awaiting
   * this write and does not re-check afterwards, so without the predicate a
   * token that expires during that window still authorizes the apply -- and
   * the window is not merely a round trip: the adapter may poll for a
   * contended idempotency reservation before reaching the rows. Re-asserting
   * the deadline here makes expiry a property of the write rather than of the
   * earlier read, and uses the shared clock rather than a replica's own.
   */
  async markTokenConsumed(
    token: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const result = await this.run(
      `UPDATE data_surface_preview_tokens
      SET consumed_by = $2, updated_at = CURRENT_TIMESTAMP
      WHERE token = $1
        AND (
          (consumed_by = '' AND expires_at > CURRENT_TIMESTAMP)
          OR consumed_by = $2
        )`,
      [token, idempotencyKey],
    );
    return affectedRows(result) === 1;
  }

  async getIdempotency(
    key: string,
  ): Promise<DataSurfaceIdempotencyRecord | undefined> {
    const [row] = rowsFrom(
      await this.run(
        `SELECT * FROM data_surface_idempotency WHERE scope_key = $1 LIMIT 1`,
        [key],
      ),
    );
    return row ? this.toIdempotencyRecord(row) : undefined;
  }

  /**
   * Create the reservation, or return whatever record already holds the key.
   *
   * `ON CONFLICT DO NOTHING` makes the insert the arbitration point: exactly
   * one concurrent attempt gets a row back and owns the work, and every other
   * attempt falls through to read the existing record.
   */
  async reserveIdempotency(
    key: string,
    reservation: DataSurfaceIdempotencyReservation,
  ): Promise<DataSurfaceIdempotencyRecord> {
    const inserted = rowsFrom(
      await this.run(
        `INSERT INTO data_surface_idempotency (
          id, slug, context, scope_key, status, request_fingerprint,
          owner_token, reserved_at, result, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, 'data-surface-idempotency', $1, 'reserved', $2,
          $3, $4, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT (scope_key) DO NOTHING
        RETURNING *`,
        [
          key,
          reservation.requestFingerprint,
          reservation.ownerToken,
          new Date(reservation.reservedAt),
        ],
      ),
    );
    if (inserted[0]) return this.toIdempotencyRecord(inserted[0]);

    const existing = await this.getIdempotency(key);
    if (existing) return existing;
    // The holder released the key between the conflict and the read. The
    // caller owns nothing, so report a reservation held by no one rather than
    // inventing ownership it could later use to complete another's work.
    return {
      status: 'reserved',
      requestFingerprint: reservation.requestFingerprint,
      ownerToken: '',
      reservedAt: reservation.reservedAt,
    };
  }

  async completeIdempotency(
    key: string,
    ownerToken: string,
    result: DataSurfaceActionResult,
  ): Promise<boolean> {
    const updated = await this.run(
      `UPDATE data_surface_idempotency
      SET status = 'completed', result = $3, updated_at = CURRENT_TIMESTAMP
      WHERE scope_key = $1 AND status = 'reserved' AND owner_token = $2`,
      [key, ownerToken, JSON.stringify(result)],
    );
    return affectedRows(updated) === 1;
  }

  async releaseIdempotency(key: string, ownerToken: string): Promise<boolean> {
    const deleted = await this.run(
      `DELETE FROM data_surface_idempotency
      WHERE scope_key = $1 AND status = 'reserved' AND owner_token = $2`,
      [key, ownerToken],
    );
    return affectedRows(deleted) === 1;
  }

  private toIdempotencyRecord(
    row: Record<string, unknown>,
  ): DataSurfaceIdempotencyRecord {
    const requestFingerprint = text(row.request_fingerprint);
    if (text(row.status) === 'completed') {
      const stored = row.result;
      const result = (
        typeof stored === 'string' ? JSON.parse(stored) : stored
      ) as DataSurfaceActionResult;
      return { status: 'completed', requestFingerprint, result };
    }
    return {
      status: 'reserved',
      requestFingerprint,
      ownerToken: text(row.owner_token),
      reservedAt: epochMs(row.reserved_at),
    };
  }

  /**
   * Drop long-expired tokens so the table tracks live confirmations rather
   * than growing without bound. Bounded and best-effort: a failed sweep must
   * never fail the action that triggered it.
   */
  private async sweepExpiredTokens(): Promise<void> {
    try {
      await this.run(
        `DELETE FROM data_surface_preview_tokens
        WHERE id IN (
          SELECT id FROM data_surface_preview_tokens
          WHERE expires_at < $1
          LIMIT ${EXPIRED_TOKEN_SWEEP_LIMIT}
        )`,
        [new Date(Date.now() - EXPIRED_TOKEN_GRACE_MS)],
      );
    } catch {
      // Housekeeping only.
    }
  }
}
