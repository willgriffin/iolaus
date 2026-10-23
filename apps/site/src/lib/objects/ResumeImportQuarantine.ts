import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** Durable original-PDF tombstone. Scalar ownership deliberately has no FK:
 * account deletion and successful physical purge must never erase this identity.
 */
@smrt({
  tableName: 'resume_import_quarantines',
  conflictColumns: ['storage_identity', 'object_key'],
  indexes: [
    {
      name: 'resume_import_quarantine_due',
      columns: ['purgeAfter', 'purgedAt'],
    },
  ],
  sensitive: true,
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class ResumeImportQuarantine extends SmrtObject {
  @field({ type: 'text' }) storageIdentity = '';
  @field({ type: 'text' }) objectKey = '';
  @field({ type: 'text' }) tenantId = '';
  @field({ type: 'text' }) userId = '';
  @field({ type: 'text' }) profileId = '';
  @field({ type: 'text' }) assetId = '';
  @field({ type: 'text' }) itemId = '';
  @field({ type: 'text' }) deletionId = '';
  @field({ type: 'text' }) contentHash = '';
  @field({ type: 'integer' }) byteLength = 0;
  /** Durable scheduling turn; failures and unknown writers must not starve later rows. */
  @field({ type: 'integer', default: 0 }) purgeAttempts = 0;
  @field({ type: 'datetime' }) revokedAt = new Date(0);
  @field({ type: 'datetime' }) purgeAfter = new Date(0);
  @field({ type: 'datetime', nullable: true }) purgedAt: Date | null = null;
}

/** Explicit operator authority and destination audit; never a user surface. */
@smrt({
  tableName: 'resume_import_recovery_audits',
  sensitive: true,
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class ResumeImportRecoveryAudit extends SmrtObject {
  @field({ type: 'text' }) quarantineId = '';
  @field({ type: 'text' }) tenantId = '';
  @field({ type: 'text' }) actorId = '';
  @field({ type: 'text' }) destinationAuthority = '';
  @field({ type: 'text' }) reason = '';
  @field({ type: 'text' }) outcome = 'authorized';
}
