import type { OpportunityEligibilityDecision } from './opportunity-eligibility';

export type OpportunityPostingSupport = {
  relocationSupported: string;
  visaOrEorPossible: string;
};

/** Display only server-verified posting assertions, never model boolean defaults. */
export function opportunityPostingSupport(
  eligibility: Pick<OpportunityEligibilityDecision, 'assertions' | 'status'>,
): OpportunityPostingSupport {
  const kinds = new Set(
    eligibility.status === 'current'
      ? eligibility.assertions.map(({ kind }) => kind)
      : [],
  );
  const sponsorshipOffered = kinds.has('sponsorship_offered');
  const sponsorshipDenied = kinds.has('sponsorship_denied');
  const eorOffered = kinds.has('eor_offered');
  const eorDenied = kinds.has('eor_denied');
  const sponsorship = kinds.has('conditional_sponsorship')
    ? 'Unknown (conditional posting evidence)'
    : sponsorshipOffered && sponsorshipDenied
      ? 'Unknown (conflicting posting evidence)'
      : sponsorshipOffered
        ? 'yes (explicit posting evidence)'
        : sponsorshipDenied
          ? 'no (explicit posting evidence)'
          : 'Unknown';
  const eor =
    eorOffered && eorDenied
      ? 'Unknown (conflicting posting evidence)'
      : eorOffered
        ? 'yes (explicit posting evidence)'
        : eorDenied
          ? 'no (explicit posting evidence)'
          : 'Unknown';
  return {
    // The captured posting contract has no verified relocation assertion.
    relocationSupported: 'Unknown',
    // A sponsorship denial does not establish an EOR denial, or vice versa.
    visaOrEorPossible:
      sponsorship === 'Unknown' && eor === 'Unknown'
        ? 'Unknown'
        : `Visa sponsorship: ${sponsorship}; EOR: ${eor}`,
  };
}
