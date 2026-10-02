import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'candidate_profile_links',
  // Profile links can identify a candidate's personal accounts. The
  // authenticated onboarding and resume services access them directly; broad
  // generated API, CLI, MCP, and WebMCP surfaces do not expose them.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class CandidateProfileLink extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text', sensitive: true })
  profileKey = 'default';
  @field({ type: 'text', sensitive: true })
  label = '';
  @field({ type: 'text', sensitive: true })
  href = '';
  @field({ type: 'decimal', sensitive: true })
  sortOrder = 0;
}
