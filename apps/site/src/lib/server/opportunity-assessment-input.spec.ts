import { describe, expect, it } from 'vitest';
import {
  buildOpportunityAssessmentPostingInput,
  opportunityAssessmentSubjectMaterialFingerprint,
} from './opportunity-assessment-input.js';

describe('opportunity assessment input', () => {
  it('keeps role clauses and bounded raw posting passages with coverage metadata input', () => {
    const prepared = buildOpportunityAssessmentPostingInput({
      descriptionRaw: `Remote Canada. ${'x'.repeat(25_000)}`,
      id: 'opportunity-1',
      locations: ['Canada', 'United States'],
      requiredSkills: ['TypeScript'],
      title: 'Platform engineer',
      visaOrEorPossible: 'No sponsorship',
    });
    expect(prepared.requirements).toEqual([
      { id: 'opportunity-1:required:0', text: 'TypeScript' },
    ]);
    expect(
      prepared.postingSources.some((source) =>
        source.id.includes('00-field:locations'),
      ),
    ).toBe(true);
    expect(
      prepared.postingSources.some((source) =>
        source.id.includes('99-coverage'),
      ),
    ).toBe(true);
  });

  it('separates identical material for two workspace subjects', () => {
    const shared = {
      candidateMaterialFingerprint: 'candidate',
      sourceContentFingerprint: 'posting',
      sourceContentVersion: 1,
    };
    expect(
      opportunityAssessmentSubjectMaterialFingerprint({
        ...shared,
        subject: {
          profileId: 'profile-a',
          tenantId: 'tenant',
          userId: 'user-a',
        },
      }),
    ).not.toBe(
      opportunityAssessmentSubjectMaterialFingerprint({
        ...shared,
        subject: {
          profileId: 'profile-b',
          tenantId: 'tenant',
          userId: 'user-b',
        },
      }),
    );
  });
});
