import { describe, expect, it } from 'vitest';
import {
  buildOpportunityEligibility,
  decideOpportunityEligibility,
  getOpportunityEligibility,
  opportunityEligibilityProjection,
  POSTING_ELIGIBILITY_VERSION,
} from './opportunity-eligibility.js';
import { verifiedOpportunityEligibilityProjection } from './server/opportunity-eligibility-refresh.js';
import { fingerprintOpportunitySourceContent } from './server/opportunity-source-content.js';

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
    'Partnering with your Executive Sponsor, you will provide transformation support.',
    'Ensure the roadmap is aligned with your Executive Sponsor and business priorities.',
    'We offer project sponsorship and provide executive support.',
    'Event sponsorship is available for the annual technology conference.',
    'Conference sponsors provide support for speakers and exhibitors.',
    'Candidates with a work visa collaborate with an Executive Sponsor who provides guidance.',
    'Candidates with a work permit can access event sponsorship opportunities.',
  ])('does not treat business sponsorship as immigration evidence: %s', (description) => {
    const result = getOpportunityEligibility(record(description));
    expect(result.flags).toBe(32);
    expect(
      result.assertions.filter((assertion) =>
        [
          'sponsorship_offered',
          'conditional_sponsorship',
          'sponsorship_denied',
        ].includes(assertion.kind),
      ),
    ).toEqual([]);
  });

  it.each([
    'We offer visa sponsorship.',
    'Immigration sponsorship is available for this role.',
    'We sponsor work visas for qualified candidates.',
    'We provide work permit sponsorship.',
    'Work visa sponsorship is supported.',
  ])('preserves explicit immigration sponsorship: %s', (description) => {
    const result = getOpportunityEligibility(record(description));
    expect(result.flags).toBe(2);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'sponsorship_offered',
          excerpt: description,
        }),
      ]),
    );
  });

  it('rejects an older parser payload and token-free refresh replaces its false sponsorship', () => {
    const value = record('Your Executive Sponsor provides strategic support.');
    const previous = {
      version: 'posting-eligibility/v1',
      sourceContentFingerprint: value.sourceContentFingerprint,
      sourceContentVersion: value.sourceContentVersion,
      assertions: [
        { kind: 'sponsorship_offered', excerpt: value.descriptionRaw },
      ],
    };
    const old = {
      ...value,
      postingEligibilityJson: JSON.stringify(previous),
      eligibilityFlags: 2,
    };
    expect(getOpportunityEligibility(old)).toMatchObject({
      status: 'invalid',
      flags: 32,
      assertions: [],
    });
    const refreshed = verifiedOpportunityEligibilityProjection(old);
    expect(JSON.parse(refreshed.postingEligibilityJson)).toMatchObject({
      version: POSTING_ELIGIBILITY_VERSION,
      assertions: [],
    });
    expect(refreshed.eligibilitySourceFingerprint).toBe(
      value.sourceContentFingerprint,
    );
    expect(refreshed.eligibilitySourceVersion).toBe(value.sourceContentVersion);
    expect(getOpportunityEligibility({ ...old, ...refreshed })).toMatchObject({
      status: 'current',
      flags: 32,
    });
  });

  it.each([
    ['Remote, Canada; Remote, United States', 1],
    ['Remote, Canada; Remote, United Kingdom; Remote, United States', 1],
    ['Remote, United States', 12],
    ['Remote, United States; Remote, United Kingdom', 32],
    ['Remote, Ontario, Canada', 32],
    ['Toronto, Canada', 32],
    ['Canada', 32],
    ['Our corporate office is in Canada', 32],
    ['Remote, Canada; except Canada', 32],
  ])('captured ATS role location %s yields %i', (locationNotes, flags) => {
    const source = {
      descriptionRaw: 'A fictional engineering role.',
      locationNotes,
    };
    const value = {
      sourceContentJson: JSON.stringify(source),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
      sourceContentVersion: 1,
    };
    const projection = verifiedOpportunityEligibilityProjection(value);
    expect(getOpportunityEligibility({ ...value, ...projection }).flags).toBe(
      flags,
    );
  });
  it('retains structured source-field provenance and body contradictions dominate', () => {
    const source = {
      descriptionRaw:
        'Applicants must already be authorized to work in the US.',
      locationNotes: 'Remote, Canada; Remote, United States',
    };
    const value = {
      sourceContentJson: JSON.stringify(source),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
      sourceContentVersion: 1,
    };
    const result = getOpportunityEligibility({
      ...value,
      ...verifiedOpportunityEligibilityProjection(value),
    });
    expect(result.flags).toBe(16);
    expect(result.assertions[0]).toMatchObject({
      sourceField: 'locationNotes',
      excerpt: source.locationNotes,
      method: 'explicit-source-location',
    });
    source.descriptionRaw = 'Remote worldwide, except Canada.';
    const excluded = {
      ...value,
      sourceContentJson: JSON.stringify(source),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
    };
    expect(
      getOpportunityEligibility({
        ...excluded,
        ...verifiedOpportunityEligibilityProjection(excluded),
      }).flags,
    ).toBe(16);
  });
  it('never derives ATS location assertions from editable row location fields', () => {
    const value = record('A fictional role.');
    expect(
      getOpportunityEligibility({
        ...value,
        locationNotes: 'Remote, Canada',
        locations: 'Remote, Canada',
      }).flags,
    ).toBe(32);
  });
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
  it('does not publish a partial positive classification for an oversized source', () => {
    const payload = buildOpportunityEligibility(
      record(`This role is remote in Canada.\n${'x'.repeat(200_001)}`),
    );
    expect(decideOpportunityEligibility(payload).flags).toBe(32);
  });
  it.each([
    ['A lengthy duties paragraph with no geography restrictions.', 1],
    ['Applicants must reside in the United States.', 16],
    ['Remote worldwide, except Canada.', 16],
  ])('fully scans ordinary long posting paragraphs and late clause %s', (tail, flags) => {
    const descriptionRaw =
      Array.from(
        { length: 106 },
        () => 'General engineering duties, testing and collaboration.',
      ).join('\n') +
      '\n' +
      'Additional engineering responsibilities and collaboration. '.repeat(
        100,
      ) +
      tail;
    const source = {
      descriptionRaw,
      locationNotes: 'Remote, Canada; Remote, United States',
    };
    const value = {
      sourceContentJson: JSON.stringify(source),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
      sourceContentVersion: 1,
    };
    expect(descriptionRaw.length).toBeGreaterThan(11_000);
    expect(descriptionRaw.split('\n')).toHaveLength(107);
    expect(
      getOpportunityEligibility({
        ...value,
        ...verifiedOpportunityEligibilityProjection(value),
      }).flags,
    ).toBe(flags);
  });
});
