import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** Private publication identity. It is never a generated data-surface resource. */
@smrt({
  tableName: 'public_profile_identities',
  // One identity is permanently bound to a deployment user. The tenant is
  // retained as its immutable binding and is checked by the native store.
  conflictColumns: ['owner_user_id'],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
export class PublicProfileIdentity extends SmrtObject {
  @field({ type: 'text', required: true }) tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true, unique: true }) handle = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text', nullable: true }) currentRevisionId: string | null =
    null;
  @field({ type: 'integer' }) revision = 0;
  @field({ type: 'datetime', nullable: true }) publishedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true }) deletedAt: Date | null = null;
}
