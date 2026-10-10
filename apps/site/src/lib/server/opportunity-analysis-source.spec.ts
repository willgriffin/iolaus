import { describe, expect, it } from 'vitest';
import {
  deterministicOpportunityAnalysis,
  verifiedAnalysisSource,
} from './opportunity-analysis-source.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';
import { SKILL_VOCABULARY_SEED_TERMS } from './skill-vocabulary.js';

const captured = {
  title: 'Senior TypeScript Engineer',
  descriptionRaw:
    'TypeScript is required. At least 5 years of experience required.',
  requiredSkills: 'TypeScript',
  preferredSkills: '',
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
  it('indexes catalog skills stated only in the canonical description', () => {
    const output = deterministicOpportunityAnalysis(
      identity({
        ...captured,
        descriptionRaw:
          'Build TypeScript services with Node.js and PostgreSQL. Go to https://example.test/go.',
        requiredSkills: '',
        preferredSkills: '',
      }),
    );
    expect(output.skills.map((skill) => skill.slug)).toEqual([
      'typescript',
      'nodejs',
      'postgresql',
    ]);
    expect(output.skills.every((skill) => skill.kind === 'mentioned')).toBe(
      true,
    );
  });
  it('uses visible HTML text and original UTF-16 evidence spans only', () => {
    const description =
      '😀 <a data-skill="TypeScript" href="https://example.test/nodejs">Node.js</a><script>PostgreSQL</script> PostgreSQL';
    const output = deterministicOpportunityAnalysis(
      identity({ ...captured, descriptionRaw: description }),
    );
    expect(output.skills.map((skill) => skill.slug)).toEqual([
      'nodejs',
      'postgresql',
    ]);
    expect(output.skills[0]?.evidence[0]).toEqual({
      start: description.indexOf('Node.js'),
      end: description.indexOf('Node.js') + 'Node.js'.length,
      quote: 'Node.js',
    });
  });
  it('prefers explicit structured requirements while leaving plain mentions non-mandatory', () => {
    const output = deterministicOpportunityAnalysis(
      identity({
        ...captured,
        descriptionRaw: 'TypeScript and Node.js are used every day.',
        requiredSkills: 'TypeScript',
        preferredSkills: 'Node.js',
      }),
    );
    expect(output.skills.map((skill) => [skill.slug, skill.kind])).toEqual([
      ['typescript', 'required'],
      ['nodejs', 'preferred'],
    ]);
  });
  it('uses longest whole-term matches and excludes generic, negated, and URL-only aliases', () => {
    const output = deterministicOpportunityAnalysis(
      identity({
        ...captured,
        descriptionRaw:
          'TypeScript, not JavaScript, is useful. Golang experience helps. Go to https://example.test/reactjs; TypeScripter is not a skill.',
        requiredSkills: '',
      }),
    );
    expect(output.skills.map((skill) => skill.slug)).toEqual([
      'typescript',
      'go',
    ]);
    expect(output.skills.map((skill) => skill.evidence[0]?.quote)).toEqual([
      'TypeScript',
      'Golang',
    ]);
  });
  it('retains explicitly structured skills outside the catalog only with visible positive evidence', () => {
    const output = deterministicOpportunityAnalysis(
      identity({
        ...captured,
        descriptionRaw:
          '<b>WordPress VIP</b> is required. <b>TypeScript</b> is not required.',
        requiredSkills: 'WordPress VIP, TypeScript',
      }),
    );
    expect(output.skills.map((skill) => [skill.slug, skill.kind])).toEqual([
      ['wordpress-vip', 'required'],
    ]);
    expect(output.skills[0]?.evidence[0]?.quote).toBe('WordPress VIP');
  });
  it('accepts terse aliases only when explicit structured fields establish their meaning', () => {
    const output = deterministicOpportunityAnalysis(
      identity({
        ...captured,
        descriptionRaw: 'Golang, JavaScript, and TypeScript are required.',
        requiredSkills: 'Go, JS, TS',
      }),
    );
    expect(output.skills.map((skill) => [skill.slug, skill.kind])).toEqual([
      ['go', 'required'],
      ['javascript', 'required'],
      ['typescript', 'required'],
    ]);
  });
  it('bounds catalog mentions while retaining structured requirements', () => {
    const labels = SKILL_VOCABULARY_SEED_TERMS.map((term) => term.label).join(
      '. ',
    );
    const output = deterministicOpportunityAnalysis(
      identity({
        ...captured,
        descriptionRaw: `TypeScript is required. ${labels}`,
        requiredSkills: 'TypeScript',
      }),
    );
    expect(output.skills).toHaveLength(100);
    expect(output.skills[0]).toMatchObject({
      slug: 'typescript',
      kind: 'required',
    });
  });
});
