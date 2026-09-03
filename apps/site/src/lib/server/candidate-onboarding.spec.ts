import { beforeEach, describe, expect, it } from 'vitest';
import {
  candidateAssetPath,
  candidateFactState,
  resolveCandidateAssetPath,
  saveCandidateOnboarding,
} from './candidate-onboarding.js';

type Row = Record<string, unknown> & { id: string; save: () => Promise<void> };

function collection(rows: Row[]) {
  return {
    create: async (values: Record<string, unknown>) => {
      const row: Row = {
        ...values,
        id: `row-${rows.length + 1}`,
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

describe('candidateAssetPath', () => {
  it('keeps assets below the selected profile directory and rejects traversal', () => {
    expect(candidateAssetPath('default', 'resume.pdf')).toBe(
      'profiles/default/assets/resume.pdf',
    );
    expect(() => candidateAssetPath('default', '../resume.pdf')).toThrow(
      /single filename/,
    );
    expect(
      resolveCandidateAssetPath('default', 'resume.pdf', '/tmp/iolaus-assets'),
    ).toBe('/tmp/iolaus-assets/profiles/default/assets/resume.pdf');
  });
});

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
        save: async () => undefined,
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
  });

  it('does not store voluntary demographics without explicit consent and is restart-idempotent', async () => {
    await saveCandidateOnboarding(
      { demographics: { race: 'Example' }, firstName: 'Ada' },
      collections(),
    );
    await saveCandidateOnboarding(
      { email: 'ada@example.invalid', firstName: 'Ada', lastName: 'Lovelace' },
      collections(),
    );

    expect(profileRows).toHaveLength(1);
    expect(profileRows[0].email).toBe('ada@example.invalid');
    expect(profileRows[0].demographicsJson).toBe('{}');
    expect(answerRows).toHaveLength(0);
  });
});
