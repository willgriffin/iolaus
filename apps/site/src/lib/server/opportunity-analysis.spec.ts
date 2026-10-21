import { describe, expect, it, vi } from 'vitest';

vi.mock('./opportunity-analysis-enrichment.js', () => ({
  enrichOpportunityAnalysis: vi.fn(),
}));

import {
  type OpportunityAnalysisEnrichment,
  validateOpportunityAnalysisEnrichment,
} from './opportunity-analysis.js';

const description = 'TypeScript is required. Remote work available.';
const valid = (): OpportunityAnalysisEnrichment => ({
  skills: [
    {
      slug: 'typescript',
      label: 'TypeScript',
      kind: 'required',
      confidence: 1,
      evidence: [{ start: 0, end: 10, quote: 'TypeScript' }],
    },
  ],
  requirements: [
    {
      hash: 'untrusted-model-hash',
      text: 'TypeScript is required.',
      kind: 'must',
      category: 'skill',
      skills: ['typescript'],
      evidence: [{ start: 0, end: 23 }],
    },
  ],
  summaryBullets: ['TypeScript is required.'],
  eligibility: {
    remote: true,
    countries: [],
    regions: [],
    timezones: [],
    flags: 0,
    workAuthorization: { required: [], sponsorship: 'unknown' },
  },
});
describe('analysis evidence boundary', () => {
  it('accepts exact grounded fields and recomputes semantic requirement identity', () => {
    expect(
      validateOpportunityAnalysisEnrichment(valid(), description)
        .requirements[0].hash,
    ).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects bad offsets, quotes and unsupported aliases', () => {
    const value = valid();
    value.skills[0].evidence[0].end = 999;
    expect(() =>
      validateOpportunityAnalysisEnrichment(value, description),
    ).toThrow();
    value.skills[0].evidence = [{ start: 0, end: 10, quote: 'JavaScript' }];
    expect(() =>
      validateOpportunityAnalysisEnrichment(value, description),
    ).toThrow();
  });
  it('rejects a fabricated requirement, summary and eligibility claim', () => {
    const value = valid();
    value.requirements[0].text = 'JavaScript is required.';
    expect(() =>
      validateOpportunityAnalysisEnrichment(value, description),
    ).toThrow();
    const summary = valid();
    summary.summaryBullets = ['Excellent compensation.'];
    expect(() =>
      validateOpportunityAnalysisEnrichment(summary, description),
    ).toThrow();
    const location = valid();
    location.eligibility.countries = ['Canada'];
    expect(() =>
      validateOpportunityAnalysisEnrichment(location, description),
    ).toThrow();
  });
  it('rejects contact PII and unknown enum values', () => {
    const value = valid();
    value.skills[0].label = 'jobs@example.com';
    expect(() =>
      validateOpportunityAnalysisEnrichment(value, description),
    ).toThrow();
    expect(() =>
      validateOpportunityAnalysisEnrichment(
        {
          ...valid(),
          requirements: [{ ...valid().requirements[0], kind: 'unknown' }],
        } as never,
        description,
      ),
    ).toThrow();
  });
});
