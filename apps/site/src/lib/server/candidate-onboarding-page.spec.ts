import { describe, expect, it } from 'vitest';
import {
  mergeCandidateOnboardingResumeAssets,
  projectCandidateOnboardingAnswer,
  projectCandidateOnboardingProfile,
} from './candidate-onboarding-profile.js';

describe('projectCandidateOnboardingProfile', () => {
  it('round-trips a saved display name, demographics, and consent into the owner form', () => {
    expect(
      projectCandidateOnboardingProfile({
        demographicsConsentAt: new Date('2026-01-01T00:00:00Z'),
        demographicsJson: JSON.stringify({
          disability: 'Example disability answer',
          gender: 'Example gender answer',
          raceOrEthnicity: 'Example race answer',
          veteranStatus: 'Example veteran answer',
        }),
        name: 'Existing Display Name',
      }),
    ).toMatchObject({
      demographics: {
        disability: 'Example disability answer',
        gender: 'Example gender answer',
        raceOrEthnicity: 'Example race answer',
        veteranStatus: 'Example veteran answer',
      },
      demographicsConsent: true,
      name: 'Existing Display Name',
    });
  });

  it('fails closed when legacy demographic JSON is malformed', () => {
    expect(
      projectCandidateOnboardingProfile({ demographicsJson: '{bad' }),
    ).toMatchObject({ demographics: {}, demographicsConsent: false });
  });
});

describe('projectCandidateOnboardingAnswer', () => {
  it('uses the canonical label-derived key for legacy answer revocation', () => {
    expect(
      projectCandidateOnboardingAnswer({
        id: 'answer-1',
        label: 'Work Authorization?',
        labelKey: 'stale-key',
        value: 'Example answer',
      }),
    ).toMatchObject({ labelKey: 'work authorization%3f' });
  });
});

describe('mergeCandidateOnboardingResumeAssets', () => {
  it('keeps a selected owned resume outside the recent-row window', () => {
    const selectable = (asset: Record<string, unknown>, profileId?: string) =>
      asset.assetType === 'resume' &&
      (!asset.candidateProfileId || asset.candidateProfileId === profileId);
    expect(
      mergeCandidateOnboardingResumeAssets(
        [{ id: 'recent', assetType: 'resume' }],
        {
          id: 'selected',
          assetType: 'resume',
          candidateProfileId: 'profile-1',
        },
        'profile-1',
        selectable,
      ).map((asset) => asset.id),
    ).toEqual(['selected', 'recent']);
  });
});
