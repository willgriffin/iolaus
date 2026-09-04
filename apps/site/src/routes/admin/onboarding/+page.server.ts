import { type Actions, fail } from '@sveltejs/kit';
import { revokeReusableAnswerByLabelKey } from '$lib/server/application-workflow.js';
import {
  type CandidateOnboardingInput,
  isCandidateResumeAssetSelectable,
  saveCandidateOnboarding,
} from '$lib/server/candidate-onboarding.js';
import { getCollection } from '$lib/server/smrt.js';
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
    resumeAssetId: stringValue(form.get('resumeAssetId')),
    resumeSource:
      form.get('resumeSource') === 'upload_later'
        ? 'upload_later'
        : 'not_selected',
    saveVoluntaryDemographics,
    summary: stringValue(form.get('summary')),
    title: stringValue(form.get('title')),
    workAuthorization: stringValue(form.get('workAuthorization')),
    ...(saveVoluntaryDemographics ? { demographics } : {}),
  };
}

function publicProfile(record: Record<string, unknown> | null) {
  if (!record) return null;
  return {
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

function recordValue(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

export const load: PageServerLoad = async () => {
  const [profiles, answers, assets] = await Promise.all([
    getCollection('CandidateProfile'),
    getCollection('CandidateAnswer'),
    getCollection('ResumeAsset'),
  ]);
  const [profileRows, answerRows, assetRows] = await Promise.all([
    profiles.list({
      limit: 1,
      orderBy: 'updated_at DESC',
      where: { profileKey: 'default' },
    }),
    answers.list({
      limit: 100,
      orderBy: 'updated_at DESC',
      where: { active: true, profileKey: 'default' },
    }),
    assets.list({
      limit: 100,
      orderBy: 'updated_at DESC',
      where: { assetType: 'resume' },
    }),
  ]);
  const activeProfileId = String(profileRows[0]?.id ?? '');
  return {
    profile: publicProfile(profileRows[0] ? recordValue(profileRows[0]) : null),
    reusableAnswers: answerRows.map((item) => {
      const row = recordValue(item);
      return {
        id: String(row.id ?? ''),
        label: String(row.label ?? ''),
        labelKey: String(row.labelKey ?? ''),
        value: String(row.value ?? ''),
      };
    }),
    resumeAssets: assetRows
      .map(recordValue)
      .filter((row) => isCandidateResumeAssetSelectable(row, activeProfileId))
      .map((row) => ({
        id: String(row.id ?? ''),
        pdfBasename: String(row.pdfBasename ?? ''),
        status: String(row.status ?? ''),
        title: String(row.title ?? ''),
      })),
  };
};

export const actions: Actions = {
  revokeReusableAnswer: async ({ request }) => {
    const form = await request.formData();
    try {
      const revoked = await revokeReusableAnswerByLabelKey(
        stringValue(form.get('labelKey')),
      );
      return { revoked };
    } catch (cause) {
      return fail(400, {
        error:
          cause instanceof Error ? cause.message : 'Unable to revoke answer.',
      });
    }
  },
  save: async ({ request }) => {
    const form = await request.formData();
    try {
      const result = await saveCandidateOnboarding(onboardingInput(form));
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
