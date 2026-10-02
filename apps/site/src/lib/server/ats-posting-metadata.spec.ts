import { describe, expect, it } from 'vitest';
import {
  atsPostingLocations,
  atsStructuredCompensation,
  atsTextCompensation,
} from './ats-posting-metadata.js';
import vanta from './fixtures/ats/vanta-developer-experience.json';

describe('primary ATS metadata', () => {
  it('retains primary and secondary Canada locations from Vanta source data', () => {
    expect(atsPostingLocations(vanta.posting)).toEqual([
      'Remote U.S.',
      'Remote - Canada',
    ]);
    expect(
      atsStructuredCompensation(vanta.jobPosting.baseSalary),
    ).toMatchObject({ currency: 'USD', salaryMin: 224000, salaryMax: 263000 });
    expect(
      atsTextCompensation(vanta.posting.compensationTierSummary),
    ).toMatchObject({ currency: '', salaryMin: 224000, salaryMax: 263000 });
  });

  it('retains all explicit postal locations and Lever categories', () => {
    expect(
      atsPostingLocations({
        location: 'Remote US',
        secondaryLocations: [
          {
            location: 'Remote Canada',
            address: {
              postalAddress: {
                addressLocality: 'Toronto',
                addressCountry: 'Canada',
              },
            },
          },
        ],
      }),
    ).toEqual(['Remote US', 'Remote Canada', 'Toronto, Canada']);
    expect(
      atsPostingLocations({
        categories: {
          location: 'New York',
          allLocations: ['New York', 'Toronto', 'Vancouver'],
        },
      }),
    ).toEqual(['New York', 'Toronto', 'Vancouver']);
    expect(
      atsPostingLocations({
        location: { name: 'Remote, Canada' },
        offices: [{ name: 'Remote, United States' }],
      }),
    ).toEqual(['Remote, Canada', 'Remote, United States']);
    expect(
      atsPostingLocations({ secondaryLocations: 'unknown', offices: null }),
    ).toEqual([]);
  });

  it('never turns benefits or ambiguous currencies into a salary range', () => {
    expect(atsTextCompensation('Medical, 401(k), 4 weeks vacation')).toEqual({
      compNotes: 'Medical, 401(k), 4 weeks vacation',
      currency: '',
    });
    expect(
      atsTextCompensation('USD $100k - $150k; CAD $130k - $170k'),
    ).not.toHaveProperty('salaryMin');
    expect(atsTextCompensation('CAD $190k - $160k')).not.toHaveProperty(
      'salaryMin',
    );
    expect(atsTextCompensation('GBP £5k - £6k monthly')).not.toHaveProperty(
      'salaryMin',
    );
    expect(atsTextCompensation('CAD $90 - $110/hour')).toMatchObject({
      currency: 'CAD',
      hourlyMin: 90,
      hourlyMax: 110,
    });
  });

  it('preserves salary units and rejects invalid structured bounds', () => {
    expect(
      atsStructuredCompensation({
        currency: 'CAD',
        interval: 'per-year-salary',
        min: 140000,
        max: 180000,
      }),
    ).toMatchObject({ currency: 'CAD', salaryMin: 140000, salaryMax: 180000 });
    expect(
      atsStructuredCompensation({
        currency: 'USD',
        value: { unitText: 'HOUR', minValue: 80, maxValue: 100 },
      }),
    ).toMatchObject({ hourlyMin: 80, hourlyMax: 100, salaryMin: null });
    for (const value of [
      {},
      { minValue: '', maxValue: null },
      { minValue: 0, maxValue: 0 },
      { minValue: 200, maxValue: 100 },
      { minValue: -1, maxValue: 'malformed' },
    ]) {
      expect(
        atsStructuredCompensation({
          currency: 'USD',
          value: { unitText: 'YEAR', ...value },
        }),
      ).toMatchObject({ salaryMin: null, salaryMax: null });
    }
    expect(
      atsStructuredCompensation({
        currency: 'CAD',
        value: { unitText: 'MONTH', minValue: 5000, maxValue: 6000 },
      }),
    ).toMatchObject({ salaryMin: null, hourlyMin: null });
  });
});
