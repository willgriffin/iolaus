import type { DecisionResult } from '@happyvertical/ai';
import { describe, expect, it } from 'vitest';
import { assessmentDecisionOutputTokenCeiling } from './opportunity-assessment.js';
import {
  OPPORTUNITY_SCREENING_MAX_OUTPUT_TOKENS,
  OPPORTUNITY_SCREENING_MAX_REQUEST_BYTES,
  OPPORTUNITY_SCREENING_V1_VERSION,
  OPPORTUNITY_SCREENING_VERSION,
  type OpportunityScreeningDimension,
  OpportunityScreeningPreparationError,
  type OpportunityScreeningVersion,
  type PreparedOpportunityScreening,
  prepareOpportunityScreening,
  resolveOpportunityScreening,
} from './opportunity-screening.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const profile = {
  targetWorkCountryJson: JSON.stringify({ code: 'CA', label: 'Canada' }),
  authorizedWorkCountriesJson: JSON.stringify([
    { country: { code: 'CA', label: 'Canada' }, scope: 'country' },
  ]),
  sponsorshipRequired: false,
  preferencesJson: JSON.stringify({
    targetRoles: ['Software engineer'],
    workModes: ['remote'],
  }),
};
function prepare(
  body = 'Build software for an accounting platform.',
  extras: Record<string, unknown> = {},
  version: OpportunityScreeningVersion = OPPORTUNITY_SCREENING_VERSION,
) {
  const source = {
    descriptionRaw: body,
    title: 'Software engineer',
    locationNotes: 'Canada',
    workMode: 'remote',
    ...extras,
  };
  return prepareOpportunityScreening(
    {
      sourceContentJson: JSON.stringify(source),
      sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
      sourceContentVersion: 2,
      profile,
    },
    { version },
  );
}
function distribution(
  prepared: PreparedOpportunityScreening,
  selected = 'none',
) {
  const keys = [...prepared.witnesses.map((witness) => witness.id), 'none'];
  return Object.fromEntries(
    keys.map((key) => [key, key === selected ? 0.9 : 0.1 / (keys.length - 1)]),
  );
}
function answers(
  prepared: PreparedOpportunityScreening,
  positive: Partial<Record<OpportunityScreeningDimension, string>> = {},
): DecisionResult {
  const result: DecisionResult = {
    model: 'jev-fixture',
    provenance: { provider: 'typesafe', model: 'jev-fixture' },
    answers: {},
  };
  for (const [key, question] of Object.entries(prepared.request.questions)) {
    if (question.type === 'predicate')
      result.answers[key] = {
        type: 'predicate',
        probability: positive[key as OpportunityScreeningDimension] ? 0.9 : 0.1,
      };
    else
      result.answers[key] = {
        type: 'choice',
        choice:
          positive[
            key.replace('__evidence', '') as OpportunityScreeningDimension
          ] ?? 'none',
        confidence: 0.9,
        probabilities: distribution(
          prepared,
          positive[
            key.replace('__evidence', '') as OpportunityScreeningDimension
          ] ?? 'none',
        ),
      };
  }
  return result;
}
function resolve(
  prepared: PreparedOpportunityScreening,
  positive: Partial<Record<OpportunityScreeningDimension, string>> = {},
) {
  return resolveOpportunityScreening(
    prepared,
    answers(prepared, positive),
    'real-governed-fixture-request',
  );
}

describe('JEV-first coarse opportunity screening', () => {
  it('offers lossless contiguous body groups and immutable ATS fields once in a fixed bounded request', () => {
    const body = 'First literal line.\n\n  Second literal line.\r\nThird line.';
    const prepared = prepare(body);
    expect(Object.keys(prepared.request.questions)).toHaveLength(14);
    expect(prepared.maxOutputTokens).toBe(
      assessmentDecisionOutputTokenCeiling(prepared.request),
    );
    expect(OPPORTUNITY_SCREENING_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(OPPORTUNITY_SCREENING_MAX_REQUEST_BYTES).toBe(32_768);
    expect(prepared.version).toBe(OPPORTUNITY_SCREENING_VERSION);
    expect(prepared.requestBytes).toBe(
      Buffer.byteLength(JSON.stringify(prepared.request), 'utf8'),
    );
    for (const witness of prepared.witnesses.filter(
      (w) => w.path === 'sourceContentJson.descriptionRaw',
    ))
      expect(body.slice(witness.spanStart, witness.spanEnd)).toBe(witness.text);
    expect(
      prepared.witnesses
        .filter((w) => w.path === 'sourceContentJson.descriptionRaw')
        .map((w) => w.text)
        .join(''),
    ).toBe(body);
    for (const question of Object.values(prepared.request.questions))
      if (question.type === 'choice')
        expect(Object.keys(question.criteria)).toEqual([
          ...prepared.witnesses.map((w) => w.id),
          'none',
        ]);
    expect(
      prepared.witnesses.filter((w) => w.path === 'sourceContentJson.title'),
    ).toEqual([
      {
        id: 't',
        path: 'sourceContentJson.title',
        text: 'Software engineer',
      },
    ]);
  });
  it('preserves every literal code unit over dense lines with bounded full choice vectors', () => {
    const body = `\r\n  \tLeading whitespace.\r${Array.from(
      { length: 160 },
      (_, index) => `Repeated literal line 😀 ${index % 3}.\r\n\n`,
    ).join('')}\tTrailing whitespace.\n\r\n`;
    const prepared = prepare(body);
    const groups = prepared.witnesses.filter(
      (w) => w.path === 'sourceContentJson.descriptionRaw',
    );
    expect(groups.length).toBeLessThanOrEqual(16);
    expect(prepared.witnesses.length).toBeLessThanOrEqual(19);
    expect(prepared.maxOutputTokens).toBe(2251);
    expect(prepared.requestBytes).toBeLessThanOrEqual(32_768);
    expect(groups.map((w) => w.text).join('')).toBe(body);
    let end = 0;
    for (const witness of groups) {
      expect(witness.spanStart).toBe(end);
      expect(body.slice(witness.spanStart, witness.spanEnd)).toBe(witness.text);
      end = witness.spanEnd!;
    }
    expect(end).toBe(body.length);
    expect(() => prepare(body, {}, OPPORTUNITY_SCREENING_V1_VERSION)).toThrow(
      'lossless screening witness bound',
    );
    expect(Object.keys(prepared.request.questions)).toHaveLength(14);
    expect(
      (
        prepared.request.state as {
          Source: Array<{ id: string; text: string }>;
        }
      ).Source,
    ).toEqual(prepared.witnesses.map(({ id, text }) => ({ id, text })));
    expect(
      prepared.witnesses
        .filter((w) => w.id === 't' || w.id === 'l' || w.id === 'w')
        .map((w) => w.id),
    ).toEqual(['t', 'l', 'w']);
    const result = answers(prepared, { role_relevant: 't' });
    for (const answer of Object.values(result.answers))
      if (answer.type === 'choice') {
        expect(Object.keys(answer.probabilities)).toEqual([
          ...prepared.witnesses.map((w) => w.id),
          'none',
        ]);
        expect(
          Object.values(answer.probabilities).reduce((sum, n) => sum + n, 0),
        ).toBeCloseTo(1);
      }
    expect(
      resolveOpportunityScreening(prepared, result, 'actual-dense-request')
        .status,
    ).toBe('potentially_relevant');
  });
  it('keeps a long indivisible line whole rather than cutting or omitting its material', () => {
    const body = `\n${'literal 😀 '.repeat(1600)}\r\n`;
    const prepared = prepare(body);
    const groups = prepared.witnesses.filter(
      (w) => w.path === 'sourceContentJson.descriptionRaw',
    );
    expect(groups).toHaveLength(2);
    expect(groups[1]?.text).toBe(body.slice(1));
    expect(groups.map((w) => w.text).join('')).toBe(body);
    expect(() => prepare('literal '.repeat(5000))).toThrow(
      'lossless screening request bound',
    );
  });
  it('replays historical V1 full choice distributions: 43 witnesses admit, 44 hold without truncation', () => {
    const body = Array.from(
      { length: 40 },
      (_, index) => `Exact source line ${index}.`,
    ).join('\n');
    const prepared = prepare(body, {}, OPPORTUNITY_SCREENING_V1_VERSION);
    expect(prepared.version).toBe(OPPORTUNITY_SCREENING_V1_VERSION);
    expect(prepared.witnesses).toHaveLength(43);
    expect(prepared.maxOutputTokens).toBe(4043);
    expect(prepared.maxOutputTokens).toBe(
      assessmentDecisionOutputTokenCeiling(prepared.request),
    );
    expect(() =>
      prepare(
        `${body}\nOne further exact source line.`,
        {},
        OPPORTUNITY_SCREENING_V1_VERSION,
      ),
    ).toThrow('Full screening choice distributions');
    const result = answers(prepared, { role_relevant: 'field:title' });
    for (const [key, answer] of Object.entries(result.answers))
      if (answer.type === 'choice')
        expect(Object.keys(answer.probabilities)).toHaveLength(44);
    expect(
      resolveOpportunityScreening(prepared, result, 'actual-boundary-request')
        .status,
    ).toBe('potentially_relevant');
    const grouped = prepare(body);
    expect(grouped.witnesses.length).toBeLessThanOrEqual(19);
    expect(grouped.maxOutputTokens).toBeLessThanOrEqual(2251);
    expect(grouped.inputFingerprint).not.toBe(prepared.inputFingerprint);
    expect(grouped.profileFingerprint).toBe(prepared.profileFingerprint);
    expect(grouped.sourceIdentity).toEqual(prepared.sourceIdentity);
    expect(
      prepare(`${body}\nOne further exact source line.`).maxOutputTokens,
    ).toBeLessThanOrEqual(2251);
    const changed = structuredClone(prepared);
    changed.version = OPPORTUNITY_SCREENING_VERSION;
    expect(() =>
      resolveOpportunityScreening(changed, result, 'actual-version-tamper'),
    ).toThrow('modified');
    expect(() =>
      prepare(
        body,
        {},
        'opportunity-screening/invented' as OpportunityScreeningVersion,
      ),
    ).toThrow('Unsupported screening material version');
    changed.version =
      'opportunity-screening/invented' as OpportunityScreeningVersion;
    expect(() =>
      resolveOpportunityScreening(changed, result, 'actual-unknown-version'),
    ).toThrow('Unsupported screening material version');
  });
  it('routes source-backed software duties at an accounting company as potentially relevant', () => {
    const prepared = prepare();
    expect(resolve(prepared, { role_relevant: 's0' }).status).toBe(
      'potentially_relevant',
    );
    const text = prepared.request.questions.role_mismatch?.instructions;
    expect(
      typeof text === 'string' &&
        text.includes(
          'software work at an accounting company is not accountant work',
        ),
    ).toBe(true);
  });
  it('retains a clear source-backed accountant-duty mismatch separately from missing skills', () => {
    const prepared = prepare(
      'Prepare tax returns and financial statements as an accountant.',
    );
    expect(resolve(prepared, { role_mismatch: 's0' })).toMatchObject({
      status: 'clear_mismatch',
      mismatches: ['role_mismatch'],
      evidence: [
        {
          witness: {
            text: 'Prepare tax returns and financial statements as an accountant.',
          },
        },
      ],
    });
  });
  it('does not fail high-confidence incompatibility lacking an offered high-confidence witness', () => {
    const prepared = prepare();
    const result = answers(prepared);
    result.answers.role_mismatch = { type: 'predicate', probability: 0.99 };
    expect(
      resolveOpportunityScreening(prepared, result, 'actual-id'),
    ).toMatchObject({
      status: 'uncertain',
      mismatches: [],
      uncertainties: ['uncited_role_mismatch'],
    });
    result.answers.role_mismatch__evidence = {
      type: 'choice',
      choice: 's0',
      confidence: 0.84,
      probabilities: distribution(prepared, 's0'),
    };
    expect(
      resolveOpportunityScreening(prepared, result, 'actual-id').status,
    ).toBe('uncertain');
    result.answers.role_mismatch = { type: 'predicate', probability: 0.84 };
    expect(
      resolveOpportunityScreening(prepared, result, 'actual-id').mismatches,
    ).toEqual([]);
  });
  it('keeps a cited sponsorship path when the primary country is incompatible', () => {
    const prepared = prepare(
      'This role is United States only. Employer sponsorship is offered.',
    );
    const result = resolve(prepared, {
      country_mismatch: 's0',
      sponsorship_path: 's0',
      role_relevant: 't',
    });
    expect(result.status).toBe('uncertain');
    expect(result.mismatches).toEqual(['country_mismatch']);
    expect(result.conditionalPaths).toEqual([
      { kind: 'offered_sponsorship', witness: prepared.witnesses[0] },
    ]);
    expect(result.uncertainties).toContain(
      'sponsorship_path_requires_user_decision',
    );
  });
  it('does not infer sponsorship paths, authorization or relocation from silence or citizenship', () => {
    const prepared = prepare();
    const native = {
      ...profile,
      authorizedWorkCountriesJson: '[]',
      citizenshipsJson: JSON.stringify([
        { code: 'US', label: 'United States' },
      ]),
      phone: 'secret',
      summary: 'irrelevant',
      demographicsJson: 'secret',
    };
    const next = prepareOpportunityScreening({
      sourceContentJson: prepared.sourceContentJson,
      ...prepared.sourceIdentity,
      profile: native,
    });
    expect(next.profile.authorizedWorkCountries).toEqual([]);
    expect(JSON.stringify(next.request)).not.toMatch(
      /citizenship|secret|demographics|phone/,
    );
    expect(resolve(next, { authorization_mismatch: 's0' }).mismatches).toEqual(
      [],
    );
    expect(resolve(next).conditionalPaths).toEqual([]);
  });
  it('holds province/timezone/onsite ambiguity and conditional authorization as uncertainty', () => {
    const prepared = prepare(
      'Remote only for residents of British Columbia in Pacific time.',
    );
    expect(
      resolve(prepared, {
        role_relevant: 't',
        unresolved_constraint: 's0',
      }).status,
    ).toBe('uncertain');
    const conditional = prepareOpportunityScreening({
      sourceContentJson: prepared.sourceContentJson,
      ...prepared.sourceIdentity,
      profile: {
        ...profile,
        sponsorshipRequired: true,
        authorizedWorkCountriesJson: JSON.stringify([
          {
            country: { code: 'CA', label: 'Canada' },
            scope: 'employer_limited',
          },
        ]),
      },
    });
    expect(
      resolve(conditional, { authorization_mismatch: 's0' }),
    ).toMatchObject({ status: 'uncertain', mismatches: [] });
  });
  it('never promotes conflicting role evidence or missing explicit preferences', () => {
    const prepared = prepare();
    expect(
      resolve(prepared, { role_relevant: 's0', role_mismatch: 's0' }).status,
    ).toBe('uncertain');
    const missing = prepareOpportunityScreening({
      sourceContentJson: prepared.sourceContentJson,
      ...prepared.sourceIdentity,
      profile: { citizenshipsJson: '[]' },
    });
    expect(
      resolve(missing, {
        role_relevant: 's0',
        country_mismatch: 's0',
        work_mode_mismatch: 's0',
      }),
    ).toMatchObject({ status: 'uncertain', mismatches: [] });
  });
  it('treats canonical empty profile fields as unknown rather than invalid context', () => {
    const base = prepare();
    const prepared = prepareOpportunityScreening({
      sourceContentJson: base.sourceContentJson,
      ...base.sourceIdentity,
      profile: {
        targetWorkCountryJson: '{}',
        authorizedWorkCountriesJson: '[]',
        preferencesJson: '{}',
      },
    });
    const result = resolve(prepared);
    expect(result.status).toBe('uncertain');
    expect(result.uncertainties).toContain('target_country_missing');
    expect(result.holdReasons).toContain('target_roles_missing');
    const plausible = prepareOpportunityScreening({
      sourceContentJson: base.sourceContentJson,
      ...base.sourceIdentity,
      profile: {
        targetWorkCountryJson: '{}',
        authorizedWorkCountriesJson: '[]',
        preferencesJson: JSON.stringify({ targetRoles: ['Software engineer'] }),
      },
    });
    const current = resolve(plausible, { role_relevant: 's0' });
    expect(current).toMatchObject({
      status: 'uncertain',
      plausiblyRelevant: true,
      holdReasons: [],
    });
  });
  it('normalizes native null preferences as missing without inferring the profile title', () => {
    const base = prepare();
    for (const preferencesJson of [null, 'null']) {
      const prepared = prepareOpportunityScreening({
        sourceContentJson: base.sourceContentJson,
        ...base.sourceIdentity,
        profile: { ...profile, preferencesJson, title: 'Software engineer' },
      });
      expect(prepared.profile.targetRoles).toEqual([]);
      expect(prepared.profile.workModes).toEqual([]);
      expect(resolve(prepared)).toMatchObject({
        status: 'uncertain',
        plausiblyRelevant: false,
      });
      expect(resolve(prepared).holdReasons).toContain('target_roles_missing');
      expect(prepared.profileFingerprint).not.toBe(base.profileFingerprint);
      expect(() =>
        prepareOpportunityScreening({
          sourceContentJson: base.sourceContentJson,
          ...base.sourceIdentity,
          profile: { ...profile, preferencesJson: 'malformed' },
        }),
      ).toThrow('valid object');
    }
  });
  it('binds exact captured metadata and relevant profile material while excluding unrelated fields', () => {
    const base = prepare();
    const changed = prepare(undefined, { locationNotes: 'United States' });
    expect(changed.sourceFingerprint).not.toBe(base.sourceFingerprint);
    const native = { ...profile, email: 'new@example.test' };
    const same = prepareOpportunityScreening({
      sourceContentJson: base.sourceContentJson,
      ...base.sourceIdentity,
      profile: native,
    });
    expect(same.profileFingerprint).toBe(base.profileFingerprint);
    expect(same.inputFingerprint).toBe(base.inputFingerprint);
    const other = prepareOpportunityScreening({
      sourceContentJson: base.sourceContentJson,
      ...base.sourceIdentity,
      profile: {
        ...profile,
        preferencesJson: JSON.stringify({
          targetRoles: ['Accountant'],
          workModes: ['onsite'],
        }),
      },
    });
    expect(other.inputFingerprint).not.toBe(base.inputFingerprint);
    expect(() =>
      prepareOpportunityScreening({
        sourceContentJson: changed.sourceContentJson,
        ...base.sourceIdentity,
        profile,
      }),
    ).toThrow(OpportunityScreeningPreparationError);
  });
  it('rejects missing/invalid context or oversized lossless input before invocation', () => {
    const base = prepare();
    for (const sourceContentJson of [
      '{}',
      'malformed',
      JSON.stringify({ title: 'Only title' }),
    ])
      expect(() =>
        prepareOpportunityScreening({
          sourceContentJson,
          ...base.sourceIdentity,
          profile,
        }),
      ).toThrow(OpportunityScreeningPreparationError);
    expect(() => prepare('x'.repeat(40_000))).toThrow(
      'lossless screening request bound',
    );
    expect(() =>
      prepareOpportunityScreening({
        sourceContentJson: base.sourceContentJson,
        ...base.sourceIdentity,
        profile: { ...profile, targetWorkCountryJson: 'broken' },
      }),
    ).toThrow('profile JSON');
    expect(() =>
      prepareOpportunityScreening({
        sourceContentJson: base.sourceContentJson,
        ...base.sourceIdentity,
        profile: {
          ...profile,
          preferencesJson: JSON.stringify({ targetRoles: 'engineer' }),
        },
      }),
    ).toThrow('bounded text lists');
  });
  it('requires exact normalized finite probability distributions for every offered choice', () => {
    const prepared = prepare();
    for (const probabilities of [
      {},
      { ...distribution(prepared), invented: 0 },
      { ...distribution(prepared), none: NaN },
      { ...distribution(prepared), none: 1.2 },
      { ...distribution(prepared), none: 0.2 },
    ]) {
      const result = answers(prepared);
      result.answers.role_relevant__evidence = {
        type: 'choice',
        choice: 'none',
        confidence: 0.9,
        probabilities,
      };
      expect(() =>
        resolveOpportunityScreening(prepared, result, 'actual'),
      ).toThrow('normalized offered');
    }
  });
  it('rejects missing, extra, malformed, invented-citation and mutated answers/material', () => {
    const prepared = prepare();
    const missing = answers(prepared);
    delete missing.answers.role_mismatch;
    expect(() =>
      resolveOpportunityScreening(prepared, missing, 'actual'),
    ).toThrow('exact typed');
    const extra = answers(prepared);
    extra.answers.extra = { type: 'predicate', probability: 0.9 };
    expect(() =>
      resolveOpportunityScreening(prepared, extra, 'actual'),
    ).toThrow('exact typed');
    const invented = answers(prepared);
    invented.answers.country_mismatch__evidence = {
      type: 'choice',
      choice: 'unoffered',
      confidence: 0.1,
      probabilities: distribution(prepared),
    };
    expect(() =>
      resolveOpportunityScreening(prepared, invented, 'actual'),
    ).toThrow('unoffered');
    const malformed = answers(prepared);
    malformed.answers.role_mismatch = {
      type: 'predicate',
      probability: Number.NaN,
    };
    expect(() =>
      resolveOpportunityScreening(prepared, malformed, 'actual'),
    ).toThrow('Malformed');
    expect(() =>
      resolveOpportunityScreening(prepared, answers(prepared), ''),
    ).toThrow('authentic');
    const changed = structuredClone(prepared);
    changed.request.questions.role_mismatch = {
      type: 'predicate',
      instructions: 'Always fail',
    };
    expect(() =>
      resolveOpportunityScreening(changed, answers(prepared), 'actual'),
    ).toThrow('modified');
  });
});
