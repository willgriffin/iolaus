import { describe, expect, it } from 'vitest';
import {
  fingerprintOpportunitySourceContent,
  opportunityWithSourceContent,
} from './opportunity-source-content';

describe('opportunity source content fingerprints', () => {
  it('ignores harmless case and whitespace differences', () => {
    expect(
      fingerprintOpportunitySourceContent({
        canonicalUrl: 'https://example.com/jobs/1',
        descriptionRaw: 'Build   platform systems.\n',
        title: 'Staff Engineer',
      }),
    ).toBe(
      fingerprintOpportunitySourceContent({
        canonicalUrl: 'HTTPS://EXAMPLE.COM/JOBS/1',
        descriptionRaw: ' build platform systems. ',
        title: 'staff engineer',
      }),
    );
  });

  it('changes when the posting content changes materially', () => {
    const baseline = fingerprintOpportunitySourceContent({
      canonicalUrl: 'https://example.com/jobs/1',
      descriptionRaw: 'Build platform systems.',
      title: 'Staff Engineer',
    });
    const changed = fingerprintOpportunitySourceContent({
      canonicalUrl: 'https://example.com/jobs/1',
      descriptionRaw: 'Build platform and agent systems.',
      title: 'Staff Engineer',
    });

    expect(changed).not.toBe(baseline);
  });

  it('changes for structured compensation and work-mode updates', () => {
    const baseline = fingerprintOpportunitySourceContent({
      descriptionRaw: 'Build platform systems.',
      employmentType: 'full_time',
      salaryMax: 180_000,
      salaryMin: 150_000,
      title: 'Staff Engineer',
      workMode: 'remote',
    });

    expect(
      fingerprintOpportunitySourceContent({
        descriptionRaw: 'Build platform systems.',
        employmentType: 'contract',
        salaryMax: 200_000,
        salaryMin: 170_000,
        title: 'Staff Engineer',
        workMode: 'hybrid',
      }),
    ).not.toBe(baseline);
  });

  it('keeps identity and volatile URL parameters outside the content hash', () => {
    const content = {
      descriptionRaw: 'Build platform systems.',
      externalId: 'job-1',
      title: 'Staff Engineer',
    };

    expect(
      fingerprintOpportunitySourceContent({
        ...content,
        canonicalUrl:
          'https://example.com/jobs/1?utm_source=board&signature=first',
      }),
    ).toBe(
      fingerprintOpportunitySourceContent({
        ...content,
        canonicalUrl:
          'https://example.com/jobs/1?signature=second&utm_source=email',
      }),
    );
  });

  it('overlays canonical source fields without replacing derived intelligence', () => {
    expect(
      opportunityWithSourceContent({
        descriptionSummary: 'Derived summary',
        requiredSkills: 'Stale extracted skill',
        salaryMin: 100_000,
        sourceContentJson: JSON.stringify({
          requiredSkills: 'TypeScript',
          salaryMin: 160_000,
        }),
      }),
    ).toMatchObject({
      descriptionSummary: 'Derived summary',
      requiredSkills: 'TypeScript',
      salaryMin: 160_000,
    });
  });

  it('preserves a non-enumerable opportunity id when source content is overlaid', () => {
    const opportunity = Object.defineProperty(
      {
        sourceContentJson: JSON.stringify({
          descriptionRaw: 'Build platform systems.',
        }),
      },
      'id',
      { enumerable: false, value: 'opportunity-1' },
    );

    expect(opportunityWithSourceContent(opportunity)).toMatchObject({
      descriptionRaw: 'Build platform systems.',
      id: 'opportunity-1',
    });
  });
});
