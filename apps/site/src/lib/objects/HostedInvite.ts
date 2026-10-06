import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * One operator-issued invitation to a shared hosted installation.
 *
 * The normalized (trimmed, lower-cased) email is the admission key. Revoking
 * stamps `revokedAt` instead of deleting the row so the operator keeps an
 * audit trail and a re-invite is an explicit, visible reinstatement.
 *
 * Rows are never exposed through the generated API, CLI, or MCP surfaces:
 * admission is operator-managed through `invite:*` scripts only.
 */
@smrt({
  tableName: 'hosted_invites',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class HostedInvite extends SmrtObject {
  @field({ type: 'text', unique: true })
  email = '';
  @field({ type: 'datetime', nullable: true })
  revokedAt: Date | null = null;
}
