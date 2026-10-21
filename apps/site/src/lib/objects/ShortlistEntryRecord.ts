import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Durable private snapshot for a candidate's public-job shortlist. */
@smrt({
  tableName: 'shortlist_entries',
  conflictColumns: ['tenant_id', 'owner_user_id', 'opportunity_id'],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
@TenantScoped()
export class ShortlistEntryRecord extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  opportunityId = '';
  @field({ type: 'json', sensitive: true })
  opportunitySnapshot: unknown = null;
  @field({ type: 'text' })
  decision = 'seen';
  @field({ type: 'datetime' })
  firstSeenAt = new Date();
  @field({ type: 'datetime', nullable: true })
  openedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  appliedAt: Date | null = null;
  @field({ type: 'integer' })
  revision = 1;
}
