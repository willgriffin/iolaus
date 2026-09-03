import { describe, expect, it } from 'vitest';
import { CandidateAnswer } from './CandidateAnswer.js';
import { CandidateProfile } from './CandidateProfile.js';

describe('candidate private model projections', () => {
  it('removes contact, preference, demographic, and reusable-answer content from public output', () => {
    const profile = new CandidateProfile();
    profile.email = 'candidate@example.invalid';
    profile.phone = '+1 555 0100';
    profile.factsJson = '{"facts":{"email":"candidate@example.invalid"}}';
    profile.demographicsJson = '{"veteranStatus":"no"}';
    const answer = new CandidateAnswer();
    answer.label = 'Phone number';
    answer.labelKey = 'phone number';
    answer.value = '+1 555 0100';

    expect(profile.toPublicJSON()).not.toMatchObject({
      demographicsJson: expect.anything(),
      email: expect.anything(),
      factsJson: expect.anything(),
      phone: expect.anything(),
    });
    expect(answer.toPublicJSON()).not.toMatchObject({
      label: expect.anything(),
      labelKey: expect.anything(),
      value: expect.anything(),
    });
  });
});
