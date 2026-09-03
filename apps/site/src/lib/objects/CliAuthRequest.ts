import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'cli_auth_requests',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class CliAuthRequest extends SmrtObject {
  @field({ type: 'text' })
  userCode = '';
  @field({ type: 'text' })
  deviceCodeHash = '';
  @field({ type: 'text' })
  status = 'pending';
  @field({ type: 'text' })
  userId = '';
  @field({ type: 'text' })
  tenantId = '';
  @field({ type: 'text' })
  sessionId = '';
  @field({ type: 'datetime' })
  expiresAt = new Date();
  @field({ type: 'datetime', nullable: true })
  approvedAt: Date | null = null;
}
