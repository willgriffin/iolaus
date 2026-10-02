import { describe, expect, it } from 'vitest';
import { candidateWorkEligibilityFromProfile } from './candidate-work-eligibility.js';

describe('candidateWorkEligibilityFromProfile', () => {
  it('uses only explicit typed country records and does not infer authorization from citizenship', () => {
    const result = candidateWorkEligibilityFromProfile({
      authorizedWorkCountriesJson: JSON.stringify([
        { country: { code: 'CA', label: 'Canada' }, scope: 'country' },
      ]),
      citizenshipsJson: JSON.stringify([
        { code: 'US', label: 'United States' },
      ]),
      residenceCountryJson: JSON.stringify({ code: 'CA', label: 'Canada' }),
      sponsorshipRequired: 'unknown',
      targetWorkCountryJson: JSON.stringify({ code: 'CA', label: 'Canada' }),
      workAuthorization: 'Eligible somewhere',
    });

    expect(result).toEqual({
      authorizedWorkCountries: [
        { country: { code: 'CA', label: 'Canada' }, scope: 'country' },
      ],
      citizenships: [{ code: 'US', label: 'United States' }],
      residenceCountry: { code: 'CA', label: 'Canada' },
      sponsorshipRequired: 'unknown',
      targetWorkCountry: { code: 'CA', label: 'Canada' },
    });
  });

  it('fails closed for malformed country or authorization data', () => {
    expect(
      candidateWorkEligibilityFromProfile({
        authorizedWorkCountriesJson: '[{"country":{"code":"California"}}]',
        citizenshipsJson: '["CA"]',
        residenceCountryJson: '{',
        sponsorshipRequired: 'yes',
        targetWorkCountryJson: '{}',
      }),
    ).toEqual({
      authorizedWorkCountries: [],
      citizenships: [],
      sponsorshipRequired: 'unknown',
    });
  });
});
