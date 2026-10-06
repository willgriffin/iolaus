import { describe, expect, it } from 'vitest';
import { onboardingInput } from './candidate-onboarding-form.js';

function basicForm() {
  const form = new FormData();
  form.set('onboardingMode', 'basic');
  form.append('citizenshipCountryCodes', 'CA');
  form.append('citizenshipCountryCodes', 'DE');
  form.set('citizenshipWorkAuthorization', 'yes');
  form.set('canWorkElsewhere', 'unknown');
  form.set('workModeChoice', 'remote');
  return form;
}
describe('onboarding form parsing', () => {
  it('parses repeated basic choices while omitting unsubmitted advanced fields', () => {
    const form = basicForm();
    form.set('authorizedWorkCountries', 'US'); // A disabled/forged legacy field has no effect without the explicit marker.
    const input = onboardingInput(form);
    expect(input.basicWorkEligibility).toEqual({
      citizenshipCountryCodes: ['CA', 'DE'],
      citizenshipWorkAuthorization: 'yes',
      canWorkElsewhere: 'unknown',
      otherAuthorizedCountryCodes: [],
      workModeChoice: 'remote',
    });
    for (const key of [
      'authorizedWorkCountries',
      'residenceCountry',
      'targetWorkCountry',
      'workAuthorization',
      'sponsorshipRequired',
    ])
      expect(input).not.toHaveProperty(key);
    expect(input.preferences).not.toHaveProperty('workModes');
  });
  it('coexists with explicit advanced edits without clearing omitted advanced fields', () => {
    const form = basicForm();
    form.set('advancedCountryEdits', '1');
    form.set('authorizedWorkCountries', 'CA, US');
    form.set('targetWorkCountry', 'CA');
    form.set('workAuthorization', 'Explicit detail');
    expect(onboardingInput(form)).toMatchObject({
      authorizedWorkCountries: ['CA', 'US'],
      targetWorkCountry: 'CA',
      workAuthorization: 'Explicit detail',
      basicWorkEligibility: { citizenshipCountryCodes: ['CA', 'DE'] },
    });
    expect(onboardingInput(form)).not.toHaveProperty('residenceCountry');
  });
  it('preserves legacy form names and rejects forged basic answer values', () => {
    const legacy = new FormData();
    legacy.set('citizenshipCountries', 'CA, US');
    legacy.set('workModes', 'remote, hybrid');
    expect(onboardingInput(legacy)).toMatchObject({
      citizenshipCountries: ['CA', 'US'],
      preferences: { workModes: ['remote', 'hybrid'] },
      sponsorshipRequired: 'unknown',
    });
    const form = basicForm();
    form.set('citizenshipWorkAuthorization', 'always');
    expect(() => onboardingInput(form)).toThrow('Choose Yes');
    form.set('citizenshipWorkAuthorization', 'unknown');
    form.set('workModeChoice', 'teleport');
    expect(() => onboardingInput(form)).toThrow('supported work mode');
  });
});
