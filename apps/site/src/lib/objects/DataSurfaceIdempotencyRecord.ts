import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * The durable reservation and outcome for one data-surface apply.
 *
 * A bulk apply is not safely retryable on its own -- a dropped response would
 * otherwise re-review or re-enqueue every row -- so each apply reserves its
 * key before doing any work and records the result against that key when it
 * finishes. A retry with the same key and the same request returns the stored
 * result instead of repeating the work; a retry with the same key and a
 * *different* request is refused, because it is a different decision wearing
 * a used key.
 *
 * Never exposed through the generated API, CLI, or MCP surfaces: the stored
 * result describes another principal's action outcome.
 */
@smrt({
  tableName: 'data_surface_idempotency',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class DataSurfaceIdempotencyRecord extends SmrtObject {
  @field({ type: 'text', unique: true })
  scopeKey = '';
  /** `reserved` while an apply holds the key; `completed` once stored. */
  @field({ type: 'text' })
  status = 'reserved';
  @field({ type: 'text' })
  requestFingerprint = '';
  /**
   * Identifies the specific attempt holding the reservation, so only that
   * attempt can complete or release it and a concurrent duplicate cannot
   * steal or clear another's in-flight work.
   */
  @field({ type: 'text' })
  ownerToken = '';
  @field({ type: 'datetime' })
  reservedAt = new Date();
  @field({ type: 'json', nullable: true })
  result: unknown = null;
}
