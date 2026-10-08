import { describe, expect, it } from 'vitest';
import {
  deterministicOpportunityAnalysis,
  verifiedAnalysisSource,
} from './opportunity-analysis-source.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const captured = {
  title: 'Senior TypeScript Engineer',
  descriptionRaw:
    'TypeScript is required. At least 5 years of experience required.',
  requiredSkills: 'TypeScript',
  currency: 'USD',
  hourlyMin: 100,
};
const identity = (source = captured) => ({
  id: 'test',
  sourceContentJson: JSON.stringify(source),
  sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
  sourceContentVersion: 1,
});
describe('canonical source analysis', () => {
  it('uses only verified canonical facts and retains exact evidence and hourly units', () => {
    const output = deterministicOpportunityAnalysis({
      ...identity(),
      title: 'PRIVATE TITLE',
      descriptionSummary: 'PRIVATE SUMMARY',
      requiredSkills: 'PRIVATE SKILL',
    } as ReturnType<typeof identity>);
    expect(output.normalizedTitle).toBe(captured.title);
    expect(output.summaryBullets).toEqual([]);
    expect(output.skills[0]).toMatchObject({
      slug: 'typescript',
      evidence: [{ start: 0, end: 10, quote: 'TypeScript' }],
    });
    expect(output.compensation).toMatchObject({ min: 100, period: 'hour' });
    expect(output.requirements[1]).toMatchObject({ years: 5, kind: 'must' });
  });
  it('fails closed for missing or fingerprint-mismatched source snapshots', () => {
    expect(() =>
      verifiedAnalysisSource({ ...identity(), sourceContentJson: '{}' }),
    ).toThrow();
    expect(() =>
      verifiedAnalysisSource({
        ...identity(),
        sourceContentFingerprint: 'wrong',
      }),
    ).toThrow();
  });
  it('never treats unsupported and negated skills as proficiency', () => {
    const source = {
      ...captured,
      descriptionRaw: 'TypeScript is not needed. No Python required.',
      requiredSkills: 'TypeScript,Python,Go',
    };
    expect(deterministicOpportunityAnalysis(identity(source)).skills).toEqual(
      [],
    );
  });
  it('does not publish contact data in titles or requirements', () => {
    const source = {
      ...captured,
      title: 'Contact jobs@example.com',
      descriptionRaw: 'Email jobs@example.com required.',
    };
    const output = deterministicOpportunityAnalysis(identity(source));
    expect(output.normalizedTitle).toBe('');
    expect(output.requirements).toEqual([]);
  });
  it('semantic qualifiers and negation change requirement identity', () => {
    const first = deterministicOpportunityAnalysis(identity());
    const next = deterministicOpportunityAnalysis(
      identity({
        ...captured,
        descriptionRaw: captured.descriptionRaw.replace('5 years', '6 years'),
      }),
    );
    expect(first.requirements[1].hash).not.toBe(next.requirements[1].hash);
  });
});
