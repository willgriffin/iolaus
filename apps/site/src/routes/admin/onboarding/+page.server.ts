import { type Actions, fail } from '@sveltejs/kit';
import {
  type CandidateOnboardingInput,
  isCandidateResumeAssetSelectable,
  revokeCandidateOnboardingReusableAnswer,
  saveCandidateOnboarding,
} from '$lib/server/candidate-onboarding.js';
import {
  mergeCandidateOnboardingResumeAssets,
  projectCandidateOnboardingAnswer,
  projectCandidateOnboardingProfile,
} from '$lib/server/candidate-onboarding-profile.js';
import { getCollection } from '$lib/server/smrt.js';
import { workspaceSubjectFromLocals } from '$lib/server/workspace-subject.js';
import type { PageServerLoad } from './$types';

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function listValue(value: FormDataEntryValue | null): string[] {
  return stringValue(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function onboardingInput(form: FormData): CandidateOnboardingInput {
  const saveVoluntaryDemographics =
    form.get('saveVoluntaryDemographics') === 'on';
  const demographics = {
    disability: stringValue(form.get('demographicDisability')),
    gender: stringValue(form.get('demographicGender')),
    raceOrEthnicity: stringValue(form.get('demographicRaceOrEthnicity')),
    veteranStatus: stringValue(form.get('demographicVeteranStatus')),
  };
  return {
    authorizedWorkCountries: listValue(form.get('authorizedWorkCountries')),
    citizenshipCountries: listValue(form.get('citizenshipCountries')),
    email: stringValue(form.get('email')),
    firstName: stringValue(form.get('firstName')),
    githubUrl: stringValue(form.get('githubUrl')),
    lastName: stringValue(form.get('lastName')),
    linkedinUrl: stringValue(form.get('linkedinUrl')),
    location: stringValue(form.get('location')),
    name: stringValue(form.get('name')),
    phone: stringValue(form.get('phone')),
    preferences: {
      locations: listValue(form.get('preferredLocations')),
      targetCompensation: stringValue(form.get('targetCompensation')),
      targetRoles: listValue(form.get('targetRoles')),
      workModes: listValue(form.get('workModes')),
    },
    reusableAnswers: [
      {
        label: stringValue(form.get('reusableAnswerLabel')),
        saveForReuse: form.get('saveReusableAnswer') === 'on',
        value: stringValue(form.get('reusableAnswerValue')),
      },
    ],
    residenceCountry: stringValue(form.get('residenceCountry')),
    resumeAssetId: stringValue(form.get('resumeAssetId')),
    resumeSource:
      form.get('resumeSource') === 'upload_later'
        ? 'upload_later'
        : 'not_selected',
    saveVoluntaryDemographics,
    sponsorshipRequired:
      form.get('sponsorshipRequired') === 'yes'
        ? 'yes'
        : form.get('sponsorshipRequired') === 'no'
          ? 'no'
          : 'unknown',
    summary: stringValue(form.get('summary')),
    targetWorkCountry: stringValue(form.get('targetWorkCountry')),
    title: stringValue(form.get('title')),
    workAuthorization: stringValue(form.get('workAuthorization')),
    ...(saveVoluntaryDemographics ? { demographics } : {}),
  };
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
  return {
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
