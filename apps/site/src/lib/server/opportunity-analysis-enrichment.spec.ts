import { describe, expect, it, vi } from 'vitest';

vi.mock('./smrt.js', () => ({ getCollection: vi.fn() }));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
}));

import { parseAnalysisProviderOutput } from './opportunity-analysis-enrichment.js';

const description = 'Python required. Remote software role.';
const valid = () => ({
  summaryBullets: ['Remote software role.'],
  skills: [
    {
      slug: 'python',
      label: 'Python',
      kind: 'required',
      confidence: 1,
      evidence: [{ start: 0, end: 6, quote: 'Python' }],
    },
  ],
  requirements: [
    {
      text: 'Python required.',
      kind: 'must',
      category: 'skill',
      skills: ['python'],
      evidence: [{ start: 0, end: 16, quote: 'Python required.' }],
    },
  ],
});
describe('analysis provider boundary', () => {
  it('accepts only bounded source-proven fields and derives semantic hashes', () => {
    const output = parseAnalysisProviderOutput(valid(), description);
    expect(output.requirements[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(output.requirements[0].evidence).toEqual([{ start: 0, end: 16 }]);
  });
  it.each([
    'extra',
    'quote',
    'offset',
    'skill',
    'requirement',
    'summary',
    'pii',
    'enum',
  ])('rejects %s violations before reusable ledger completion', (kind) => {
    const value = valid();
    if (kind === 'extra')
      Object.assign(value, { candidateProfileId: 'private' });
    if (kind === 'quote') value.skills[0].evidence[0].quote = 'Java';
    if (kind === 'offset') value.skills[0].evidence[0].end = 999;
    if (kind === 'skill') value.skills[0].slug = 'java';
    if (kind === 'requirement')
      value.requirements[0].text = 'No Python needed.';
    if (kind === 'summary') value.summaryBullets = ['Invented salary $500000'];
    if (kind === 'pii') value.skills[0].label = 'person@example.com';
    if (kind === 'enum') value.requirements[0].kind = 'unknown';
    expect(() => parseAnalysisProviderOutput(value, description)).toThrow();
  });
});
