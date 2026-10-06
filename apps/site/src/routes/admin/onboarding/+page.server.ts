import { type Actions, fail } from '@sveltejs/kit';
import {
  isCandidateResumeAssetSelectable,
  revokeCandidateOnboardingReusableAnswer,
  saveCandidateOnboarding,
} from '$lib/server/candidate-onboarding.js';
import { onboardingInput } from '$lib/server/candidate-onboarding-form.js';
import {
  mergeCandidateOnboardingResumeAssets,
  projectCandidateOnboardingAnswer,
  projectCandidateOnboardingProfile,
} from '$lib/server/candidate-onboarding-profile.js';
import { candidateWorkEligibilityFromProfile } from '$lib/server/candidate-work-eligibility.js';
import { onboardingCountryOptions } from '$lib/server/country-reference.js';
import { getCollection } from '$lib/server/smrt.js';
import { workspaceSubjectFromLocals } from '$lib/server/workspace-subject.js';
import type { PageServerLoad } from './$types';

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function recordValue(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

export const load: PageServerLoad = async ({ locals }) => {
  const subject = workspaceSubjectFromLocals(locals);
  const [profiles, answers, assets] = await Promise.all([
    getCollection('CandidateProfile'),
    getCollection('CandidateAnswer'),
    getCollection('ResumeAsset'),
  ]);
  const [profileRows, answerRows, assetRows] = await Promise.all([
    profiles.list({
      limit: 1,
      orderBy: 'updated_at DESC',
      where: subject.profileId
        ? {
            id: subject.profileId,
            ownerUserId: subject.userId,
            tenantId: subject.tenantId,
          }
        : {
            ownerUserId: subject.userId,
            profileKey: 'default',
            tenantId: subject.tenantId,
          },
    }),
    subject.profileId
      ? answers.list({
          limit: 100,
          orderBy: 'updated_at DESC',
          where: {
            active: true,
            candidateProfileId: subject.profileId,
            ownerUserId: subject.userId,
            tenantId: subject.tenantId,
          },
        })
      : Promise.resolve([]),
    assets.list({
      limit: 100,
      orderBy: 'updated_at DESC',
      where: {
        assetType: 'resume',
        ownerUserId: subject.userId,
        tenantId: subject.tenantId,
      },
    }),
  ]);
  const activeProfile = profileRows[0] ? recordValue(profileRows[0]) : null;
  const activeProfileId = String(activeProfile?.id ?? '');
  const selectedResumeAssetId = String(activeProfile?.resumeAssetId ?? '');
  const selectedResumeAsset = selectedResumeAssetId
    ? (assetRows.find(
        (asset) =>
          String(recordValue(asset).id ?? '') === selectedResumeAssetId,
      ) ?? (await assets.get(selectedResumeAssetId)))
    : null;
  const ownedSelectedResumeAsset =
    selectedResumeAsset &&
    String(recordValue(selectedResumeAsset).tenantId ?? '') ===
      subject.tenantId &&
    String(recordValue(selectedResumeAsset).ownerUserId ?? '') ===
      subject.userId
      ? recordValue(selectedResumeAsset)
      : null;
  const eligibility = candidateWorkEligibilityFromProfile(activeProfile ?? {});
  return {
    countryOptions: onboardingCountryOptions([
      ...eligibility.citizenships.map(({ code }) => code),
      ...eligibility.authorizedWorkCountries.map(({ country }) => country.code),
      ...[
        eligibility.residenceCountry?.code,
        eligibility.targetWorkCountry?.code,
      ].filter((code): code is string => Boolean(code)),
    ]),
    profile: projectCandidateOnboardingProfile(activeProfile),
    reusableAnswers: answerRows.map((item) =>
      projectCandidateOnboardingAnswer(recordValue(item)),
    ),
    resumeAssets: mergeCandidateOnboardingResumeAssets(
      assetRows
        .map(recordValue)
        .filter(
          (asset) =>
            String(asset.tenantId ?? '') === subject.tenantId &&
            String(asset.ownerUserId ?? '') === subject.userId,
        ),
      ownedSelectedResumeAsset,
      activeProfileId,
      isCandidateResumeAssetSelectable,
    ).map((row) => ({
      id: String(row.id ?? ''),
      pdfBasename: String(row.pdfBasename ?? ''),
      status: String(row.status ?? ''),
      title: String(row.title ?? ''),
    })),
  };
};

export const actions: Actions = {
  revokeReusableAnswer: async ({ locals, request }) => {
    const form = await request.formData();
    try {
      const revoked = await revokeCandidateOnboardingReusableAnswer(
        stringValue(form.get('labelKey')),
        workspaceSubjectFromLocals(locals),
      );
      return { revoked };
    } catch (cause) {
      return fail(400, {
        error:
          cause instanceof Error ? cause.message : 'Unable to revoke answer.',
      });
    }
  },
  save: async ({ locals, request }) => {
    const form = await request.formData();
    try {
      const result = await saveCandidateOnboarding(
        onboardingInput(form),
        workspaceSubjectFromLocals(locals),
      );
      return {
        saved: true,
        savedForReuse: result.savedForReuse,
        selectedResumeAssetId: result.selectedResumeAssetId,
      };
    } catch (cause) {
      return fail(400, {
        error:
          cause instanceof Error ? cause.message : 'Unable to save onboarding.',
      });
    }
  },
};
