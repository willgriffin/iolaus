import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

export type AccountDeletionStatus = 'started' | 'completed';

/**
 * Non-PII audit record of one hosted account deletion.
 *
 * While a deletion is in flight the row carries the tenant and user ids it must
 * resume against, so an operator can finish a crashed run
 * (`account:deletions`, `account:delete`). The final transaction of a deletion
 * flips the row to `completed` and nulls both ids in the same commit, so a
 * completed record holds no identifier of the deleted account: only the
 * timing, who initiated it, a random pseudonym (the value its retained AI-spend
 * ledger rows were detached to) and aggregate row counts.
 *
 * Never served through generated API, CLI, or MCP surfaces.
 */
@smrt({
  tableName: 'account_deletion_records',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class AccountDeletionRecord extends SmrtObject {
  @field({ type: 'text' })
  status: AccountDeletionStatus = 'started';
  /** `self` (the user) or `operator`. */
  @field({ type: 'text' })
  initiatedBy = 'self';
  /** Present only while `status` is `started`. */
  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;
  /** Present only while `status` is `started`. */
  @field({ type: 'text', nullable: true })
  userId: string | null = null;
  /** Random id shared by the anonymized ledger rows; not derived from the user. */
  @field({ type: 'text' })
  ledgerPseudonym = '';
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  completedAt: Date | null = null;
  /** JSON object of aggregate counts only; never row content. */
  @field({ type: 'text' })
  summary = '';
}
