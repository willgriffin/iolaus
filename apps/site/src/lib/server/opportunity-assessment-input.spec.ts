import { describe, expect, it } from 'vitest';
import {
  buildOpportunityAssessmentPostingInput,
  opportunityAssessmentSubjectMaterialFingerprint,
  selectOpportunityAssessmentCandidateSources,
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

  it('keeps roles and matching skills before narrative evidence and records omitted coverage', () => {
    const sources = [
      {
        id: 'role-1',
        kind: 'employment',
        text: 'Platform engineer at Example, 2022 - 2026',
        title: 'Platform engineer',
      },
      {
        id: 'skill-ts',
        kind: 'skill',
        text: 'TypeScript',
        title: 'TypeScript',
      },
      {
        id: 'skill-k8s',
        kind: 'skill',
        text: 'Kubernetes',
        title: 'Kubernetes',
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `project-${index}`,
        kind: 'project',
        text: `Unrelated project ${index}`,
        title: `Project ${index}`,
      })),
    ];
    const selected = selectOpportunityAssessmentCandidateSources(sources, [
      { id: 'required-ts', text: 'TypeScript' },
      { id: 'required-k8s', text: 'Kubernetes' },
    ]);
    expect(selected.sources.map((source) => source.id)).toEqual(
      expect.arrayContaining(['role-1', 'skill-ts', 'skill-k8s']),
    );
    expect(selected.truncated).toBe(true);
  });

  it('records coverage loss beyond the old loader cap before request preparation', () => {
    const selected = selectOpportunityAssessmentCandidateSources(
      Array.from({ length: 201 }, (_, index) => ({
        id: `achievement-${index}`,
        kind: 'achievement',
        text: `Evidence ${index}`,
        title: `Evidence ${index}`,
      })),
      [{ id: 'required-role', text: 'Leadership' }],
    );
    expect(selected.sources).toHaveLength(30);
    expect(selected.truncated).toBe(true);
  });

  it('marks matching evidence omitted by the hard bound as incomplete', () => {
    const selected = selectOpportunityAssessmentCandidateSources(
      Array.from({ length: 40 }, (_, index) => ({
        id: `skill-${index}`,
        kind: 'skill',
        text: `TypeScript skill ${index}`,
        title: `TypeScript skill ${index}`,
      })),
      [{ id: 'required-ts', text: 'TypeScript' }],
    );
    expect(selected.sources).toHaveLength(30);
    expect(selected.truncated).toBe(true);
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
