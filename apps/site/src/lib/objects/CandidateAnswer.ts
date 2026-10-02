import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

// The private reusable candidate answer library. Rows are explicit
// user-approved answers ("save for reuse") that seed future ATS applications.
// Deliberately excluded from the generated API/CLI/MCP surfaces: answers can
// contain personal contact facts and must only move through the application
// workflow's own audited writers.
@smrt({
  tableName: 'candidate_answers',
  // A reusable answer belongs to one candidate profile and one canonical
  // question label. Do not use the default slug/context key: different labels
  // such as "C++" and "C#" can share a generated slug, and profiles must not
  // overwrite one another's answers.
  conflictColumns: [
    'tenant_id',
    'owner_user_id',
    'candidate_profile_id',
    'label_key',
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class CandidateAnswer extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text' })
  ownerUserId = '';
  @field({ type: 'text' })
  candidateProfileId = '';
  @field({ type: 'text' })
  profileKey = 'default';
  /** The question label exactly as supplied when the answer was saved. */
  @field({ type: 'text', sensitive: true })
  label = '';
  /** Normalized label (see normalizeAnswerLabel) used for conservative matching. */
  @field({ type: 'text', sensitive: true })
  labelKey = '';
  @field({ type: 'text', sensitive: true })
  value = '';
  /** Explicit consent is required before an answer enters this library. */
  @field({ type: 'text' })
  provenance = 'explicit_reusable_answer';
  @field({ type: 'boolean' })
  active = true;
  @field({ type: 'datetime', nullable: true, sensitive: true })
  savedForReuseAt: Date | null = null;
  @field({ type: 'datetime', nullable: true, sensitive: true })
  revokedForReuseAt: Date | null = null;
}
