import { describe, expect, it } from 'vitest';
import {
  parseJevQaArguments,
  parseJevQaCohort,
  verifiedJevQaDatabase,
} from './matching-source-jev-publish.js';

const id = '11111111-0000-4000-8000-000000000001';

describe('local Jev publication admission', () => {
  it('accepts only the explicit isolated loopback clone', () => {
    expect(
      verifiedJevQaDatabase('postgresql://localhost:55490/iolaus_sweep_clone'),
    ).toBe('postgresql://127.0.0.1:55490/iolaus_sweep_clone');
    for (const url of [
      undefined,
      'postgresql://example.invalid:55490/iolaus_sweep_clone',
      'postgresql://localhost:5432/iolaus_sweep_clone',
      'postgresql://localhost:55490/other',
      'postgresql://localhost:55490/iolaus_sweep_clone?host=example.invalid',
    ])
      expect(() => verifiedJevQaDatabase(url)).toThrow();
  });

  it('requires explicit bounded admission and distinct IDs', () => {
    expect(parseJevQaCohort([id])).toEqual([id]);
    expect(() => parseJevQaCohort([id, id])).toThrow();
    expect(() => parseJevQaCohort(['not-a-posting-id'])).toThrow();
    expect(parseJevQaArguments(['--cohort', 'fixture.json']).apply).toBe(false);
    expect(() =>
      parseJevQaArguments(['--cohort', 'fixture.json', '--apply']),
    ).toThrow();
    expect(() =>
      parseJevQaArguments([
        '--cohort',
        'fixture.json',
        '--apply',
        '--max-calls',
        '1501',
        '--max-cost-micros',
        '500000',
      ]),
    ).toThrow();
    expect(
      parseJevQaArguments([
        '--cohort',
        'fixture.json',
        '--apply',
        '--max-calls',
        '1500',
        '--max-cost-micros',
        '500000',
      ]),
    ).toMatchObject({ apply: true, maxCalls: 1500, maxCostMicros: 500000 });
  });
});
