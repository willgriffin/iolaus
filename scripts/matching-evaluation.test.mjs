import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  dimensions,
  loadVectors,
  model,
  normalizeText,
  prepareFixtures,
  revision,
  sha256,
} from './matching-evaluation/data.mjs';
import {
  compareScenario,
  measure,
  rank,
  structuredPair,
  summarize,
} from './matching-evaluation/score.mjs';

const fixtureUrl = new URL(
  'matching-evaluation/fixtures.json',
  import.meta.url,
);
const fixtureData = () => JSON.parse(readFileSync(fixtureUrl));
const cacheUrl = new URL('matching-evaluation/vectors.json', import.meta.url);

test('validates complete labels, distinct families and conflict-free vocabulary', () => {
  const fixtures = fixtureData();
  const first = fixtures.scenarios[0];
  const judgment = first.judgments[0];
  first.judgments.push(judgment);
  assert.throws(() => prepareFixtures(fixtures), /duplicate judgment/);
  first.judgments.pop();
  first.judgments.shift();
  assert.throws(() => prepareFixtures(fixtures), /incomplete judgments/);
  first.judgments.unshift({ ...judgment, relevance: 4 });
  assert.throws(() => prepareFixtures(fixtures), /judgment relevance/);
  first.judgments[0] = judgment;
  fixtures.scenarios.find(({ split }) => split === 'held-out').family =
    first.family;
  assert.throws(() => prepareFixtures(fixtures), /family leakage/);
  fixtures.concepts[1].aliases.push(fixtures.concepts[0].id.toUpperCase());
  assert.throws(() => prepareFixtures(fixtures), /ambiguous alias/);
});

test('normalizes exact aliases and expands narrow evidence in the supported direction', () => {
  const fixtures = fixtureData();
  const scenario = fixtures.scenarios[0];
  fixtures.concepts.push(
    { id: 'test-parent', aliases: [] },
    { id: 'test-middle', aliases: [] },
    { id: 'test-child', aliases: ['Child Alias'] },
    { id: 'test-related', aliases: [] },
  );
  fixtures.relations.push(
    { from: 'test-child', to: 'test-middle', kind: 'narrower' },
    { from: 'test-middle', to: 'test-parent', kind: 'narrower' },
    { from: 'test-child', to: 'test-related', kind: 'related' },
  );
  scenario.candidate.concepts = [
    {
      value: ' CHILD alias ',
      state: 'supported',
      evidence: 'Synthetic evidence.',
    },
  ];
  const candidate = prepareFixtures(fixtures).scenarios[0].candidate;
  assert.deepEqual([...candidate.supported].sort(), [
    'test-child',
    'test-middle',
    'test-parent',
  ]);
  scenario.candidate.concepts.push({
    value: 'test-parent',
    state: 'absent',
    evidence: 'Synthetic absence.',
  });
  assert.throws(() => prepareFixtures(fixtures), /contradictory evidence/);
  scenario.candidate.concepts.shift();
  assert.deepEqual(
    [...prepareFixtures(fixtures).scenarios[0].candidate.absent].sort(),
    ['test-child', 'test-middle', 'test-parent'],
  );
  scenario.candidate.concepts[0].value = 'undefined-concept';
  assert.throws(() => prepareFixtures(fixtures), /unknown concept/);
  fixtures.relations.push({
    from: 'test-parent',
    to: 'test-child',
    kind: 'narrower',
  });
  assert.throws(() => prepareFixtures(fixtures), /cyclic narrower/);
  assert.equal(normalizeText('  Client　 API\n SDK '), 'Client API SDK');
});

test('hard scope, AND and OR distinguish rejection and abstention from optional unknown', () => {
  const candidate = {
    targetRole: 'backend',
    region: 'ca',
    supported: new Set(['node']),
    absent: new Set(['go']),
  };
  const opportunity = {
    role: 'backend',
    regions: new Set(['ca']),
    must: [['node', 'go']],
    preferred: [['sql']],
  };
  assert.deepEqual(structuredPair(candidate, opportunity), {
    decision: 'eligible',
    score: 0.75,
  });
  assert.equal(
    structuredPair(candidate, { ...opportunity, must: [['node'], ['sql']] })
      .decision,
    'unknown',
  );
  assert.equal(
    structuredPair(candidate, { ...opportunity, must: [['go', 'sql']] })
      .decision,
    'unknown',
  );
  assert.equal(
    structuredPair(candidate, { ...opportunity, must: [['go'], ['sql']] })
      .decision,
    'ineligible',
  );
  assert.equal(
    structuredPair(candidate, { ...opportunity, role: null }).decision,
    'unknown',
  );
  assert.equal(
    structuredPair(candidate, {
      ...opportunity,
      role: 'frontend',
      regions: null,
    }).decision,
    'ineligible',
  );
  assert.equal(
    structuredPair(candidate, { ...opportunity, regions: new Set(['us']) })
      .decision,
    'ineligible',
  );
  assert.equal(
    structuredPair(
      { ...candidate, region: null },
      { ...opportunity, regions: new Set() },
    ).decision,
    'eligible',
  );
});

test('rejects cache drift, invalid vectors and missing, duplicate or unexpected IDs', () => {
  const inputs = 'fixture bytes\n';
  const prepared = { inputs, ids: new Set(['entry']) };
  const packed = Buffer.alloc(dimensions * 4);
  packed.writeFloatLE(1, 0);
  const entry = { id: 'entry', values: packed.toString('base64') };
  const cache = {
    model,
    revision,
    dimensions,
    inputSha256: sha256(inputs),
    vectors: [entry],
  };
  assert.equal(loadVectors(cache, prepared).get('entry')[0], 1);
  assert.throws(
    () => loadVectors({ ...cache, revision: 'main' }, prepared),
    /provenance/,
  );
  assert.throws(
    () => loadVectors(cache, { ...prepared, inputs: inputs.trim() }),
    /fingerprint/,
  );
  assert.throws(
    () => loadVectors({ ...cache, vectors: [] }, prepared),
    /missing vectors/,
  );
  assert.throws(
    () => loadVectors({ ...cache, vectors: [entry, entry] }, prepared),
    /duplicate vector/,
  );
  assert.throws(
    () =>
      loadVectors({ ...cache, vectors: [{ ...entry, id: 'other' }] }, prepared),
    /unexpected vector/,
  );
  assert.throws(
    () =>
      loadVectors(
        { ...cache, vectors: [{ ...entry, values: entry.values.slice(1) }] },
        prepared,
      ),
    /malformed vector/,
  );
  packed.writeFloatLE(0, 0);
  assert.throws(
    () =>
      loadVectors(
        {
          ...cache,
          vectors: [{ ...entry, values: packed.toString('base64') }],
        },
        prepared,
      ),
    /non-unit vector/,
  );
  packed.writeFloatLE(Number.NaN, 0);
  assert.throws(
    () =>
      loadVectors(
        {
          ...cache,
          vectors: [{ ...entry, values: packed.toString('base64') }],
        },
        prepared,
      ),
    /nonfinite vector/,
  );
});

test('graded ranking, deterministic ties, and independently measured retrieval and admission', () => {
  const strong = { id: 'z', score: 1, decision: 'eligible' };
  const plausible = { id: 'a', score: 1, decision: 'eligible' };
  const unresolved = { id: 'unknown', score: 0, decision: 'unknown' };
  const judgments = new Map([
    ['z', { outcome: 'eligible', relevance: 2 }],
    ['a', { outcome: 'eligible', relevance: 1 }],
    ['unknown', { outcome: 'unknown', relevance: 0 }],
  ]);
  assert.deepEqual(rank([strong, plausible, unresolved], 'score'), [
    plausible,
    strong,
    unresolved,
  ]);
  const row = measure(
    judgments,
    [plausible, unresolved],
    [plausible],
    [plausible],
    2,
  );
  const noPositive = measure(
    new Map([['unknown', judgments.get('unknown')]]),
    [unresolved],
    [],
    [],
    2,
  );
  assert.equal(noPositive.ndcg, null);
  const aggregate = summarize([row, noPositive]);
  assert.equal(aggregate.ndcg, 1 / (3 + 1 / Math.log2(3)));
  assert.equal(aggregate.retrievalRecall, 0.5);
  assert.equal(aggregate.admissionPrecision, 1);
  assert.equal(aggregate.decisionCoverage, 1 / 3);
  assert.equal(summarize([noPositive]).admissionPrecision, null);
  assert.equal(summarize([noPositive]).retrievalRecall, null);
});

test('checked-in cache and corpus exercise both splits and equivalent semantic shortlists', () => {
  const prepared = prepareFixtures(fixtureData());
  const vectors = loadVectors(JSON.parse(readFileSync(cacheUrl)), prepared);
  for (const split of ['development', 'held-out']) {
    const scenarios = prepared.scenarios.filter(
      (scenario) => scenario.split === split,
    );
    assert.ok(scenarios.length > 1);
    const outcomes = new Set();
    for (const scenario of scenarios) {
      for (const label of scenario.judgments.values())
        outcomes.add(label.outcome);
      const result = compareScenario(scenario, vectors);
      assert.deepEqual(
        result.semantic.retrievedIds,
        result.gatedSemantic.retrievedIds,
      );
      assert.deepEqual(
        result.gatedSemantic.retrievedIds,
        result.hybrid.retrievedIds,
      );
      assert.equal(result.gatedSemantic.admitted, result.hybrid.admitted);
      assert.equal(result.semantic.abstained, 0);
      const full = compareScenario(
        scenario,
        vectors,
        scenario.opportunities.length,
      );
      assert.equal(full.gatedSemantic.retrieved, scenario.opportunities.length);
      assert.equal(
        full.gatedSemantic.retrievedEligible,
        full.gatedSemantic.positives,
      );
    }
    assert.deepEqual([...outcomes].sort(), [
      'eligible',
      'ineligible',
      'unknown',
    ]);
  }
});
