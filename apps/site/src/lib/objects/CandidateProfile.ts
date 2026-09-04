import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'candidate_profiles',
  // Iolaus is a single-owner application. The canonical onboarding profile is
  // a singleton even when two first-save requests race.
  conflictColumns: ['profile_key'],
  // Profile fields are private candidate context. The authenticated onboarding
  // and application services access them directly; broad generated APIs, CLI,
  // MCP, and WebMCP must not expose even a partial profile record.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class CandidateProfile extends SmrtObject {
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
  @field({ type: 'text', sensitive: true })
  summary = '';
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
