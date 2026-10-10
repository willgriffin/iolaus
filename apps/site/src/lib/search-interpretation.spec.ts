import { describe, expect, it } from 'vitest';
import {
  interpretOpportunitySearch,
  validateOpportunitySearchInput,
} from './search-interpretation.js';

describe('interpretOpportunitySearch', () => {
  it('extracts catalog skills and explicit public filters while preserving the role', () => {
    const result = interpretOpportunitySearch(
      'senior remote full-time TypeScript and PostgreSQL engineer in Canada',
    );
    expect(result.originalQuery).toContain('TypeScript');
    expect(result.input).toMatchObject({
      q: 'engineer',
      skills: ['typescript', 'postgresql'],
      seniority: ['senior'],
      work_mode: ['remote'],
      employment_type: ['full_time'],
      country: ['CA'],
    });
    expect(result.chips).toEqual(
      expect.arrayContaining([
        { kind: 'skill', value: 'typescript', label: 'TypeScript' },
        { kind: 'country', value: 'CA', label: 'Canada' },
      ]),
    );
  });

  it('does not turn negated skills into positive filters', () => {
    const result = interpretOpportunitySearch(
      'backend engineer without Java or PHP',
    );
    expect(result.input.skills).toEqual([]);
    expect(result.input.q).toContain('backend');
    expect(result.input.q).not.toMatch(/java|php|without/i);
    expect(result.warnings).toContain('Skill exclusions are not applied.');
  });

  it('does not turn negated public filters into positive filters', () => {
    const result = interpretOpportunitySearch(
      'designer not remote and not in Canada',
    );
    expect(result.input).toMatchObject({
      q: 'designer',
      country: [],
      work_mode: [],
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Remote exclusions are not applied.',
        'Canada exclusions are not applied.',
      ]),
    );
  });

  it('keeps ambiguous occupation words in the role query', () => {
    expect(interpretOpportunitySearch('staff nurse').input).toMatchObject({
      q: 'staff nurse',
      seniority: [],
    });
    expect(interpretOpportunitySearch('account manager').input).toMatchObject({
      q: 'account manager',
      seniority: [],
    });
    expect(
      interpretOpportunitySearch('staff software engineer').input.seniority,
    ).toEqual(['staff']);
  });

  it('uses only explicit deterministic aliases from the catalog', () => {
    const result = interpretOpportunitySearch(
      'remote TS and Postgres developer',
    );
    expect(result.input).toMatchObject({
      q: 'developer',
      skills: ['typescript', 'postgresql'],
      work_mode: ['remote'],
    });
  });

  it('lets a skill-only request search through its editable skill filter', () => {
    const result = interpretOpportunitySearch('I want remote welding jobs');
    expect(result.input).toMatchObject({
      q: '',
      skills: ['welding'],
      work_mode: ['remote'],
    });
  });

  it('does not claim unsupported constraints are filters', () => {
    const result = interpretOpportunitySearch(
      'remote designer in Canada with $120k salary and visa sponsorship',
    );
    expect(result.input.work_mode).toEqual(['remote']);
    expect(result.input.country).toEqual(['CA']);
    expect(result.input.salary_min).toBeUndefined();
    expect(result.input.q).not.toMatch(/120|salary|visa|sponsorship/i);
    expect(result.warnings.join(' ')).toMatch(/Salary constraints need/i);
    expect(result.warnings.join(' ')).toMatch(/authorization.*not applied/i);
  });

  it('extracts an explicit public salary minimum without inferring a currency', () => {
    const result = interpretOpportunitySearch(
      'remote engineer at least CAD 100000 per year',
    );
    expect(result.input).toMatchObject({
      q: 'engineer',
      work_mode: ['remote'],
      salary_min: 100000,
      salary_currency: 'CAD',
      salary_period: 'year',
    });
    expect(result.warnings).toEqual([]);
  });

  it('bounds long input and explains role-query truncation', () => {
    const result = interpretOpportunitySearch(
      Array.from({ length: 20 }, (_, i) => `role${i}`).join(' '),
    );
    expect(result.input.q.split(/\s+/u)).toHaveLength(8);
    expect(result.warnings).toContain('Only the first 8 role terms were used.');
    expect(result.originalQuery).toContain('role19');
  });

  it('retains the submitted raw query while disclosing the interpretation bound', () => {
    const raw = `${'engineer '.repeat(125)}tail`;
    const result = interpretOpportunitySearch(raw);
    expect(result.originalQuery).toBe(raw);
    expect(result.warnings).toContain(
      'Only the first 1000 characters were interpreted.',
    );
  });

  it('suggests editable skills for occupations across industries without discarding the role', () => {
    expect(interpretOpportunitySearch('nurse').input).toMatchObject({
      q: 'nurse',
      skills: ['patient-care', 'clinical-documentation'],
    });
    expect(interpretOpportunitySearch('welder').input).toMatchObject({
      q: 'welder',
      skills: ['welding'],
    });
    expect(interpretOpportunitySearch('teacher').input.skills).toContain(
      'lesson-planning',
    );
    expect(interpretOpportunitySearch('not nurse').input.skills).toEqual([]);
    expect(
      interpretOpportunitySearch('nurse without patient care').input.skills,
    ).not.toContain('patient-care');
  });

  it('exports the public-schema validation used by route loaders', () => {
    expect(validateOpportunitySearchInput({ q: 'engineer' }).q).toBe(
      'engineer',
    );
    expect(() =>
      validateOpportunitySearchInput({
        q: 'one two three four five six seven eight nine',
      }),
    ).toThrow();
  });
});
