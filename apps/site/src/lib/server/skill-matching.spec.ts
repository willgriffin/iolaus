import type { DecisionResult } from '@happyvertical/ai';
import { describe, expect, it } from 'vitest';
import { clearAcceptScoringFixture } from './fixtures/opportunity-scoring.js';
import {
  buildBoundedOpportunityScoringRequest,
  preScoreOpportunity,
} from './opportunity-scoring.js';
import {
  canonicalSkill,
  prepareSkillMatching,
  resolveSkillMatching,
} from './skill-matching.js';

const source = (text: string, kind = 'resume_skill', id = 's1') => ({
  id,
  text,
  title: text,
  kind,
});
const answer = (
  probability = 0.97,
  choice = 'candidate_0',
  confidence = 0.98,
): DecisionResult => ({
  model: 'jev-test',
  provenance: { provider: 'typesafe', model: 'jev-test' },
  answers: {
    match_0: { type: 'predicate', probability },
    source_0: {
      type: 'choice',
      choice,
      confidence,
      probabilities: { [choice]: confidence },
    },
  },
});
describe('skill matching', () => {
  it.each([
    ['Postgres', 'PostgreSQL'],
    ['k8s', 'Kubernetes'],
    ['Node.js', 'nodejs'],
    ['Golang', 'Go'],
  ])('normalizes %s and %s', (a, b) => {
    expect(canonicalSkill(a)).toBe(canonicalSkill(b));
    const prepared = prepareSkillMatching([a], [source(b)]);
    expect(prepared.request.questions).toEqual({});
    expect(resolveSkillMatching(prepared).matches[0].status).toBe('supported');
  });
  it.each([
    ['Java', 'JavaScript'],
    ['C', 'C++'],
    ['React', 'React Native'],
    ['5 years PostgreSQL', 'PostgreSQL'],
  ])('does not assert %s from %s', (a, b) => {
    expect(
      resolveSkillMatching(prepareSkillMatching([a], [source(b)])).matches[0]
        .status,
    ).toBe('uncertain');
  });
  it('binds each question to its requirement even when order changes', () => {
    for (const requirements of [
      ['Production Kubernetes operations', 'Ten years Kubernetes operations'],
      ['Ten years Kubernetes operations', 'Production Kubernetes operations'],
    ]) {
      const prepared = prepareSkillMatching(requirements, [
        source(
          'Operated Kubernetes in production for four years',
          'achievement',
        ),
      ]);
      requirements.forEach((requirement, index) => {
        for (const prefix of ['match', 'source']) {
          expect(
            prepared.request.questions[`${prefix}_${index}`].instructions,
          ).toContain(JSON.stringify(requirement));
        }
      });
      expect(prepared.exact.every((matches) => matches.length === 0)).toBe(
        true,
      );
    }
  });
  it('preserves evidence kind so declared skills can establish capabilities', () => {
    const prepared = prepareSkillMatching(
      ['server-side JavaScript services'],
      [source('Node.js'), source('Built Node.js APIs', 'achievement', 'a1')],
    );
    expect(prepared.request.state).toMatchObject({
      candidates: [
        { key: 'candidate_0', kind: 'resume_skill', text: 'Node.js' },
        { key: 'candidate_1', kind: 'achievement', text: 'Built Node.js APIs' },
      ],
    });
  });
  it('attributes semantic support to the selected candidate source', () => {
    const prepared = prepareSkillMatching(
      ['server-side JavaScript services'],
      [source('Built Node.js APIs', 'achievement')],
    );
    expect(resolveSkillMatching(prepared, answer())).toMatchObject({
      provenance: { model: 'jev-test' },
      matches: [
        {
          status: 'supported',
          sourceKeys: ['achievement:s1'],
          probability: 0.97,
        },
      ],
    });
  });
  it.each([
    [0.5, 'candidate_0', 0.99],
    [0.99, 'candidate_0', 0.5],
    [0.99, 'none', 0.99],
    [0.01, 'uncertain', 0.99],
  ])('keeps ambiguous/disagreeing answers uncertain', (p, choice, confidence) => {
    const prepared = prepareSkillMatching(['Java'], [source('JavaScript')]);
    expect(
      resolveSkillMatching(
        prepared,
        answer(Number(p), String(choice), Number(confidence)),
      ).matches[0].status,
    ).toBe('uncertain');
  });
  it('records a gap only with confident negative evidence', () => {
    const prepared = prepareSkillMatching(['Java'], [source('JavaScript')]);
    expect(
      resolveSkillMatching(prepared, answer(0.01, 'none')).matches[0].status,
    ).toBe('gap');
  });
  it('does not treat excluded candidate context as a confident gap', () => {
    const prepared = prepareSkillMatching(
      ['Java'],
      Array.from({ length: 81 }, (_, i) =>
        source(`skill-${i}`, 'resume_skill', String(i)),
      ),
    );
    expect(
      resolveSkillMatching(prepared, answer(0.01, 'none')).matches[0].status,
    ).toBe('uncertain');
  });
  it('does not call truncated experience a confident gap', () => {
    const prepared = prepareSkillMatching(
      ['Java'],
      [source('x'.repeat(200), 'achievement')],
    );
    expect(
      resolveSkillMatching(prepared, answer(0.01, 'none')).matches[0].status,
    ).toBe('uncertain');
  });
  it('does not use employer research as candidate evidence', () => {
    expect(
      prepareSkillMatching(['Python'], [source('Python', 'company_research')])
        .candidates,
    ).toEqual([]);
  });
  it('rejects missing, malformed and unknown answers', () => {
    const prepared = prepareSkillMatching(['Java'], [source('JavaScript')]);
    for (const invalid of [
      { ...answer(), answers: {} },
      answer(NaN),
      answer(1.1),
      answer(0.99, 'candidate_999'),
      answer(0.99, 'candidate_0', -1),
    ]) {
      expect(() => resolveSkillMatching(prepared, invalid)).toThrow();
    }
  });
  it('invalidates fingerprints when candidate evidence changes', () => {
    expect(
      prepareSkillMatching(['Python'], [source('Python')]).fingerprint,
    ).not.toBe(prepareSkillMatching(['Python'], [source('Java')]).fingerprint);
  });
  it('feeds semantic decisions into scoring before reject gates', async () => {
    const fixture = clearAcceptScoringFixture;
    const evidenceSources = [
      source(
        'Built typed JavaScript apps with a relational database',
        'achievement',
      ),
    ];
    const prepared = prepareSkillMatching(
      ['TypeScript', 'PostgreSQL'],
      evidenceSources,
    );
    const result = answer();
    result.answers.match_1 = result.answers.match_0;
    result.answers.source_1 = result.answers.source_0;
    const request = await buildBoundedOpportunityScoringRequest({
      ...fixture,
      evidenceSources,
      skillMatching: resolveSkillMatching(prepared, result),
      model: 'test',
      inputTokenCeiling: 4000,
      counter: async () => 100,
    });
    expect(request.input.signals.supportedRequiredCount).toBe(2);
    expect(preScoreOpportunity(request.input).kind).toBe('clear_accept');
    expect(request.evidenceMatrix[0].sources[0].id).toBe('s1');
  });
  it('does not reject requirements with uncertain matches', async () => {
    const fixture = clearAcceptScoringFixture;
    const prepared = prepareSkillMatching(
      ['TypeScript', 'PostgreSQL'],
      [source('Rust')],
    );
    const request = await buildBoundedOpportunityScoringRequest({
      ...fixture,
      skillMatching: resolveSkillMatching(prepared),
      model: 'test',
      inputTokenCeiling: 4000,
      counter: async () => 100,
    });
    expect(preScoreOpportunity(request.input).kind).toBe('missing_evidence');
  });
});
