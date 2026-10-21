import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Idempotent response receipt; never exposed through generic private CRUD. */
@smrt({
  tableName: 'shortlist_mutation_receipts',
  conflictColumns: ['tenant_id', 'owner_user_id', 'mutation_id'],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
@TenantScoped()
export class ShortlistMutationReceipt extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true, sensitive: true })
  mutationId = '';
  @field({ type: 'text', required: true, sensitive: true })
  requestFingerprint = '';
  @field({ type: 'json', sensitive: true })
  response: unknown = null;
}
