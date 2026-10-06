import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OpportunityScreeningSummary from './OpportunityScreeningSummary.svelte';

const quote = 'This role requires working in the United States.';
const source = { descriptionRaw: quote };
const witness = {
  id: 's0',
  path: 'sourceContentJson.descriptionRaw',
  text: quote,
  spanStart: 0,
  spanEnd: quote.length,
};
const projection = {
  version: 'opportunity-screening-projection/v1',
  mode: 'coarse_screen',
  sourceStatus: 'current',
  status: 'clear_mismatch',
  excludeFromDefaultTriage: true,
  requestId: 'owned-request',
  sourceContentFingerprint: 'current-source',
  sourceContentVersion: 2,
  sourceFingerprint: 'a'.repeat(64),
  profileFingerprint: 'b'.repeat(64),
  inputFingerprint: 'c'.repeat(64),
  evidence: [
    {
      dimension: 'country_mismatch',
      probability: 0.95,
      confidence: 0.95,
      witness,
    },
  ],
  conditionalPaths: [],
  uncertainties: [],
  holdReasons: [],
};
const record = {
  id: 'opportunity',
  sourceContentFingerprint: 'current-source',
  sourceContentVersion: 2,
  sourceContentJson: JSON.stringify(source),
  screeningProjection: projection,
  postingUrl: 'https://example.test/jobs/role',
};

describe('OpportunityScreeningSummary', () => {
  it.each([
    ['clear_mismatch', 'country_mismatch', 'Screened out'],
    ['potentially_relevant', 'role_relevant', 'Potentially relevant'],
    ['uncertain', 'unresolved_constraint', 'Uncertain'],
  ])('shows %s as coarse screening with a literal current-source reason', (status, dimension, label) => {
    const { body } = render(OpportunityScreeningSummary, {
      props: {
        record: {
          ...record,
          screeningProjection: {
            ...projection,
            status,
            excludeFromDefaultTriage: status === 'clear_mismatch',
            evidence: [{ ...projection.evidence[0], dimension }],
          },
        },
      },
    });
    expect(body).toContain(label);
    expect(body).toContain(quote);
    expect(body).toContain('https://example.test/jobs/role');
    expect(body).toContain('does not establish overall fit');
    expect(body).not.toMatch(
      /\d+\/100|Strong match|fitScore|humanReviewStatus/,
    );
  });
  it('keeps offered sponsorship conditional and uncertainties visible', () => {
    const { body } = render(OpportunityScreeningSummary, {
      props: {
        record: {
          ...record,
          screeningProjection: {
            ...projection,
            status: 'uncertain',
            excludeFromDefaultTriage: false,
            evidence: [
              { ...projection.evidence[0], dimension: 'sponsorship_path' },
            ],
            conditionalPaths: [{ kind: 'offered_sponsorship', witness }],
            uncertainties: [
              'sponsorship_path_requires_user_decision',
              'target_roles_missing',
            ],
          },
        },
      },
    });
    expect(body).toContain('Uncertain');
    expect(body).toContain('Preferred roles are not established.');
    expect(body).toContain('conditional path requiring review');
    expect(body).toContain(
      'does not establish eligibility, work authorization or relocation approval',
    );
    expect(body).not.toContain('Potentially relevant');
  });
  it('accepts an exact captured ATS field witness without invented body offsets', () => {
    const title = 'Platform Engineer';
    const { body } = render(OpportunityScreeningSummary, {
      props: {
        record: {
          ...record,
          sourceContentJson: JSON.stringify({ ...source, title }),
          screeningProjection: {
            ...projection,
            status: 'potentially_relevant',
            excludeFromDefaultTriage: false,
            evidence: [
              {
                ...projection.evidence[0],
                dimension: 'role_relevant',
                witness: {
                  id: 't',
                  path: 'sourceContentJson.title',
                  text: title,
                },
              },
            ],
          },
        },
      },
    });
    expect(body).toContain('Potentially relevant');
    expect(body).toContain(title);
    expect(body).not.toContain(quote);
  });
  it('labels a held mismatch uncertain when it cannot be excluded from default triage', () => {
    const { body } = render(OpportunityScreeningSummary, {
      props: {
        record: {
          ...record,
          screeningProjection: {
            ...projection,
            excludeFromDefaultTriage: false,
            holdReasons: ['target_roles_missing'],
          },
        },
      },
    });
    expect(body).toContain('Uncertain');
    expect(body).not.toContain('Screened out');
    expect(body).toContain('Preferred roles are not established.');
  });
  const capturedContext = {
    ...source,
    title: 'Platform Engineer',
    locationNotes: 'Canada',
    workMode: 'remote',
  };
  const contextEvidence = {
    ...projection.evidence[0],
    dimension: 'role_relevant',
    evidenceScope: 'captured_source_context',
    contextWitnesses: [
      { id: 't', path: 'sourceContentJson.title', text: capturedContext.title },
      {
        id: 'l',
        path: 'sourceContentJson.locationNotes',
        text: capturedContext.locationNotes,
      },
      {
        id: 'w',
        path: 'sourceContentJson.workMode',
        text: capturedContext.workMode,
      },
    ],
  };
  const contextRecord = {
    ...record,
    sourceContentJson: JSON.stringify(capturedContext),
    screeningProjection: {
      ...projection,
      status: 'potentially_relevant',
      excludeFromDefaultTriage: false,
      evidence: [contextEvidence],
    },
  };
  it('labels independent entailment as complete captured context with exact ATS citations', () => {
    const { body } = render(OpportunityScreeningSummary, {
      props: { record: contextRecord },
    });
    expect(body).toContain('Potentially relevant');
    expect(body).toContain(
      'Supported by the complete captured posting and ATS context.',
    );
    expect(body).toContain('Reviewed source context');
    expect(body).toContain(quote);
    expect(body).toContain(capturedContext.title);
    expect(body).toContain('Captured ATS location');
    expect(body).not.toMatch(/Strong match|work authorization established/);
  });
  it.each([
    { ...contextEvidence, evidenceScope: 'invented' },
    { ...contextEvidence, contextWitnesses: [] },
    { ...contextEvidence, contextWitnesses: undefined },
    {
      ...contextEvidence,
      witness: { ...witness, spanStart: 1, text: quote.slice(1) },
    },
    {
      ...contextEvidence,
      contextWitnesses: [
        contextEvidence.contextWitnesses[1],
        contextEvidence.contextWitnesses[0],
        contextEvidence.contextWitnesses[2],
      ],
    },
    {
      ...contextEvidence,
      contextWitnesses: contextEvidence.contextWitnesses.map((item) => ({
        ...item,
        text: 'Uncaptured',
      })),
    },
    { ...contextEvidence, evidenceScope: undefined },
  ])('withholds forged or incomplete whole-context citations %#', (evidence) => {
    const { body } = render(OpportunityScreeningSummary, {
      props: {
        record: {
          ...contextRecord,
          screeningProjection: {
            ...contextRecord.screeningProjection,
            evidence: [evidence],
          },
        },
      },
    });
    expect(body).not.toContain('Coarse opportunity screening');
  });
  it.each([
    { screeningProjection: null },
    { screeningProjection: { ...projection, version: 'future' } },
    { screeningProjection: { ...projection, mode: 'full_fit' } },
    { screeningProjection: { ...projection, sourceStatus: 'stale' } },
    { sourceContentFingerprint: 'different-source' },
    { sourceContentVersion: 3 },
    { screeningProjection: { ...projection, profileFingerprint: '' } },
    { screeningProjection: { ...projection, status: 'matched' } },
    {
      screeningProjection: {
        ...projection,
        evidence: [
          {
            ...projection.evidence[0],
            witness: { ...witness, text: 'Uncaptured reason' },
          },
        ],
      },
    },
    {
      screeningProjection: {
        ...projection,
        evidence: [
          {
            ...projection.evidence[0],
            witness: { ...witness, spanEnd: quote.length - 1 },
          },
        ],
      },
    },
    {
      screeningProjection: {
        ...projection,
        evidence: [{ ...projection.evidence[0], confidence: Number.NaN }],
      },
    },
    { screeningProjection: { ...projection, evidence: [] } },
    { screeningProjection: { ...projection, uncertainties: 'unsafe' } },
    {
      screeningProjection: {
        ...projection,
        conditionalPaths: [{ kind: 'authorization_granted', witness }],
      },
    },
    { sourceContentJson: '{}' },
    { sourceContentJson: '{invalid' },
  ])('withholds invalid, unavailable or stale screening %#', (override) => {
    const { body } = render(OpportunityScreeningSummary, {
      props: { record: { ...record, ...override } },
    });
    expect(body).not.toContain('Coarse opportunity screening');
    expect(body).not.toContain('Screened out');
    expect(body).not.toContain(quote);
  });
  it('escapes literal witness markup and does not create unsafe source links', () => {
    const text = '<script>unsafe()</script>';
    const { body } = render(OpportunityScreeningSummary, {
      props: {
        record: {
          ...record,
          postingUrl: 'javascript:unsafe()',
          sourceContentJson: JSON.stringify({ descriptionRaw: text }),
          screeningProjection: {
            ...projection,
            evidence: [
              {
                ...projection.evidence[0],
                witness: { ...witness, text, spanEnd: text.length },
              },
            ],
          },
        },
      },
    });
    expect(body).toMatch(/&lt;script(?:>|&gt;)/u);
    expect(body).not.toMatch(/<script\b/iu);
    expect(body).not.toContain('javascript:');
  });
});
