import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'candidate_profiles',
  // A canonical onboarding profile is unique per authenticated owner in a
  // tenant; it is never a process-wide singleton.
  conflictColumns: ['tenant_id', 'owner_user_id', 'profile_key'],
  // Profile fields are private candidate context. The generic REST, CLI and
  // MCP surfaces expose only the owner's own verified profile (never a list
  // across owners), with the agent-writable field allow-list in
  // agent-field-contract.ts; onboarding creates it and nothing deletes it.
  api: { include: ['list', 'get', 'update'] },
  cli: { include: ['list', 'get', 'update'] },
  mcp: { include: ['list', 'get', 'update'] },
})
@TenantScoped()
export class CandidateProfile extends SmrtObject {
  @tenantId()
  tenantId = '';
  /** Immutable authenticated owner, not a user-supplied profile field. */
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text' })
  profileKey = 'default';
  // The owner-facing onboarding and application workflows read them directly
  // under the authenticated session.
  @field({ type: 'text', sensitive: true })
  name = '';
  @field({ type: 'text', sensitive: true })
  firstName = '';
  @field({ type: 'text', sensitive: true })
  lastName = '';
  @field({ type: 'text', sensitive: true })
  title = '';
  @field({ type: 'text', sensitive: true })
  email = '';
  // Contact and identity facts reused to seed ATS application forms. These
  // stay private: never include them in WebMCP or other broad read surfaces.
  @field({ type: 'text', sensitive: true })
  phone = '';
  @field({ type: 'text', sensitive: true })
  location = '';
  @field({ type: 'text', sensitive: true })
  linkedinUrl = '';
  @field({ type: 'text', sensitive: true })
  githubUrl = '';
  @field({ type: 'text', sensitive: true })
  workAuthorization = '';
  /** ISO country references; citizenship never implies work authorization. */
  @field({ type: 'text', sensitive: true })
  citizenshipsJson = '[]';
  /** Current home country, not a representation of authorization. */
  @field({ type: 'text', sensitive: true })
  residenceCountryJson = '{}';
  /** Candidate-selected target country for opportunity compatibility. */
  @field({ type: 'text', sensitive: true })
  targetWorkCountryJson = '{}';
  /** Verified country authorizations with country/employer/conditional scope. */
  @field({ type: 'text', sensitive: true })
  authorizedWorkCountriesJson = '[]';
  /** True only when the candidate confirms employer sponsorship is required. */
  @field({ type: 'text', sensitive: true })
  sponsorshipRequired = 'unknown';
  @field({ type: 'text', sensitive: true })
  summary = '';
  /**
   * Owner-authored plain-text notes only the public profile assistant reads
   * (location, work authorisation, motivation, stories). Never part of the
   * public snapshot, résumé, PDF or llms.txt; see public-profile-assistant.ts.
   */
  @field({ type: 'text', sensitive: true })
  assistantNotes = '';
  /** Optional address the assistant invites visitors to email when stuck. */
  @field({ type: 'text', sensitive: true })
  assistantContactEmail = '';
  /** Excludes only the profile summary; resume identity/contact remains required. */
  @field({ type: 'boolean' })
  useOnResume = true;
  /** Structured facts retain whether a value was verified, safely derived, or unresolved. */
  @field({ type: 'text', sensitive: true })
  factsJson = '{"facts":{},"unresolvedQuestions":[],"version":1}';
  /** Search preferences are private candidate context, not agent-discovery data. */
  @field({ type: 'text', sensitive: true })
  preferencesJson = '{}';
  /** Voluntary demographic information is opt-in and never emitted publicly. */
  @field({ type: 'text', sensitive: true })
  demographicsJson = '{}';
  @field({ type: 'text', sensitive: true })
  resumeAssetId = '';
  @field({ type: 'text', sensitive: true })
  resumeSource = 'not_selected';
  @field({ type: 'datetime', nullable: true, sensitive: true })
  onboardingCompletedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true, sensitive: true })
  demographicsConsentAt: Date | null = null;
  @field({ type: 'boolean' })
  active = true;
  @field({ type: 'boolean' })
  isDefault = false;
}
