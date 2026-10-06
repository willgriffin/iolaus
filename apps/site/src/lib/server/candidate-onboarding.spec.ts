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
  it.each([
    false,
    true,
  ])('preserves server-confirmed skills and exact private depth on an unrelated profile save (basic=%s)', async (basic) => {
    const confirmed = {
      id: 'discovery-ts',
      label: 'TypeScript',
      classification: 'direct',
      provenance: 'user_verified',
      discoveryRequestId: 'receipt-ts',
      evidence: [
        {
          id: 'project-ts',
          title: 'Shipped project',
          text: 'Exact TypeScript project fact.',
        },
      ],
    };
    const introductory = {
      ...confirmed,
      id: 'discovery-python',
      label: 'Python',
      classification: 'introductory',
      discoveryRequestId: 'receipt-python',
    };
    const skillExperience = {
      value:
        '  TypeScript AND Node.js are equal primary; Java/Python only dabbled.  ',
      provenance: 'user_verified',
    };
    profileRows.push({
      id: 'profile-private',
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
      profileKey: 'default',
      save: async () => undefined,
      factsJson: JSON.stringify({
        version: 1,
        facts: { confirmedSkills: [confirmed, introductory], skillExperience },
      }),
    });
    await saveCandidateOnboarding(
      {
        email: 'updated@example.invalid',
        ...(basic
          ? {
              basicWorkEligibility: {
                citizenshipCountryCodes: [],
                citizenshipWorkAuthorization: 'unknown',
                canWorkElsewhere: 'unknown',
                otherAuthorizedCountryCodes: [],
                workModeChoice: 'unknown',
              },
            }
          : {}),
        ...({
          confirmedSkills: [{ ...confirmed, label: 'Forged Java proficiency' }],
          skillExperience: {
            value: 'Expert Java',
            provenance: 'user_verified',
          },
          factsJson: 'forged',
        } as unknown as Record<string, never>),
      },
      { ...subject, profileId: 'profile-private' },
      collections(),
    );
    const stored = JSON.parse(String(profileRows[0].factsJson)).facts;
    expect(stored.confirmedSkills).toEqual([confirmed, introductory]);
    expect(stored.skillExperience).toEqual(skillExperience);
    expect(profileRows[0].email).toBe('updated@example.invalid');
  });
  it.each([
    'not-json',
    JSON.stringify({
      version: 1,
      facts: {
        confirmedSkills: [
          {
            label: 'Java',
            classification: 'direct',
            provenance: 'user_verified',
          },
        ],
        skillExperience: { value: 'Expert Java', provenance: 'model_inferred' },
      },
    }),
    JSON.stringify({
      version: 2,
      facts: {
        skillExperience: { value: 'Expert Java', provenance: 'user_verified' },
      },
    }),
  ])('does not promote malformed or unverified legacy skill facts on profile save', async (raw) => {
    profileRows.push({
      id: 'profile-private',
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
      profileKey: 'default',
      save: async () => undefined,
      factsJson: raw,
    });
    await saveCandidateOnboarding(
      { email: 'updated@example.invalid' },
      { ...subject, profileId: 'profile-private' },
      collections(),
    );
    const stored = JSON.parse(String(profileRows[0].factsJson)).facts;
    expect(stored.confirmedSkills).toBeUndefined();
    expect(stored.skillExperience).toBeUndefined();
  });

  it('basic Save preserves omitted advanced data, scoped rights, preferences, and original fact provenance', async () => {
    const rights = [
      { country: { code: 'CA', label: 'Canada' }, scope: 'country' },
      {
        country: { code: 'US', label: 'United States' },
        scope: 'conditional',
        condition: 'Renew permit',
      },
    ];
    profileRows.push({
      id: 'profile-basic',
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
      profileKey: 'default',
      save: async () => undefined,
      authorizedWorkCountriesJson: JSON.stringify(rights),
      residenceCountryJson: JSON.stringify({ code: 'DE', label: 'Germany' }),
      targetWorkCountryJson: JSON.stringify({ code: 'CA', label: 'Canada' }),
      sponsorshipRequired: false,
      preferencesJson: JSON.stringify({
        workModes: ['hybrid'],
        savedSearch: 'keep',
      }),
      workAuthorization: 'Existing explicit rights',
      factsJson: JSON.stringify({
        version: 1,
        facts: {
          targetWorkCountryJson: {
            provenance: 'user_verified',
            value: 'original target',
          },
          workAuthorization: {
            provenance: 'user_verified',
            value: 'Existing explicit rights',
          },
        },
        unresolvedQuestions: [],
      }),
    });
    await saveCandidateOnboarding(
      {
        basicWorkEligibility: {
          citizenshipCountryCodes: ['CA'],
          citizenshipWorkAuthorization: 'unknown',
          canWorkElsewhere: 'unknown',
          otherAuthorizedCountryCodes: [],
          workModeChoice: 'unknown',
        },
      },
      { ...subject, profileId: 'profile-basic' },
      collections(),
    );
    expect(profileRows[0]).toMatchObject({
      residenceCountryJson: JSON.stringify({ code: 'DE', label: 'Germany' }),
      targetWorkCountryJson: JSON.stringify({ code: 'CA', label: 'Canada' }),
      authorizedWorkCountriesJson: JSON.stringify(rights),
      sponsorshipRequired: false,
      workAuthorization: 'Existing explicit rights',
    });
    expect(JSON.parse(String(profileRows[0].preferencesJson))).toMatchObject({
      citizenshipWorkAuthorization: 'unknown',
      canWorkElsewhere: 'unknown',
      savedSearch: 'keep',
      workModes: ['hybrid'],
    });
    expect(
      JSON.parse(String(profileRows[0].factsJson)).facts.targetWorkCountryJson,
    ).toEqual({ provenance: 'user_verified', value: 'original target' });
  });

  it('explicit basic Yes saves country-scoped rights and a user-confirmed work authorization fact', async () => {
    await saveCandidateOnboarding(
      {
        basicWorkEligibility: {
          citizenshipCountryCodes: ['CA'],
          citizenshipWorkAuthorization: 'yes',
          canWorkElsewhere: 'no',
          otherAuthorizedCountryCodes: [],
          workModeChoice: 'remote',
        },
        sponsorshipRequired: 'no',
      },
      subject,
      collections(),
    );
    expect(
      JSON.parse(String(profileRows[0].authorizedWorkCountriesJson)),
    ).toEqual([{ country: { code: 'CA', label: 'Canada' }, scope: 'country' }]);
    expect(
      JSON.parse(String(profileRows[0].factsJson)).facts.workAuthorization,
    ).toMatchObject({
      provenance: 'user_verified',
      value: expect.stringContaining('(CA): yes'),
    });
    expect(
      JSON.parse(String(profileRows[0].preferencesJson)).workModes,
    ).toEqual(['remote']);
    expect(profileRows[0].residenceCountryJson).toBe('{}');
  });

  it('a contradictory basic No fails before the existing profile is changed', async () => {
    const rights = JSON.stringify([
      { country: { code: 'CA', label: 'Canada' }, scope: 'country' },
    ]);
    profileRows.push({
      id: 'profile-basic',
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
      profileKey: 'default',
      authorizedWorkCountriesJson: rights,
      email: 'before@example.invalid',
      save: async () => undefined,
    });
    await expect(
      saveCandidateOnboarding(
        {
          email: 'after@example.invalid',
          basicWorkEligibility: {
            citizenshipCountryCodes: ['CA'],
            citizenshipWorkAuthorization: 'no',
            canWorkElsewhere: 'unknown',
            otherAuthorizedCountryCodes: [],
            workModeChoice: 'any',
          },
        },
        { ...subject, profileId: 'profile-basic' },
        collections(),
      ),
    ).rejects.toThrow('No conflicts with saved');
    expect(profileRows[0].email).toBe('before@example.invalid');
    expect(profileRows[0].authorizedWorkCountriesJson).toBe(rights);
  });

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
