import { beforeEach, describe, expect, it } from 'vitest';
import {
  candidateFactState,
  isCandidateResumeAssetSelectable,
  saveCandidateOnboarding,
} from './candidate-onboarding.js';

const subject = {
  tenantId: 'tenant-1',
  userId: 'user-1',
};

type Row = Record<string, unknown> & { id: string; save: () => Promise<void> };

function collection(rows: Row[]) {
  return {
    create: async (values: Record<string, unknown>) => {
      const row: Row = {
        ...values,
        id: String(values.id ?? `row-${rows.length + 1}`),
        save: async () => undefined,
      };
      rows.push(row);
      return row;
    },
    get: async (id: string) => rows.find((row) => row.id === id) ?? null,
    list: async (options: Record<string, unknown> = {}) => {
      const where = options.where as Record<string, unknown> | undefined;
      return rows.filter(
        (row) =>
          !where ||
          Object.entries(where).every(([key, value]) => row[key] === value),
      );
    },
  };
}

describe('candidateFactState', () => {
  it('keeps user-verified, safe-derived, and unresolved facts distinct', () => {
    const state = candidateFactState({
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    expect(state.facts.firstName).toEqual({
      provenance: 'user_verified',
      value: 'Ada',
    });
    expect(state.facts.name).toEqual({
      provenance: 'safe_derivation',
      value: 'Ada Lovelace',
    });
    expect(state.unresolvedQuestions).toEqual(
      expect.arrayContaining([
        'Email address',
        'Phone number',
        'Current location',
      ]),
    );
  });
});

describe('isCandidateResumeAssetSelectable', () => {
  it('hides resume metadata owned by another candidate profile', () => {
    expect(
      isCandidateResumeAssetSelectable(
        { assetType: 'resume', candidateProfileId: '' },
        'profile-1',
      ),
    ).toBe(true);
    expect(
      isCandidateResumeAssetSelectable(
        { assetType: 'resume', candidateProfileId: 'profile-1' },
        'profile-1',
      ),
    ).toBe(true);
    expect(
      isCandidateResumeAssetSelectable(
        { assetType: 'resume', candidateProfileId: 'profile-2' },
        'profile-1',
      ),
    ).toBe(false);
  });
});

describe('saveCandidateOnboarding', () => {
  let profileRows: Row[];
  let answerRows: Row[];
  let assetRows: Row[];

  beforeEach(() => {
    profileRows = [];
    answerRows = [];
    assetRows = [
      {
        assetType: 'resume',
        candidateProfileId: '',
        id: 'resume-1',
        ownerUserId: subject.userId,
        save: async () => undefined,
        tenantId: subject.tenantId,
      },
    ];
  });

  function collections() {
    return {
      candidateAnswers: collection(answerRows),
      candidateProfiles: collection(profileRows),
      resumeAssets: collection(assetRows),
    };
  }

  it('persists private profile context, only explicitly reusable answers, and a selected resume', async () => {
    const result = await saveCandidateOnboarding(
      {
        demographics: { disability: 'Prefer not to say' },
        email: 'ada@example.invalid',
        firstName: 'Ada',
        lastName: 'Lovelace',
        preferences: {
          workModes: ['remote'],
          targetCompensation: '180000 CAD',
        },
        reusableAnswers: [
          {
            label: 'Work authorization',
            saveForReuse: true,
            value: 'Authorized to work in Canada',
          },
          {
            label: 'Why this role?',
            saveForReuse: false,
            value: 'Not copied without consent',
          },
        ],
        resumeAssetId: 'resume-1',
        saveVoluntaryDemographics: true,
      },
      subject,
      collections(),
    );

    expect(result.selectedResumeAssetId).toBe('resume-1');
    expect(profileRows).toHaveLength(1);
    expect(JSON.parse(String(profileRows[0].factsJson))).toMatchObject({
      facts: { name: { provenance: 'safe_derivation', value: 'Ada Lovelace' } },
    });
    expect(JSON.parse(String(profileRows[0].demographicsJson))).toEqual({
      disability: 'Prefer not to say',
    });
    expect(JSON.parse(String(profileRows[0].preferencesJson))).toEqual({
      targetCompensation: '180000 CAD',
      workModes: ['remote'],
    });
    expect(answerRows).toEqual([
      expect.objectContaining({
        active: true,
        label: 'Work authorization',
        provenance: 'explicit_reusable_answer',
      }),
    ]);
    expect(assetRows[0].candidateProfileId).toBe(profileRows[0].id);
    expect(profileRows[0]).toMatchObject({
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
    });
  });

  it('uses the generated profile identity for a first-run profile', async () => {
    await saveCandidateOnboarding({ firstName: 'Ada' }, subject, collections());
    expect(profileRows[0]?.id).toBeTruthy();
  });

  it('does not store voluntary demographics without explicit consent and is restart-idempotent', async () => {
    await saveCandidateOnboarding(
      { demographics: { race: 'Example' }, firstName: 'Ada' },
      subject,
      collections(),
    );
    await saveCandidateOnboarding(
      { email: 'ada@example.invalid', firstName: 'Ada', lastName: 'Lovelace' },
      { ...subject, profileId: profileRows[0].id },
      collections(),
    );

    expect(profileRows).toHaveLength(1);
    expect(profileRows[0].email).toBe('ada@example.invalid');
    expect(profileRows[0].demographicsJson).toBe('{}');
    expect(answerRows).toHaveLength(0);
  });

  it('does not persist profile changes for an unavailable resume selection', async () => {
    await expect(
      saveCandidateOnboarding(
        { email: 'ada@example.invalid', resumeAssetId: 'missing-resume' },
        subject,
        collections(),
      ),
    ).rejects.toThrow('Select an existing resume asset');

    expect(profileRows).toEqual([]);
  });

  it('does not persist profile changes for a resume owned by another profile', async () => {
    assetRows[0].candidateProfileId = 'other-profile';

    await expect(
      saveCandidateOnboarding(
        { email: 'ada@example.invalid', resumeAssetId: 'resume-1' },
        subject,
        collections(),
      ),
    ).rejects.toThrow('belongs to another profile');

    expect(profileRows).toEqual([]);
    expect(assetRows[0].candidateProfileId).toBe('other-profile');
  });

  it('rejects malformed subjects before querying or writing shared rows', async () => {
    await expect(
      saveCandidateOnboarding(
        { firstName: 'Ada' },
        { ...subject, tenantId: '  ' },
        collections(),
      ),
    ).rejects.toThrow('tenant ID');
    expect(profileRows).toEqual([]);
  });

  it('isolates profile and reusable answers across user and tenant subjects', async () => {
    await saveCandidateOnboarding(
      {
        firstName: 'Ada',
        reusableAnswers: [
          { label: 'Work authorization', saveForReuse: true, value: 'Canada' },
        ],
      },
      subject,
      collections(),
    );
    await saveCandidateOnboarding(
      {
        firstName: 'Grace',
        reusableAnswers: [
          { label: 'Work authorization', saveForReuse: true, value: 'US' },
        ],
      },
      { tenantId: 'tenant-2', userId: 'user-2' },
      collections(),
    );
    expect(profileRows).toHaveLength(2);
    expect(answerRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          value: 'Canada',
        }),
        expect.objectContaining({
          ownerUserId: 'user-2',
          tenantId: 'tenant-2',
          value: 'US',
        }),
      ]),
    );
  });
});
