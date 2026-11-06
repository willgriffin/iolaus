import { readFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { parseArgs } from 'node:util';
import { loadVectors, prepareFixtures, sha256 } from './data.mjs';
import {
  compareScenario,
  cosine,
  displayDepth,
  hybridScore,
  retrievalDepth,
  structuredPair,
  summarize,
} from './score.mjs';

const { values: options } = parseArgs({
  options: {
    'emit-inputs': { type: 'boolean' },
    benchmark: { type: 'boolean' },
  },
});
const fixtureBytes = readFileSync(new URL('fixtures.json', import.meta.url));
const start = performance.now();
const prepared = prepareFixtures(JSON.parse(fixtureBytes));
const structuredPreparationMs = performance.now() - start;

if (options['emit-inputs']) {
  process.stdout.write(prepared.inputs);
} else {
  const cacheStart = performance.now();
  const cacheBytes = readFileSync(new URL('vectors.json', import.meta.url));
  const cache = JSON.parse(cacheBytes);
  const vectors = loadVectors(cache, prepared);
  const vectorLoadMs = performance.now() - cacheStart;
  const splits = {};
  for (const split of ['development', 'held-out']) {
    const scenarios = prepared.scenarios.filter(
      (scenario) => scenario.split === split,
    );
    const results = scenarios.map((scenario) =>
      compareScenario(scenario, vectors),
    );
    const metrics = Object.fromEntries(
      Object.keys(results[0]).map((arm) => [
        arm,
        summarize(results.map((result) => result[arm])),
      ]),
    );
    const fullPools = scenarios.map((scenario) =>
      compareScenario(scenario, vectors, scenario.opportunities.length),
    );
    const fullPoolSensitivity = Object.fromEntries(
      ['structured', 'gatedSemantic', 'hybrid'].map((arm) => [
        arm,
        summarize(fullPools.map((result) => result[arm])),
      ]),
    );
    const outcomes = ['eligible', 'ineligible', 'unknown'];
    const gate = Object.fromEntries(
      outcomes.map((expected) => [
        expected,
        Object.fromEntries(outcomes.map((decision) => [decision, 0])),
      ]),
    );
    for (const scenario of scenarios) {
      for (const opportunity of scenario.opportunities) {
        const expected = scenario.judgments.get(opportunity.id).outcome;
        const { decision } = structuredPair(scenario.candidate, opportunity);
        gate[expected][decision]++;
      }
    }
    splits[split] = {
      scenarios: scenarios.length,
      judgedPairs: scenarios.reduce(
        (sum, scenario) => sum + scenario.opportunities.length,
        0,
      ),
      metrics,
      fullPoolSensitivity,
      gateByExpectedOutcome: gate,
      cases: Object.fromEntries(
        scenarios.map((scenario, index) => [scenario.id, results[index]]),
      ),
    };
  }

  process.stdout.write(
    JSON.stringify(
      {
        fixtureSha256: sha256(fixtureBytes),
        vectorSha256: sha256(cacheBytes),
        model: cache.model,
        revision: cache.revision,
        dimensions: cache.dimensions,
        retrievalDepth,
        displayDepth,
        splits,
        ...(options.benchmark
          ? {
              timing: {
                structuredPreparationMs,
                vectorLoadMs,
                pairScoring: benchmark(prepared.scenarios, vectors),
              },
            }
          : {}),
      },
      null,
      2,
    ) + '\n',
  );
}

// Measure scoring only. Repeated rows make this an arithmetic workload, with
// unrealistically favorable memory reuse and no ranking, I/O, or index costs.
function benchmark(scenarios, vectors) {
  const catalogSize = 20_000;
  const iterations = 30;
  const warmups = 5;
  const source = scenarios.flatMap(({ opportunities }) => opportunities);
  const catalog = Array.from(
    { length: catalogSize },
    (_, index) => source[index % source.length],
  );
  const catalogVectors = catalog.map(({ id }) => vectors.get(id));
  const methods = {
    structured: (candidate, _query, index) =>
      structuredPair(candidate, catalog[index]).score,
    semantic: (_candidate, query, index) =>
      cosine(query, catalogVectors[index]),
    bothScores: (candidate, query, index) =>
      hybridScore(
        structuredPair(candidate, catalog[index]).score,
        cosine(query, catalogVectors[index]),
      ),
  };
  let checksum = 0;
  const timings = {};
  for (const [method, score] of Object.entries(methods)) {
    const samples = [];
    for (let iteration = 0; iteration < warmups + iterations; iteration++) {
      const candidate = scenarios[iteration % scenarios.length].candidate;
      const query = vectors.get(candidate.id);
      const start = performance.now();
      for (let index = 0; index < catalogSize; index++)
        checksum += score(candidate, query, index);
      const elapsed = performance.now() - start;
      if (iteration >= warmups) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    timings[method] = {
      medianMs: (samples[iterations / 2 - 1] + samples[iterations / 2]) / 2,
      p95Ms: samples[Math.ceil(iterations * 0.95) - 1],
    };
  }
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0].model,
    catalogSize,
    distinctCatalogRows: source.length,
    candidates: scenarios.length,
    iterations,
    warmups,
    timings,
    checksum,
  };
}
