import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * A single-use confirmation token minted by a data-surface preview.
 *
 * The preview phase resolves a selection and shows the operator exactly what
 * would change; the apply phase must prove it is applying *that* result. The
 * token binds the whole decision -- the acting principal, the surface
 * identity, the action and its arguments, the query the selection was
 * resolved from, and the rows that resolution produced -- so an apply whose
 * filters, arguments, or matched rows have drifted since the preview is
 * refused rather than silently applied to a different set.
 *
 * Rows are never exposed through the generated API, CLI, or MCP surfaces:
 * possession of a token is the authority it confers, so it must not be
 * readable or forgeable through a generic collection endpoint.
 */
@smrt({
  tableName: 'data_surface_preview_tokens',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class DataSurfacePreviewToken extends SmrtObject {
  @field({ type: 'text', unique: true })
  token = '';
  @field({ type: 'datetime' })
  expiresAt = new Date();
  @field({ type: 'text' })
  actorUserId = '';
  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;
  @field({ type: 'text', nullable: true })
  onBehalfOfUserId: string | null = null;
  @field({ type: 'text', nullable: true })
  actsAsProfileId: string | null = null;
  @field({ type: 'text', nullable: true })
  agentClass: string | null = null;
  @field({ type: 'text' })
  identityKey = '';
  @field({ type: 'text' })
  actionId = '';
  @field({ type: 'text' })
  actionFingerprint = '';
  @field({ type: 'integer' })
  revision = 0;
  @field({ type: 'text' })
  queryFingerprint = '';
  @field({ type: 'text' })
  selectionFingerprint = '';
  @field({ type: 'text' })
  resolvedRowsFingerprint = '';
  @field({ type: 'text' })
  requestFingerprint = '';
  /**
   * The idempotency key that consumed this token, or empty while unconsumed.
   * Single-use is enforced by a conditional UPDATE on this column, so a replay
   * of the *same* key is admitted and a different key is refused.
   */
  @field({ type: 'text' })
  consumedBy = '';
}
