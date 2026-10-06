import type { CandidateOnboardingInput } from './candidate-onboarding.js';
import type {
  BasicWorkMode,
  WorkRightAnswer,
} from './candidate-work-eligibility.js';

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}
function listValue(value: FormDataEntryValue | null): string[] {
  return stringValue(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
function triState(form: FormData, key: string): WorkRightAnswer {
  const value = stringValue(form.get(key)) || 'unknown';
  if (value !== 'yes' && value !== 'no' && value !== 'unknown')
    throw new Error('Choose Yes, No, or Not sure.');
  return value;
}
function repeatedCodes(form: FormData, key: string): string[] {
  return form
    .getAll(key)
    .map((value) => stringValue(value))
    .filter(Boolean);
}

export function onboardingInput(form: FormData): CandidateOnboardingInput {
  const saveVoluntaryDemographics =
    form.get('saveVoluntaryDemographics') === 'on';
  const demographics = {
    disability: stringValue(form.get('demographicDisability')),
    gender: stringValue(form.get('demographicGender')),
    raceOrEthnicity: stringValue(form.get('demographicRaceOrEthnicity')),
    veteranStatus: stringValue(form.get('demographicVeteranStatus')),
  };
  const basic = form.get('onboardingMode') === 'basic';
  const advanced = !basic || form.get('advancedCountryEdits') === '1';
  const workMode = stringValue(form.get('workModeChoice')) || 'unknown';
  if (
    basic &&
    !['remote', 'hybrid', 'onsite', 'any', 'unknown'].includes(workMode)
  )
    throw new Error('Choose a supported work mode.');
  return {
    ...(basic
      ? {
          basicWorkEligibility: {
            citizenshipCountryCodes: repeatedCodes(
              form,
              'citizenshipCountryCodes',
            ),
            citizenshipWorkAuthorization: triState(
              form,
              'citizenshipWorkAuthorization',
            ),
            canWorkElsewhere: triState(form, 'canWorkElsewhere'),
            otherAuthorizedCountryCodes: repeatedCodes(
              form,
              'otherAuthorizedCountryCodes',
            ),
            workModeChoice: workMode as BasicWorkMode,
          },
        }
      : { citizenshipCountries: listValue(form.get('citizenshipCountries')) }),
    ...(advanced && (!basic || form.has('authorizedWorkCountries'))
      ? {
          authorizedWorkCountries: listValue(
            form.get('authorizedWorkCountries'),
          ),
        }
      : {}),
    email: stringValue(form.get('email')),
    firstName: stringValue(form.get('firstName')),
    githubUrl: stringValue(form.get('githubUrl')),
    lastName: stringValue(form.get('lastName')),
    linkedinUrl: stringValue(form.get('linkedinUrl')),
    location: stringValue(form.get('location')),
    name: stringValue(form.get('name')),
    phone: stringValue(form.get('phone')),
    preferences: {
      locations: listValue(form.get('preferredLocations')),
      targetCompensation: stringValue(form.get('targetCompensation')),
      targetRoles: listValue(form.get('targetRoles')),
      ...(!basic ? { workModes: listValue(form.get('workModes')) } : {}),
    },
    reusableAnswers: [
      {
        label: stringValue(form.get('reusableAnswerLabel')),
        saveForReuse: form.get('saveReusableAnswer') === 'on',
        value: stringValue(form.get('reusableAnswerValue')),
      },
    ],
    ...(advanced && (!basic || form.has('residenceCountry'))
      ? { residenceCountry: stringValue(form.get('residenceCountry')) }
      : {}),
    resumeAssetId: stringValue(form.get('resumeAssetId')),
    resumeSource:
      form.get('resumeSource') === 'upload_later'
        ? 'upload_later'
        : 'not_selected',
    saveVoluntaryDemographics,
    ...(!basic || form.has('sponsorshipRequired')
      ? { sponsorshipRequired: triState(form, 'sponsorshipRequired') }
      : {}),
    summary: stringValue(form.get('summary')),
    ...(advanced && (!basic || form.has('targetWorkCountry'))
      ? { targetWorkCountry: stringValue(form.get('targetWorkCountry')) }
      : {}),
    title: stringValue(form.get('title')),
    ...(advanced && (!basic || form.has('workAuthorization'))
      ? { workAuthorization: stringValue(form.get('workAuthorization')) }
      : {}),
    ...(saveVoluntaryDemographics ? { demographics } : {}),
  };
}
