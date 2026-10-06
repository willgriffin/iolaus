import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

export type AiUserSpendEntryStatus = 'reserved' | 'settled' | 'released';

/**
 * Platform-paid AI spend attributed to one user (tenant + owner). One row is
 * inserted as a reservation before every billable provider call and settled
 * afterwards, so concurrent requests cannot jointly overspend a cap. Operator
 * credits are settled rows with a negative `actualMicros`. Never served
 * through generated API, CLI, or MCP surfaces.
 */
@smrt({
  tableName: 'ai_user_spend_entries',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
export class AiUserSpendEntry extends SmrtObject {
  @field({ type: 'text', required: true })
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  /** UTC calendar month (YYYY-MM) the reservation was made in. */
  @field({ type: 'text' })
  period = '';
  @field({ type: 'text' })
  feature = '';
  @field({ type: 'text', sensitive: true })
  requestId = '';
  @field({ type: 'text' })
  status: AiUserSpendEntryStatus = 'reserved';
  @field({ type: 'integer' })
  reservedMicros = 0;
  @field({ type: 'integer' })
  actualMicros = 0;
  @field({ type: 'text' })
  accountingBasis = '';
  @field({ type: 'datetime', nullable: true })
  settledAt: Date | null = null;
}
