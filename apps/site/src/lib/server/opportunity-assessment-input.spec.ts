import { describe, expect, it } from 'vitest';
import {
  buildOpportunityAssessmentPostingInput,
  opportunityAssessmentSubjectMaterialFingerprint,
  selectOpportunityAssessmentCandidateSources,
} from './opportunity-assessment-input.js';

describe('opportunity assessment input', () => {
  it('keeps the full raw posting and attributed structured requirements', () => {
    const prepared = buildOpportunityAssessmentPostingInput({
      descriptionRaw: `Remote Canada. ${'x'.repeat(25_000)}`,
      id: 'opportunity-1',
      locations: ['Canada', 'United States'],
      requiredSkills: ['TypeScript'],
      title: 'Platform engineer',
      visaOrEorPossible: 'No sponsorship',
    });
    expect(prepared.requirements).toEqual([
      {
        id: 'opportunity-1:required:0',
        text: 'TypeScript',
        postingSourceIds: ['opportunity-1:required:0'],
      },
    ]);
    expect(
      prepared.postingSources.some((source) =>
        source.id.includes('field:locations'),
      ),
    ).toBe(true);
    expect(
      prepared.postingSources.find(
        (source) => source.kind === 'posting_description',
      )?.text,
    ).toBe(`Remote Canada. ${'x'.repeat(25_000)}`);
    expect(prepared.postingCoverageTruncated).toBe(false);
  });

  it('retains every role, skill and narrative independent of keyword matching', () => {
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
    expect(selected.truncated).toBe(false);
  });

  it('preserves evidence beyond the old loader and request count caps', () => {
    const selected = selectOpportunityAssessmentCandidateSources(
      Array.from({ length: 201 }, (_, index) => ({
        id: `achievement-${index}`,
        kind: 'achievement',
        text: `Evidence ${index}`,
        title: `Evidence ${index}`,
      })),
      [{ id: 'required-role', text: 'Leadership' }],
    );
    expect(selected.sources).toHaveLength(201);
    expect(selected.truncated).toBe(false);
  });

  it('preserves every matching atomic skill without a fixed count limit', () => {
    const selected = selectOpportunityAssessmentCandidateSources(
      Array.from({ length: 40 }, (_, index) => ({
        id: `skill-${index}`,
        kind: 'skill',
        text: `TypeScript skill ${index}`,
        title: `TypeScript skill ${index}`,
      })),
      [{ id: 'required-ts', text: 'TypeScript' }],
    );
    expect(selected.sources).toHaveLength(40);
    expect(selected.truncated).toBe(false);
  });

  it('marks a summary-only posting as partial rather than inventing complete coverage', () => {
    expect(
      buildOpportunityAssessmentPostingInput({
        id: 'posting',
        descriptionSummary: 'Remote role',
      }).postingCoverageTruncated,
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
  it('includes full qualification statements beyond taxonomy skill tags', () => {
    const input = buildOpportunityAssessmentPostingInput({
      id: 'job',
      descriptionRaw: 'Complete raw posting',
      requiredSkills: ['TypeScript'],
      qualifications:
        '8+ years engineering experience; Reliability at scale\nCross-team influence and clear communication',
    });
    expect(input.requirements.map((requirement) => requirement.text)).toEqual([
      'TypeScript',
      '8+ years engineering experience',
      'Reliability at scale',
      'Cross-team influence and clear communication',
    ]);
    expect(
      input.requirements.every((requirement) =>
        input.postingSources.some(
          (source) =>
            source.id === requirement.postingSourceIds?.[0] &&
            source.text.includes(requirement.text),
        ),
      ),
    ).toBe(true);
  });
  it('includes attributed responsibilities demanded by full-role completeness', () => {
    const input = buildOpportunityAssessmentPostingInput({
      id: 'job',
      descriptionRaw: 'Own production systems, reliability and mentoring.',
      requiredSkills: ['TypeScript'],
      qualifications: '8+ years engineering experience',
      responsibilities:
        'Own production systems, reliability and scaling; Mentor engineers\nCoordinate cross-team delivery',
    });
    expect(input.requirements.map((requirement) => requirement.text)).toEqual([
      'TypeScript',
      '8+ years engineering experience',
      'Own production systems, reliability and scaling',
      'Mentor engineers',
      'Coordinate cross-team delivery',
    ]);
    for (const requirement of input.requirements.slice(2)) {
      expect(requirement.id).toContain(':responsibility:');
      expect(input.postingSources).toContainEqual({
        id: requirement.id,
        kind: 'posting_requirement',
        text: requirement.text,
        title: 'Role responsibility',
      });
      expect(requirement.postingSourceIds).toEqual([requirement.id]);
    }
    expect(input.postingCoverageTruncated).toBe(false);
  });
});
