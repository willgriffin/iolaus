import { isSharedHosted } from '../src/lib/server/app-config.js';

/**
 * Legacy bundled-resume import has no authenticated candidate subject. The
 * ownership contract now requires one in every mode, so migrations must leave
 * personal data creation to the subject-bound onboarding/import workflows.
 */
export function legacyPersonalResumeBackfillsEnabled(): boolean {
  return false;
}

/** Reject accidental direct invocation before it can read or write a private record. */
export function assertLegacyPersonalResumeBackfillsEnabled(): void {
  if (!legacyPersonalResumeBackfillsEnabled()) {
    const mode = isSharedHosted() ? 'shared hosted' : 'private';
    throw new Error(
      `Legacy personal resume backfills are unavailable in ${mode} mode because they lack a verified candidate workspace subject.`,
    );
  }
}
