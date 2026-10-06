import { describe, expect, it } from 'vitest';
import {
  applyBasicWorkEligibility,
  candidateWorkEligibilityFromProfile,
  projectBasicWorkEligibility,
} from './candidate-work-eligibility.js';

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

describe('basic work-right confirmations', () => {
  const basic = {
    citizenshipCountryCodes: ['CA'],
    citizenshipWorkAuthorization: 'unknown' as const,
    canWorkElsewhere: 'unknown' as const,
    otherAuthorizedCountryCodes: [],
    workModeChoice: 'unknown' as const,
  };
  it('does not authorize citizenship alone and adds rights only after explicit Yes', () => {
    expect(
      JSON.parse(
        applyBasicWorkEligibility({}, basic).authorizedWorkCountriesJson,
      ),
    ).toEqual([]);
    expect(
      JSON.parse(
        applyBasicWorkEligibility(
          {},
          { ...basic, citizenshipWorkAuthorization: 'yes' },
        ).authorizedWorkCountriesJson,
      ),
    ).toEqual([{ country: { code: 'CA', label: 'Canada' }, scope: 'country' }]);
    expect(
      projectBasicWorkEligibility({
        citizenshipsJson: JSON.stringify([{ code: 'CA', label: 'Canada' }]),
      }).citizenshipWorkAuthorization,
    ).toBe('unknown');
  });
  it('preserves conditional and employer-limited rights without upgrading their scope', () => {
    const rights = [
      {
        country: { code: 'CA', label: 'Canada' },
        scope: 'conditional',
        condition: 'Permit must be renewed',
      },
      {
        country: { code: 'US', label: 'United States' },
        scope: 'employer_limited',
        condition: 'Current employer only',
      },
    ];
    const result = applyBasicWorkEligibility(
      { authorizedWorkCountriesJson: JSON.stringify(rights) },
      {
        ...basic,
        citizenshipWorkAuthorization: 'yes',
        canWorkElsewhere: 'yes',
        otherAuthorizedCountryCodes: ['US'],
      },
    );
    expect(JSON.parse(result.authorizedWorkCountriesJson)).toEqual(rights);
  });
  it('rejects contradictory No before mutation and allows explicit advanced clarification', () => {
    const profile = {
      authorizedWorkCountriesJson: JSON.stringify([
        { country: { code: 'CA', label: 'Canada' }, scope: 'country' },
      ]),
    };
    expect(() =>
      applyBasicWorkEligibility(profile, {
        ...basic,
        citizenshipWorkAuthorization: 'no',
      }),
    ).toThrow('No conflicts with saved');
    expect(
      JSON.parse(
        applyBasicWorkEligibility(
          profile,
          { ...basic, citizenshipWorkAuthorization: 'no' },
          { authorizedWorkCountries: [] },
        ).authorizedWorkCountriesJson,
      ),
    ).toEqual([]);
    expect(
      projectBasicWorkEligibility({
        ...profile,
        citizenshipsJson: JSON.stringify([{ code: 'CA', label: 'Canada' }]),
        preferencesJson: JSON.stringify({ citizenshipWorkAuthorization: 'no' }),
      }).conflicts,
    ).toHaveLength(1);
  });
  it('requires country selections for Yes and preserves explicit unknown metadata', () => {
    expect(() =>
      applyBasicWorkEligibility({}, { ...basic, canWorkElsewhere: 'yes' }),
    ).toThrow('Select the other countries');
    expect(() =>
      applyBasicWorkEligibility(
        {},
        { ...basic, citizenshipCountryCodes: ['QQ'] },
      ),
    ).toThrow('valid country');
    const result = applyBasicWorkEligibility(
      {
        preferencesJson: JSON.stringify({
          workModes: ['remote'],
          targetRoles: ['Engineer'],
          otherAuthorizedCountryCodes: ['DE'],
        }),
      },
      basic,
    );
    expect(result.preferences).toMatchObject({
      citizenshipWorkAuthorization: 'unknown',
      canWorkElsewhere: 'unknown',
      workModes: ['remote'],
      targetRoles: ['Engineer'],
      otherAuthorizedCountryCodes: ['DE'],
    });
    expect(result.workAuthorization).toBeUndefined();
  });
  it('keeps rights outside citizenship separate and never derives residence or foreign authorization', () => {
    const result = applyBasicWorkEligibility(
      {},
      {
        ...basic,
        citizenshipWorkAuthorization: 'yes',
        canWorkElsewhere: 'yes',
        otherAuthorizedCountryCodes: ['DE'],
      },
    );
    expect(
      JSON.parse(result.authorizedWorkCountriesJson).map(
        (row: { country: { code: string } }) => row.country.code,
      ),
    ).toEqual(['CA', 'DE']);
    expect(result).not.toHaveProperty('residenceCountryJson');
    expect(
      projectBasicWorkEligibility({
        authorizedWorkCountriesJson: result.authorizedWorkCountriesJson,
        citizenshipsJson: result.citizenshipsJson,
      }).canWorkElsewhere,
    ).toBe('yes');
  });
});
