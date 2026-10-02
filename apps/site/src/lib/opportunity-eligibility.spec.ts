import { describe, expect, it } from 'vitest';
import {
  buildOpportunityEligibility,
  decideOpportunityEligibility,
  getOpportunityEligibility,
  opportunityEligibilityProjection,
} from './opportunity-eligibility.js';
import { fingerprintOpportunitySourceContent } from './server/opportunity-source-content.js';
import { verifiedOpportunityEligibilityProjection } from './server/opportunity-eligibility-refresh.js';

function record(descriptionRaw: string) {
  const source = { descriptionRaw };
  const value = {
    descriptionRaw,
    sourceContentJson: JSON.stringify(source),
    sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
    sourceContentVersion: 1,
  };
  return { ...value, ...opportunityEligibilityProjection(value) };
}
describe('source-grounded posting eligibility', () => {
  it.each([
    ['This role is remote in Canada. We do not offer visa sponsorship.', 1],
    ['Candidates must be based in the US. Visa sponsorship is available.', 14],
    [
      'Candidates must be based in Canada. Applicants must already be authorized to work in the US.',
      16,
    ],
    ['Remote worldwide, except Canada.', 8],
    ['Visa sponsorship is available only to candidates already in the US.', 12],
    ['Remote worldwide, except selected countries.', 32],
    ['Candidates must reside in Ontario, Canada.', 32],
    [
      'Benefits\nYou must be authorized to work in the US.\nLocation\nThis role is remote in Canada.',
      1,
    ],
    [
      'Benefits: Applicants must be authorized to work in the US.\nThis role is remote in Canada.',
      1,
    ],
    [
      'Our company requires authorization to work in the US.\nThis role is remote in Canada.',
      1,
    ],
    ['We offer employer of record services.', 32],
    ['Visa sponsorship is available. Visa sponsorship is denied.', 16],
    ['This role is remote in Canada. Visa sponsorship is available.', 3],
    ['A global company with historical visaOrEorPossible=true.', 32],
  ])('%s produces evidence-based flags %i', (source, flags) => {
    expect(getOpportunityEligibility(record(source)).flags).toBe(flags);
  });
  it('retains sponsorship conditions rather than making an unconditional promise', () => {
    const result = getOpportunityEligibility(
      record(
        'Visa sponsorship is available only to candidates already in the US.',
      ),
    );
    expect(
      result.assertions.find(
        (assertion) => assertion.kind === 'conditional_sponsorship',
      ),
    ).toMatchObject({
      kind: 'conditional_sponsorship',
      condition: expect.stringContaining('only'),
    });
  });
  it('fails closed when persisted facts are authored or stale', () => {
    const value = record('Candidates must be based in Canada.');
    expect(
      getOpportunityEligibility({ ...value, sourceContentVersion: 2 }).status,
    ).toBe('stale');
    const forged = JSON.parse(value.postingEligibilityJson);
    forged.assertions[0].excerpt = 'invented';
    expect(
      getOpportunityEligibility({
        ...value,
        postingEligibilityJson: JSON.stringify(forged),
      }).flags,
    ).toBe(32);
  });
  it('independently verifies source fingerprint before persisting projections', () => {
    const value = record('Candidates must be based in Canada.');
    expect(
      verifiedOpportunityEligibilityProjection({
        ...value,
        sourceContentJson: JSON.stringify({
          descriptionRaw: 'Candidates must reside in the US.',
        }),
      }).eligibilityFlags,
    ).toBe(32);
  });
  it('ignores legacy scores, candidate authorization, and arbitrary derived flags', () => {
    const value = record('An interesting opportunity.');
    expect(
      getOpportunityEligibility({
        ...value,
        workAuthorization: 'Canada',
        visaOrEorPossible: true,
        eligibilityFlags: 1,
      }).flags,
    ).toBe(32);
  });
  it('never substitutes legacy or derived text for a captured source without description', () => {
    const source = { title: 'Captured title only' };
    const value = {
      sourceContentJson: JSON.stringify(source),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
      sourceContentVersion: 1,
      descriptionRaw:
        'Candidates must be based in Canada. Visa sponsorship is available.',
    };
    expect(
      verifiedOpportunityEligibilityProjection(value).eligibilityFlags,
    ).toBe(32);
  });
  it('does not publish a partial positive classification for overlong clauses', () => {
    const payload = buildOpportunityEligibility(
      record(`This role is remote in Canada.\n${'x'.repeat(601)}`),
    );
    expect(decideOpportunityEligibility(payload).flags).toBe(32);
  });
});
