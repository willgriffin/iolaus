import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CandidateWorkEligibility } from './opportunity-assessment.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';
import {
  nominateSourceEligibilityFactOffers,
  prepareCanonicalCapturedSourceEligibilityEvidenceAudit,
  prepareCanonicalSourceEligibilityEvidenceAudit,
  prepareSourceEligibilityEvidenceAudit,
  projectSourceEligibility,
  projectVerifiedSourceEligibility,
  resolveSourceEligibilityEvidenceAudit,
  type SourceEligibilityEvidence,
  sourceEligibilityContextFromCapturedSource,
  sourceEligibilityFactKey,
  validateSourceEligibilityEvidence,
} from './source-eligibility-facts.js';

const sourceText =
  'Remote in Canada. No visa sponsorship. Visa sponsorship offered. Toronto hybrid role with Pacific time overlap.';
const CA = { code: 'CA', label: 'Canada' };
const US = { code: 'US', label: 'United States' };

function citation(text: string, occurrence = 0) {
  let start = -1;
  let cursor = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = sourceText.indexOf(text, cursor);
    cursor = start + text.length;
  }
  if (start < 0) throw new Error(`Missing fixture citation: ${text}`);
  return {
    clauseId: `clause:${start}`,
    end: start + text.length,
    hash: createHash('sha256').update(text).digest('hex'),
    start,
  };
}

function fact(
  kind: SourceEligibilityEvidence['facts'][number]['kind'],
  options: Partial<SourceEligibilityEvidence['facts'][number]> = {},
) {
  const base = {
    kind,
    ...(options.country ? { country: options.country } : {}),
    ...(options.constraint ? { constraint: options.constraint } : {}),
  };
  return {
    ...base,
    citations: options.citations ?? [citation('Remote in Canada.')],
    key: sourceEligibilityFactKey(base),
  } as SourceEligibilityEvidence['facts'][number];
}

function evidence(
  facts: SourceEligibilityEvidence['facts'],
): SourceEligibilityEvidence {
  return {
    aggregateFingerprint: 'aggregate:current',
    coverage: {
      authorization: true,
      geography: true,
      workArrangement: true,
    },
    facts,
    requestId: 'request:current',
    sourceContentFingerprint: 'source:current',
    sourceContentVersion: 1,
    version: 'source-eligibility-facts/v1',
  };
}

function candidate(
  overrides: Partial<CandidateWorkEligibility> = {},
): CandidateWorkEligibility {
  return {
    authorizedWorkCountries: [],
    citizenships: [],
    sponsorshipRequired: 'unknown',
    targetWorkCountry: CA,
    ...overrides,
  };
}

const current = {
  sourceContentFingerprint: 'source:current',
  sourceContentVersion: 1,
  sourceText,
};

describe('source eligibility facts', () => {
  it('uses only original captured ATS fields as exact v4 witnesses and invalidates metadata-only changes', () => {
    const content = {
      descriptionRaw: sourceText,
      locationNotes: 'United States (Remote); Canada (Remote)',
      workMode: 'remote',
    };
    const sourceContentFingerprint =
      fingerprintOpportunitySourceContent(content);
    const context = sourceEligibilityContextFromCapturedSource(
      {
        sourceText,
        sourceContentFingerprint,
        sourceContentVersion: 1,
      },
      JSON.stringify(content),
    );
    expect(context?.capturedFields).toEqual([
      expect.objectContaining({
        id: 'source-field:locationNotes',
        path: 'sourceContentJson.locationNotes',
        text: content.locationNotes,
      }),
      expect.objectContaining({
        id: 'source-field:workMode',
        path: 'sourceContentJson.workMode',
        text: content.workMode,
      }),
    ]);
    const prepared = prepareCanonicalCapturedSourceEligibilityEvidenceAudit({
      clauses: [
        { id: 'c0', start: 0, end: sourceText.length, text: sourceText },
      ],
      context: context!,
    });
    expect(prepared.auditVersion).toBe(
      'source-eligibility-audit/v4-captured-source',
    );
    expect(prepared.clauseAliases).toEqual({ c0: 'c0' });
    expect(prepared.request.state).toMatchObject({
      sourceEligibilityClauses: [expect.objectContaining({ id: 'c0' })],
      sourceEligibilityCapturedFields: [
        expect.objectContaining({ id: 'source-field:locationNotes' }),
        expect.objectContaining({ id: 'source-field:workMode' }),
      ],
    });
    expect(
      sourceEligibilityContextFromCapturedSource(
        {
          sourceText,
          sourceContentFingerprint,
          sourceContentVersion: 1,
        },
        JSON.stringify({ ...content, locationNotes: 'Remote in Canada only' }),
      ),
    ).toBeUndefined();
  });

  it('resolves a captured ATS field only when it is the exact offered witness', () => {
    const content = {
      descriptionRaw: sourceText,
      locationNotes: 'Canada (Remote)',
      workMode: 'remote',
    };
    const context = sourceEligibilityContextFromCapturedSource(
      {
        sourceText,
        sourceContentFingerprint: fingerprintOpportunitySourceContent(content),
        sourceContentVersion: 1,
      },
      JSON.stringify(content),
    )!;
    const prepared = prepareSourceEligibilityEvidenceAudit({
      clauses: [
        {
          id: 'clause:canonical-body',
          start: 0,
          end: sourceText.length,
          text: sourceText,
        },
      ],
      context,
      offers: [
        {
          kind: 'work_country_allowed',
          country: CA,
          clauseIds: [],
          capturedFieldIds: ['source-field:locationNotes'],
        },
        {
          kind: 'remote_available',
          clauseIds: [],
          capturedFieldIds: ['source-field:workMode'],
        },
        { kind: 'sponsorship_offered', clauseIds: ['clause:canonical-body'] },
      ],
    });
    const answers = Object.fromEntries(
      Object.keys(prepared.request.questions).map((key) => {
        if (key.endsWith('__evidence')) {
          const choice = key.includes('work_country_allowed')
            ? 'source-field:locationNotes'
            : key.includes('remote_available')
              ? 'source-field:workMode'
              : 'c0';
          return [key, { type: 'choice', choice, confidence: 0.96 }];
        }
        return [key, { type: 'predicate', probability: 0.96 }];
      }),
    );
    const resolved = resolveSourceEligibilityEvidenceAudit(
      prepared,
      {
        answers: answers as never,
        model: 'jev-test',
        provenance: { model: 'jev-test', provider: 'typesafe' },
      },
      'request:captured',
    );
    expect(resolved.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          citations: [
            expect.objectContaining({
              path: 'sourceContentJson.locationNotes',
              source: 'captured_field',
            }),
          ],
        }),
      ]),
    );
    expect(resolved.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'sponsorship_offered',
          citations: [
            expect.objectContaining({ clauseId: 'clause:canonical-body' }),
          ],
        }),
      ]),
    );
    expect(validateSourceEligibilityEvidence(context, resolved)).toBe(true);
    const metadataOnlyChange = {
      ...content,
      // Source-content fingerprint normalization preserves this whitespace,
      // while the exact captured-field hash must still invalidate evidence.
      locationNotes: 'Canada  (Remote)',
    };
    const changedContext = sourceEligibilityContextFromCapturedSource(
      {
        sourceText,
        sourceContentFingerprint: fingerprintOpportunitySourceContent(content),
        sourceContentVersion: 1,
      },
      JSON.stringify(metadataOnlyChange),
    );
    expect(changedContext).toBeDefined();
    expect(validateSourceEligibilityEvidence(changedContext!, resolved)).toBe(
      false,
    );
  });

  it('rejects partial captured metadata instead of falling back to V3', () => {
    const clauses = [
      { id: 'c0', start: 0, end: sourceText.length, text: sourceText },
    ];
    const legacy = prepareSourceEligibilityEvidenceAudit({
      clauses,
      context: current,
      offers: [],
    });
    expect(legacy.auditVersion).toBe('source-eligibility-audit/v3');
    expect(() =>
      prepareSourceEligibilityEvidenceAudit({
        clauses,
        context: { ...current, capturedFields: [] },
        offers: [],
      }),
    ).toThrow('Captured ATS eligibility fields must be exact and current');
  });

  it('nominates only exact public country labels, maps UK to GB, and fails coverage closed on country overflow', () => {
    const clauses = [
      {
        id: 'c0',
        start: 0,
        end: sourceText.length,
        text: sourceText,
      },
    ];
    const nominations = nominateSourceEligibilityFactOffers(clauses);
    expect(
      nominations.offers.some(
        (offer) =>
          offer.kind === 'work_country_allowed' && offer.country?.code === 'CA',
      ),
    ).toBe(true);
    const uk = 'Remote in the UK.';
    const ukNominations = nominateSourceEligibilityFactOffers([
      { id: 'c0', start: 0, end: uk.length, text: uk },
    ]);
    expect(
      ukNominations.offers.some(
        (offer) =>
          offer.kind === 'work_country_allowed' && offer.country?.code === 'GB',
      ),
    ).toBe(true);
    const overflowText =
      'Canada United States United Kingdom Australia Germany Japan Remote.';
    const prepared = prepareCanonicalSourceEligibilityEvidenceAudit({
      clauses: [
        { id: 'c0', start: 0, end: overflowText.length, text: overflowText },
      ],
      context: {
        sourceText: overflowText,
        sourceContentFingerprint: 'source:overflow',
        sourceContentVersion: 1,
      },
    });
    expect(prepared.countryOverflow).toBe(true);
  });

  it('requires an affirmative decision and a selected exact witness for every fact', () => {
    const clauses = [
      {
        id: 'c0',
        start: 0,
        end: sourceText.length,
        text: sourceText,
      },
    ];
    const prepared = prepareSourceEligibilityEvidenceAudit({
      clauses,
      context: current,
      offers: [
        { kind: 'work_country_allowed', country: CA, clauseIds: ['c0'] },
        { kind: 'remote_available', clauseIds: ['c0'] },
      ],
    });
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(prepared.request.questions)) {
      if (key.endsWith('__evidence')) {
        answers[key] = {
          type: 'choice',
          choice: key.includes('remote_available') ? 'none' : 'c0',
          confidence: 0.96,
        };
      } else {
        answers[key] = { type: 'predicate', probability: 0.96 };
      }
    }
    const resolved = resolveSourceEligibilityEvidenceAudit(
      prepared,
      {
        answers: answers as never,
        model: 'jev-test',
        provenance: { model: 'jev-test', provider: 'typesafe' },
      },
      'request:1',
    );
    expect(resolved.coverage).toEqual({
      authorization: true,
      geography: true,
      workArrangement: true,
    });
    expect(resolved.facts.map((item) => item.key)).toEqual([
      'source_eligibility__work_country_allowed__CA',
    ]);
    expect(resolved.facts[0]?.citations[0]).toMatchObject({
      clauseId: 'c0',
      start: 0,
      end: sourceText.length,
    });
    expect(() =>
      resolveSourceEligibilityEvidenceAudit(
        prepared,
        {
          answers: {
            ...answers,
            source_eligibility__remote_available__evidence: {
              type: 'choice',
              choice: 'invented-clause',
              confidence: 0.99,
            },
          } as never,
          model: 'jev-test',
          provenance: { model: 'jev-test', provider: 'typesafe' },
        },
        'request:1',
      ),
    ).toThrow('unoffered clause');
  });

  it('rejects non-lossless clauses and unoffered witness selections before a fact can resolve', () => {
    expect(() =>
      prepareSourceEligibilityEvidenceAudit({
        clauses: [
          {
            id: 'c0',
            start: 0,
            end: 'Remote'.length,
            text: 'Remote',
          },
        ],
        context: current,
        offers: [],
      }),
    ).toThrow('losslessly cover');
  });

  it('requires exact current source citations and a reserved fact key', () => {
    const value = evidence([
      fact('work_country_allowed', { country: CA }),
      fact('remote_available'),
    ]);
    expect(validateSourceEligibilityEvidence(current, value)).toBe(true);
    expect(
      validateSourceEligibilityEvidence(current, {
        ...value,
        facts: [{ ...value.facts[0], key: 'source_eligibility__forged' }],
      }),
    ).toBe(false);
    expect(
      validateSourceEligibilityEvidence(current, {
        ...value,
        facts: [
          {
            ...value.facts[0],
            citations: [
              { ...value.facts[0].citations[0], hash: 'f'.repeat(64) },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it('fails closed in the verified reader when evidence no longer matches current source', () => {
    const value = evidence([
      fact('work_country_allowed', { country: CA }),
      fact('remote_available'),
    ]);
    expect(
      projectVerifiedSourceEligibility({
        candidate: candidate({
          authorizedWorkCountries: [{ country: CA, scope: 'country' }],
        }),
        evidence: value,
        sourceContext: { ...current, sourceContentVersion: 2 },
      }).verdict,
    ).toBe('unknown');
  });

  it('does not let sponsorship denial override verified target-country authorization', () => {
    const result = projectSourceEligibility(
      evidence([
        fact('work_country_allowed', { country: CA }),
        fact('remote_available'),
        fact('sponsorship_denied', {
          citations: [citation('No visa sponsorship.')],
        }),
      ]),
      candidate({
        authorizedWorkCountries: [{ country: CA, scope: 'country' }],
        sponsorshipRequired: true,
      }),
    );
    expect(result.verdict).toBe('eligible_without_sponsorship');
  });

  it('does not infer authorization from citizenship', () => {
    expect(
      projectSourceEligibility(
        evidence([
          fact('work_country_allowed', { country: CA }),
          fact('remote_available'),
        ]),
        candidate({ citizenships: [CA] }),
      ).verdict,
    ).toBe('unknown');
  });

  it('allows an explicitly Canada-remote role for a country-authorized profile without a visa statement', () => {
    expect(
      projectSourceEligibility(
        evidence([
          fact('work_country_allowed', { country: CA }),
          fact('remote_available'),
        ]),
        candidate({
          authorizedWorkCountries: [{ country: CA, scope: 'country' }],
        }),
      ).verdict,
    ).toBe('eligible_without_sponsorship');
  });

  it('does not treat a country listing as proof that the role is remote', () => {
    expect(
      projectSourceEligibility(
        evidence([fact('work_country_allowed', { country: CA })]),
        candidate({
          authorizedWorkCountries: [{ country: CA, scope: 'country' }],
        }),
      ).verdict,
    ).toBe('unknown');
  });

  it('does not infer that omitted local or work-arrangement restrictions are absent', () => {
    const incomplete = evidence([
      fact('work_country_allowed', { country: CA }),
      fact('remote_available'),
    ]);
    incomplete.coverage.workArrangement = false;
    expect(
      projectSourceEligibility(
        incomplete,
        candidate({
          authorizedWorkCountries: [{ country: CA, scope: 'country' }],
        }),
      ).verdict,
    ).toBe('unknown');
  });

  it('keeps local, timezone, and onsite/hybrid constraints unresolved until a typed profile adapter satisfies them', () => {
    const constrained = evidence([
      fact('work_country_allowed', { country: CA }),
      fact('remote_available'),
      fact('constraint', {
        constraint: 'subnational_location',
        citations: [citation('Toronto hybrid role with Pacific time overlap.')],
      }),
      fact('constraint', {
        constraint: 'work_arrangement',
        citations: [citation('Toronto hybrid role with Pacific time overlap.')],
      }),
    ]);
    const authorized = candidate({
      authorizedWorkCountries: [{ country: CA, scope: 'country' }],
    });
    const blocked = projectSourceEligibility(constrained, authorized);
    expect(blocked.verdict).toBe('unknown');
    expect(blocked.unresolvedConstraintFactKeys).toHaveLength(2);
    expect(
      projectSourceEligibility(constrained, authorized, {
        satisfiedConstraintFactKeys: constrained.facts
          .filter((item) => item.kind === 'constraint')
          .map((item) => item.key),
      }).verdict,
    ).toBe('eligible_without_sponsorship');
  });

  it('classifies an explicit different required country as a location restriction', () => {
    expect(
      projectSourceEligibility(
        evidence([fact('work_country_required', { country: US })]),
        candidate(),
      ).verdict,
    ).toBe('location_restriction');
  });

  it('keeps a cited sponsorship path when a different country remains restrictive', () => {
    const result = projectSourceEligibility(
      evidence([
        fact('work_country_required', { country: US }),
        fact('sponsorship_offered', {
          citations: [citation('Visa sponsorship offered.')],
        }),
      ]),
      candidate(),
    );
    expect(result.verdict).toBe('location_restriction');
    expect(result.conditionalPaths).toEqual([
      expect.objectContaining({
        kind: 'sponsorship',
        status: 'offered',
        facts: [
          expect.objectContaining({
            key: 'source_eligibility__sponsorship_offered',
            citations: [
              expect.objectContaining({ clauseId: expect.any(String) }),
            ],
          }),
        ],
      }),
    ]);
  });

  it('uses sponsorship only when the verified profile says it is needed', () => {
    const value = evidence([
      fact('work_country_allowed', { country: CA }),
      fact('remote_available'),
      fact('sponsorship_offered', {
        citations: [citation('Visa sponsorship offered.')],
      }),
    ]);
    expect(
      projectSourceEligibility(value, candidate({ sponsorshipRequired: true }))
        .verdict,
    ).toBe('sponsorship_possible');
    expect(projectSourceEligibility(value, candidate()).verdict).toBe(
      'unknown',
    );
  });

  it('fails closed on conflicting sponsorship or contradictory country authorization facts', () => {
    expect(
      projectSourceEligibility(
        evidence([
          fact('work_country_allowed', { country: CA }),
          fact('remote_available'),
          fact('sponsorship_offered', {
            citations: [citation('Visa sponsorship offered.')],
          }),
          fact('sponsorship_denied', {
            citations: [citation('No visa sponsorship.')],
          }),
        ]),
        candidate(),
      ).verdict,
    ).toBe('conflicting');
    expect(
      projectSourceEligibility(
        evidence([
          fact('work_country_allowed', { country: CA }),
          fact('remote_available'),
          fact('existing_authorization_required', { country: US }),
        ]),
        candidate(),
      ).verdict,
    ).toBe('conflicting');
  });
});

describe('country reference normalization', () => {
  it('accepts explicit alpha-2 profile/source values but never treats a city as a country', async () => {
    const { countryReferenceFromCode } = await import('./country-reference.js');
    expect(countryReferenceFromCode('ca')).toMatchObject({ code: 'CA' });
    expect(countryReferenceFromCode('Toronto')).toBeUndefined();
  });
});
