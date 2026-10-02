import { describe, expect, it } from 'vitest';
import { getOpportunityEligibility } from './opportunity-eligibility';
import { opportunityPostingSupport } from './opportunity-posting-support';
import { verifiedOpportunityEligibilityProjection } from './server/opportunity-eligibility-refresh';
import { fingerprintOpportunitySourceContent } from './server/opportunity-source-content';

function sourceSupport(source: string, validFingerprint = true) {
  const sourceContent = { descriptionRaw: source };
  const record = {
    relocationSupported: false,
    visaOrEorPossible: false,
    sourceContentJson: JSON.stringify(sourceContent),
    sourceContentFingerprint: validFingerprint
      ? fingerprintOpportunitySourceContent(sourceContent)
      : 'tampered',
    sourceContentVersion: 1,
  };
  return opportunityPostingSupport(
    getOpportunityEligibility({
      ...record,
      ...verifiedOpportunityEligibilityProjection(record),
    }),
  );
}

describe('source-verified opportunity support display', () => {
  it.each([
    [
      'We offer visa sponsorship.',
      'Visa sponsorship: yes (explicit posting evidence); EOR: Unknown',
    ],
    [
      'We do not offer visa sponsorship.',
      'Visa sponsorship: no (explicit posting evidence); EOR: Unknown',
    ],
    [
      'We offer an employer of record arrangement.',
      'Visa sponsorship: Unknown; EOR: yes (explicit posting evidence)',
    ],
    [
      'We do not offer an employer of record arrangement.',
      'Visa sponsorship: Unknown; EOR: no (explicit posting evidence)',
    ],
    [
      'We offer visa sponsorship. We do not offer visa sponsorship.',
      'Visa sponsorship: Unknown (conflicting posting evidence); EOR: Unknown',
    ],
    [
      'We offer visa sponsorship only for applicants already authorized to work here.',
      'Visa sponsorship: Unknown (conditional posting evidence); EOR: Unknown',
    ],
    ['This role is remote worldwide.', 'Unknown'],
  ])('uses attributed clauses, preserving independent support lanes: %s', (source, expected) => {
    expect(sourceSupport(source)).toEqual({
      relocationSupported: 'Unknown',
      visaOrEorPossible: expected,
    });
  });

  it('rejects affirmative and negative text under a forged source fingerprint', () => {
    expect(
      sourceSupport('We offer visa sponsorship.', false).visaOrEorPossible,
    ).toBe('Unknown');
    expect(
      sourceSupport('We do not offer visa sponsorship.', false)
        .visaOrEorPossible,
    ).toBe('Unknown');
  });

  it('does not use boolean defaults, authored projections, or stale assertions as posting evidence', () => {
    for (const defaultBoolean of [false, true]) {
      const record = {
        relocationSupported: defaultBoolean,
        visaOrEorPossible: defaultBoolean,
        postingEligibilityJson:
          '{"assertions":[{"kind":"sponsorship_offered"}]}',
      };
      expect(
        opportunityPostingSupport(
          getOpportunityEligibility({
            ...record,
            ...verifiedOpportunityEligibilityProjection(record),
          }),
        ),
      ).toEqual({
        relocationSupported: 'Unknown',
        visaOrEorPossible: 'Unknown',
      });
    }
    expect(
      opportunityPostingSupport({
        status: 'stale',
        assertions: [{ kind: 'sponsorship_offered' } as never],
      }).visaOrEorPossible,
    ).toBe('Unknown');
  });
});
