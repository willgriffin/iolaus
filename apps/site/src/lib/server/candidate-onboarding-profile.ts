import { reusableAnswerLabelKey } from './candidate-answers.js';

/** Project a reusable answer with the current canonical revocation key. */
export function projectCandidateOnboardingAnswer(
  record: Record<string, unknown>,
) {
  return {
    id: String(record.id ?? ''),
    label: String(record.label ?? ''),
    labelKey: reusableAnswerLabelKey(record),
    value: String(record.value ?? ''),
  };
}

/** Keep the current selectable resume visible even beyond the recent-row window. */
export function mergeCandidateOnboardingResumeAssets(
  recent: Record<string, unknown>[],
  current: Record<string, unknown> | null,
  candidateProfileId: string,
  isSelectable: (
    asset: Record<string, unknown>,
    candidateProfileId?: string,
  ) => boolean,
) {
  const seen = new Set<string>();
  return [...(current ? [current] : []), ...recent].filter((asset) => {
    const id = String(asset.id ?? '');
    if (!id || seen.has(id) || !isSelectable(asset, candidateProfileId)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

/** Project private profile values into the authenticated owner-only form. */
export function projectCandidateOnboardingProfile(
  record: Record<string, unknown> | null,
) {
  if (!record) return null;
  let demographics: Record<string, string> = {};
  try {
    const parsed = JSON.parse(String(record.demographicsJson ?? '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      demographics = Object.fromEntries(
        Object.entries(parsed)
          .filter((entry): entry is [string, string] =>
            entry.every((value) => typeof value === 'string'),
          )
          .map(([key, value]) => [key, value]),
      );
    }
  } catch {
    // Invalid legacy JSON is not reflected into the form.
  }
  return {
    demographics,
    demographicsConsent: Boolean(record.demographicsConsentAt),
    email: String(record.email ?? ''),
    firstName: String(record.firstName ?? ''),
    githubUrl: String(record.githubUrl ?? ''),
    lastName: String(record.lastName ?? ''),
    linkedinUrl: String(record.linkedinUrl ?? ''),
    location: String(record.location ?? ''),
    name: String(record.name ?? ''),
    phone: String(record.phone ?? ''),
    preferencesJson: String(record.preferencesJson ?? '{}'),
    resumeAssetId: String(record.resumeAssetId ?? ''),
    resumeSource: String(record.resumeSource ?? 'not_selected'),
    summary: String(record.summary ?? ''),
    title: String(record.title ?? ''),
    workAuthorization: String(record.workAuthorization ?? ''),
  };
}
