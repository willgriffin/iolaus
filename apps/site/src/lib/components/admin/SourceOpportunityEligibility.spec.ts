import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import SourceOpportunityEligibility from './SourceOpportunityEligibility.svelte';

const quote = 'We offer visa sponsorship.';
const projection = {
  sourceStatus: 'current',
  sourceContentFingerprint: 'source-current',
  sourceContentVersion: 3,
  eligibilityBucket: 'location_restriction',
  reason: 'This role requires working in the United States.',
  conditionalPaths: [
    {
      kind: 'sponsorship',
      status: 'offered',
      facts: [
        {
          key: 'sponsorship_offered',
          citations: [
            { quote, start: 20, end: 20 + quote.length, hash: 'attested-hash' },
          ],
        },
      ],
    },
  ],
  unresolvedConstraintFactKeys: [],
};
const props = {
  projection,
  sourceContentFingerprint: 'source-current',
  sourceContentVersion: 3,
};

describe('SourceOpportunityEligibility', () => {
  it('shows captured Remote Canada independently of unknown legal eligibility in compact lists', () => {
    const { body } = render(SourceOpportunityEligibility, {
      props: {
        ...props,
        compact: true,
        projection: {
          ...projection,
          sourceStatus: 'unknown',
          eligibilityBucket: 'unknown',
          conditionalPaths: [],
          capturedPostingLocation: {
            sourceStatus: 'current',
            sourceContentFingerprint: 'source-current',
            sourceContentVersion: 3,
            locationNotes: 'Remote Canada',
            workMode: 'remote',
          },
        },
      },
    });
    expect(body).toContain(
      'Captured posting location: <strong>Remote Canada</strong>',
    );
    expect(body).toContain(
      'Captured work arrangement: <strong>remote</strong>',
    );
    expect(body).toContain(
      'does not establish work authorization or candidate eligibility',
    );
    expect(body).not.toContain('Eligible for your work location');
    expect(body).not.toContain('no explicit current allowance');
  });
  it.each([
    { sourceContentFingerprint: 'changed' },
    { sourceContentVersion: 4 },
  ])('hides captured location when its source identity is stale', (change) => {
    const { body } = render(SourceOpportunityEligibility, {
      props: {
        ...props,
        ...change,
        projection: {
          ...projection,
          capturedPostingLocation: {
            sourceStatus: 'current',
            sourceContentFingerprint: 'source-current',
            sourceContentVersion: 3,
            locationNotes: 'Remote Canada',
            workMode: 'remote',
          },
        },
      },
    });
    expect(body).not.toContain('Captured posting location');
    expect(body).not.toContain('Remote Canada');
  });
  it.each([
    ['offered', 'Sponsorship stated for this role'],
    ['denied', 'Sponsorship explicitly denied'],
    ['conflicting', 'Sponsorship statements conflict'],
  ])('keeps a US-only primary restriction separate from %s sponsorship evidence', (status, label) => {
    const { body } = render(SourceOpportunityEligibility, {
      props: {
        ...props,
        projection: {
          ...projection,
          conditionalPaths: [{ ...projection.conditionalPaths[0], status }],
        },
      },
    });
    expect(body).toContain('Location or authorization restriction');
    expect(body).toContain(label);
    expect(body).toContain(quote);
    expect(body).toContain(
      'does not establish work authorization or relocation approval',
    );
    expect(body).not.toContain('Eligible for your work location');
    expect(body).not.toContain('Canada eligible');
    expect(body).not.toMatch(/fitScore|\d+\/100|Strong match|\bstars\b/);
  });
  it.each([
    { projection: undefined },
    { projection: { ...projection, sourceStatus: 'unknown' } },
    { sourceContentFingerprint: 'changed' },
    { sourceContentVersion: 4 },
    {
      projection: {
        ...projection,
        conditionalPaths: [
          {
            ...projection.conditionalPaths[0],
            status: 'provider_future_value',
          },
        ],
      },
    },
    {
      projection: {
        ...projection,
        conditionalPaths: [{ ...projection.conditionalPaths[0], facts: [] }],
      },
    },
  ])('hides unavailable, stale or unattested path presentations (%j)', (change) => {
    const { body } = render(SourceOpportunityEligibility, {
      props: { ...props, ...change },
    });
    expect(body).not.toContain('Posting work-location eligibility');
    expect(body).not.toContain('Sponsorship stated');
    expect(body).not.toContain(quote);
  });
  it('retains source-backed sponsorship when candidate eligibility is unknown', () => {
    const { body } = render(SourceOpportunityEligibility, {
      props: {
        ...props,
        projection: {
          ...projection,
          eligibilityBucket: 'unknown',
          reason: 'The active candidate profile is unavailable.',
        },
      },
    });
    expect(body).toContain(
      'Posting work-location eligibility: <strong>Unknown</strong>',
    );
    expect(body).toContain('Sponsorship stated for this role');
    expect(body).not.toContain('Eligible for your work location');
  });
  it('does not manufacture a path from a current primary restriction alone', () => {
    const { body } = render(SourceOpportunityEligibility, {
      props: { ...props, projection: { ...projection, conditionalPaths: [] } },
    });
    expect(body).toContain('Location or authorization restriction');
    expect(body).not.toContain('Sponsorship');
  });
  it('keeps compact source citations accessible and hides only unknown empty compact projections', () => {
    const { body } = render(SourceOpportunityEligibility, {
      props: { ...props, compact: true },
    });
    expect(body).toContain('Posting citations');
    expect(body).not.toMatch(/<details[^>]*\bopen\b/);
    const { body: unknown } = render(SourceOpportunityEligibility, {
      props: {
        ...props,
        compact: true,
        projection: {
          ...projection,
          eligibilityBucket: 'unknown',
          conditionalPaths: [],
        },
      },
    });
    expect(unknown).not.toContain('Posting work-location eligibility');
  });
  it('escapes the supplied literal citation instead of executing captured markup', () => {
    const quote = '<script>alert(1)</script>';
    const { body } = render(SourceOpportunityEligibility, {
      props: {
        ...props,
        projection: {
          ...projection,
          conditionalPaths: [
            {
              ...projection.conditionalPaths[0],
              facts: [
                {
                  key: 'sponsorship_offered',
                  citations: [
                    { quote, start: 0, end: quote.length, hash: 'hash' },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(body).toContain('&lt;script');
    expect(body).not.toContain('<script>alert');
  });
});
