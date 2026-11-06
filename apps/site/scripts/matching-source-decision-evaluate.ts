import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { DecisionAnswer } from '@happyvertical/ai';
import {
  jevBudget,
  jevInputTokenCeiling,
  reserveJevAttempt,
  settleJevAttempt,
} from '../src/lib/server/matching-source-decision-budget.js';
import { prepareMatchingSourceDecision } from '../src/lib/server/matching-source-decision-preparation.js';
import {
  createMatchingSourceDecisionProvider,
  type MatchingSourceDecisionAttempt,
  type MatchingSourceDecisionProvider,
  resolveMatchingSourceDecisionConfig,
} from '../src/lib/server/matching-source-decision-provider.js';
import {
  compileMatchingVocabulary,
  evaluateNormalizedMatch,
  type NormalizedMatchingPosting,
  normalizeMatchingCandidate,
} from '../src/lib/server/normalized-matching.js';
import { SKILL_VOCABULARY_SEED_TERMS } from '../src/lib/server/skill-vocabulary.js';
import {
  type BenchmarkCase,
  type BenchmarkCitation,
  expectedSpan,
  parseBenchmarkFixture,
} from './matching-source-decision-evaluate-fixtures.js';

const builtInFixture = new URL(
  './matching-source-decision-evaluate-fixtures.json',
  import.meta.url,
);
const fixtureByteLimit = 512_000;
const vocab = compileMatchingVocabulary(SKILL_VOCABULARY_SEED_TERMS);
const probeDate = Date.UTC(2026, 0, 1);
const usageFields = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
] as const;
const attemptStatuses = [
  'ok',
  'oversized',
  'truncated',
  'failed',
  'timeout',
  'invalid',
] as const;

export function parseArguments(args: string[]) {
  let mode: 'mock' | 'laya' | 'jev' = 'mock';
  let maxCalls: number | undefined;
  let maxCostMicros: number | undefined;
  let fixture: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('Duplicate option.');
    seen.add(flag);
    if (flag === '--allow-live-laya' || flag === '--allow-live-jev') continue;
    const value = args[++index];
    if (!value || value.startsWith('--'))
      throw new Error('Missing option value.');
    switch (flag) {
      case '--mode':
        if (value !== 'mock' && value !== 'laya' && value !== 'jev')
          throw new Error('Unsupported mode.');
        mode = value;
        break;
      case '--fixture':
        fixture = value;
        break;
      case '--max-calls':
        if (!/^[1-9]\d?$/u.test(value)) throw new Error('Invalid call cap.');
        maxCalls = Number(value);
        break;
      case '--max-cost-micros':
        if (!/^[1-9]\d{0,8}$/u.test(value))
          throw new Error('Invalid cost cap.');
        maxCostMicros = Number(value);
        break;
      default:
        throw new Error('Unknown option.');
    }
  }
  if (
    seen.has('--allow-live-laya') !== (mode === 'laya') ||
    seen.has('--allow-live-jev') !== (mode === 'jev') ||
    (maxCalls !== undefined) !== (mode !== 'mock') ||
    (maxCostMicros !== undefined) !== (mode === 'jev')
  )
    throw new Error('Live evaluation requires a matching opt-in and limits.');
  return { mode, maxCalls, maxCostMicros, fixture };
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readFixture(path: string | URL) {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile())
      throw new Error('Expected a regular fixture file.');
    const bytes = Buffer.alloc(fixtureByteLimit + 1);
    const { bytesRead } = await handle.read({
      buffer: bytes,
      length: bytes.length,
      position: 0,
    });
    if (bytesRead > fixtureByteLimit)
      throw new Error('Fixture exceeds byte limit.');
    return parseBenchmarkFixture(
      JSON.parse(bytes.toString('utf8', 0, bytesRead)),
    );
  } finally {
    await handle.close();
  }
}

type Span = ReturnType<typeof expectedSpan>;
type Prepared = Awaited<ReturnType<typeof prepareMatchingSourceDecision>>;

function goldView(fixture: BenchmarkCase) {
  const { source, gold } = fixture;
  function ground<T extends { citation: BenchmarkCitation }>(claim: T) {
    return { ...claim, citation: expectedSpan(source, claim.citation) };
  }
  return {
    required: gold.required.map(ground),
    preferred: gold.preferred.map(ground),
    role: gold.role ? ground(gold.role) : undefined,
    geography: gold.geography ? ground(gold.geography) : undefined,
    unresolved: gold.unresolved.map((span) => expectedSpan(source, span)),
    concepts: gold.concepts.map(ground),
  };
}

function observedView(prepared: Prepared) {
  return {
    ...prepared.posting,
    concepts: prepared.units.flatMap(
      ({
        citation,
        conceptSuggestion,
        conceptDecisionStatus,
        conceptSelection,
        conceptConfirmation,
      }) =>
        conceptDecisionStatus
          ? [
              {
                citation: { ...citation, text: citation.quote },
                slug: conceptSuggestion,
                status: conceptDecisionStatus,
                selection: conceptSelection,
                confirmation: conceptConfirmation,
              },
            ]
          : [],
    ),
    unresolved: prepared.units
      .filter(({ kind }) => kind === 'unresolved')
      .map(({ citation }) => ({ ...citation, text: citation.quote })),
  };
}

type Observed = Pick<
  NormalizedMatchingPosting,
  | 'required'
  | 'preferred'
  | 'role'
  | 'geography'
  | 'uncertainties'
  | 'preferredUncertainties'
> & {
  unresolved: readonly (Omit<Span, 'field'> & { field: string })[];
  concepts: readonly {
    citation: Span;
    slug?: string;
    status: MatchingSourceDecisionAttempt['status'];
    selection: Prepared['units'][number]['conceptSelection'];
    confirmation: Prepared['units'][number]['conceptConfirmation'];
  }[];
};

function citationKey({
  field,
  start,
  end,
  text,
}: Omit<Span, 'field'> & { field: string }) {
  return JSON.stringify([field, start, end, text]);
}

function groupKey(group: NormalizedMatchingPosting['required'][number]) {
  return JSON.stringify([
    citationKey(group.citation),
    group.alternatives
      .map(({ slug, years, context }) => JSON.stringify([slug, years, context]))
      .sort(),
  ]);
}

function roleKey(role: NonNullable<NormalizedMatchingPosting['role']>) {
  return JSON.stringify([
    role.family,
    role.specialty,
    role.level,
    citationKey(role.citation),
  ]);
}

function geographyKey(
  geography: NonNullable<NormalizedMatchingPosting['geography']>,
) {
  return JSON.stringify([
    geography.mode,
    geography.worldwide,
    geography.regions
      .map(({ country, locality }) => JSON.stringify([country, locality]))
      .sort(),
    citationKey(geography.citation),
  ]);
}

function compare<T>(
  expected: readonly T[],
  observed: readonly T[],
  key: (claim: T) => string,
) {
  const remaining = expected.map(key);
  let correct = 0;
  for (const item of observed) {
    const index = remaining.indexOf(key(item));
    if (index < 0) continue;
    correct++;
    remaining.splice(index, 1);
  }
  return {
    correct,
    wrong: observed.length - correct,
    missing: remaining.length,
  };
}

const list = <T>(item: T | undefined) => (item ? [item] : []);

function scoreConcepts(
  expected: ReturnType<typeof goldView>['concepts'],
  observed: Observed['concepts'],
) {
  const reviewed = new Set(
    expected.map(({ citation }) => citationKey(citation)),
  );
  const predicted = new Map(
    observed.map((item) => [citationKey(item.citation), item]),
  );
  const counts = {
    equivalentSpans: 0,
    equivalentChecked: 0,
    equivalentCorrect: 0,
    equivalentWrong: 0,
    equivalentMissed: 0,
    relatedOnlySpans: 0,
    relatedOnlyChecked: 0,
    relatedOnlySuggested: 0,
    noFitSpans: 0,
    noFitChecked: 0,
    noFitSuggested: 0,
    suggestionsOutsideReviewedSpans: observed.filter(
      ({ citation, slug }) => slug && !reviewed.has(citationKey(citation)),
    ).length,
  };
  const stages: Record<string, number> = {};
  for (const item of expected) {
    const prediction = predicted.get(citationKey(item.citation));
    const selection = `${item.kind}.selection.${prediction?.selection ?? 'not-attempted'}`;
    const confirmation = `${item.kind}.confirmation.${prediction?.confirmation ?? 'not-attempted'}`;
    stages[selection] = (stages[selection] ?? 0) + 1;
    stages[confirmation] = (stages[confirmation] ?? 0) + 1;
    const suggestion = prediction?.slug;
    const checked = Number(prediction?.status === 'ok');
    if (item.kind === 'equivalent') {
      counts.equivalentSpans++;
      counts.equivalentChecked += checked;
      if (suggestion === undefined) counts.equivalentMissed++;
      else if (suggestion === item.slug) counts.equivalentCorrect++;
      else counts.equivalentWrong++;
    } else if (item.kind === 'related-only') {
      counts.relatedOnlySpans++;
      counts.relatedOnlyChecked += checked;
      counts.relatedOnlySuggested += Number(suggestion !== undefined);
    } else {
      counts.noFitSpans++;
      counts.noFitChecked += checked;
      counts.noFitSuggested += Number(suggestion !== undefined);
    }
  }
  return { counts, stages };
}

function scoreClaims(
  expected: ReturnType<typeof goldView>,
  observed: Observed,
  fixture: BenchmarkCase,
) {
  const { source } = fixture;
  const advisory = scoreConcepts(expected.concepts, observed.concepts);
  const expectedUnresolved = new Set(expected.unresolved.map(citationKey));
  const unresolved = new Set(observed.unresolved.map(citationKey));
  const spans = [
    ...[
      ...observed.required,
      ...observed.preferred,
      ...list(observed.role),
      ...list(observed.geography),
    ].map(({ citation }) => citation),
    ...observed.unresolved,
    ...observed.concepts
      .filter(({ slug }) => slug)
      .map(({ citation }) => citation),
  ];
  const invalid = spans.filter(({ field, start, end, text }) => {
    const raw =
      field === 'workplace'
        ? source.workplaceType
        : field === 'title' || field === 'location' || field === 'description'
          ? source[field]
          : undefined;
    return (
      !text ||
      !Number.isInteger(start) ||
      start < 0 ||
      end !== start + text.length ||
      raw?.slice(start, end) !== text
    );
  }).length;
  const reviewedRequirementSpans = new Set(
    [...expected.required, ...expected.preferred].map(({ citation }) =>
      citationKey(citation),
    ),
  );

  let expectedConflicts = 0;
  let detectedConflicts = 0;
  let falseConflicts = 0;
  let missedConflicts = 0;
  for (const probe of fixture.probes) {
    const candidate = normalizeMatchingCandidate(
      {
        targetRoles: [probe.targetRole],
        locations: [],
        remoteCountries: probe.remoteCountry ? [probe.remoteCountry] : [],
        workModes: probe.workMode ? [probe.workMode] : [],
        evidence: [],
      },
      vocab,
      undefined,
      probeDate,
    );
    const conflict =
      evaluateNormalizedMatch(observed, candidate).status === 'conflict';
    expectedConflicts += Number(probe.conflict);
    detectedConflicts += Number(conflict && probe.conflict);
    falseConflicts += Number(conflict && !probe.conflict);
    missedConflicts += Number(!conflict && probe.conflict);
  }
  return {
    required: compare<NormalizedMatchingPosting['required'][number]>(
      expected.required,
      observed.required,
      groupKey,
    ),
    preferred: compare<NormalizedMatchingPosting['preferred'][number]>(
      expected.preferred,
      observed.preferred,
      groupKey,
    ),
    role: compare<NonNullable<NormalizedMatchingPosting['role']>>(
      list(expected.role),
      list(observed.role),
      roleKey,
    ),
    geography: compare<NonNullable<NormalizedMatchingPosting['geography']>>(
      list(expected.geography),
      list(observed.geography),
      geographyKey,
    ),
    citations: { exact: spans.length - invalid, invalid },
    advisoryConcepts: advisory.counts,
    advisoryStages: advisory.stages,
    unresolved: {
      observed: unresolved.size,
      expected: expectedUnresolved.size,
      expectedCovered: [...expectedUnresolved].filter((span) =>
        unresolved.has(span),
      ).length,
      knownRequirementSpans: reviewedRequirementSpans.size,
      knownRequirementsLeftUnresolved: [...reviewedRequirementSpans].filter(
        (span) => unresolved.has(span),
      ).length,
    },
    conflicts: {
      probes: fixture.probes.length,
      expectedConflicts,
      detectedConflicts,
      falseConflicts,
      missedConflicts,
    },
  };
}

function abstentionControl(expected: ReturnType<typeof goldView>): Observed {
  return {
    required: [],
    preferred: [],
    uncertainties: [],
    preferredUncertainties: [],
    concepts: [],
    unresolved: [
      ...expected.unresolved,
      ...[...expected.required, ...expected.preferred].map(
        ({ citation }) => citation,
      ),
    ],
  };
}

function fixtureProvider(control: boolean): MatchingSourceDecisionProvider {
  const model = control ? 'abstain' : 'scripted';
  return {
    provenance: {
      provider: 'fixture',
      transport: 'fixture',
      model,
      revision: 'v1',
      maxInputBytes: 8192,
    },
    async decide({ state, questions }) {
      const quote =
        state &&
        typeof state === 'object' &&
        !Array.isArray(state) &&
        typeof state.quote === 'string'
          ? state.quote
          : '';
      const answers: Record<string, DecisionAnswer> = {};
      // Scripted branches exercise the report, without asserting language quality.
      const concept = control
        ? 'none'
        : /(?:leading a group of engineers|supervising a squad of software engineers)/iu.test(
              quote,
            )
          ? 'engineering-team-leadership'
          : /(?:shadowing|observing)/iu.test(quote)
            ? 'related'
            : 'none';
      const classification =
        !control &&
        /\b(?:required|must|minimum|mandatory|the role calls for|experience)\b/iu.test(
          quote,
        )
          ? 'requirement'
          : 'unresolved';
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === 'choice') {
          const choice = id === 'concept' ? concept : classification;
          answers[id] = {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((option) => [
                option,
                Number(option === choice),
              ]),
            ),
            confidence: 1,
          };
        } else if (question.type === 'predicate') {
          answers[id] = {
            type: 'predicate',
            probability: Number(id === `equivalent_${concept}`),
          };
        }
      }
      return {
        status: 'ok',
        result: { model, provenance: { provider: 'fixture', model }, answers },
      };
    },
  };
}

function sumScores(scores: ReturnType<typeof scoreClaims>[]) {
  const totals = scores[0];
  for (const score of scores.slice(1)) {
    for (const metric of Object.keys(totals) as (keyof typeof totals)[]) {
      const total = totals[metric] as Record<string, number>;
      for (const [label, count] of Object.entries(score[metric]))
        total[label] = (total[label] ?? 0) + count;
    }
  }
  return totals;
}

export function summarizeAttempts(
  attempts: readonly MatchingSourceDecisionAttempt[],
  expectedCheckpoint: string,
) {
  const calls = attempts.filter(({ calls }) => calls > 0);
  const missingUsageCalls = calls.filter(
    ({ usage }) =>
      !usage ||
      usageFields.some(
        (field) => !Number.isSafeInteger(usage[field]) || usage[field] < 0,
      ),
  ).length;
  const tokens = Object.fromEntries(
    usageFields.map((field) => {
      const observed = calls.flatMap(({ usage }) => {
        const value = usage?.[field];
        return value !== undefined && Number.isSafeInteger(value) && value >= 0
          ? [value]
          : [];
      });
      return [
        field,
        {
          reportedSubtotal: observed.length
            ? observed.reduce((sum, value) => sum + value, 0)
            : null,
          reportingCalls: observed.length,
        },
      ];
    }),
  );
  return {
    providerCalls: calls.length,
    retries: attempts.reduce((sum, attempt) => sum + attempt.retries, 0),
    statuses: Object.fromEntries(
      attemptStatuses.map((status) => [
        status,
        attempts.filter((attempt) => attempt.status === status).length,
      ]),
    ),
    attemptLatency: latency(attempts.map(({ elapsedMs }) => elapsedMs)),
    providerCallLatency: latency(calls.map(({ elapsedMs }) => elapsedMs)),
    missingUsageCalls,
    tokens,
    observedModel: {
      matched: calls.filter(
        ({ observedModel }) => observedModel === expectedCheckpoint,
      ).length,
      differed: calls.filter(
        ({ observedModel }) =>
          observedModel !== null && observedModel !== expectedCheckpoint,
      ).length,
      unavailable: calls.filter(({ observedModel }) => observedModel === null)
        .length,
      distinctFingerprints: [
        ...new Set(
          calls.flatMap(({ observedModel }) =>
            observedModel === null ? [] : [digest(observedModel)],
          ),
        ),
      ].sort(),
    },
  };
}

function latency(durations: number[]) {
  const ordered = durations.sort((left, right) => left - right);
  const sum = ordered.reduce((total, ms) => total + ms, 0);
  return {
    totalMs: Math.round(sum),
    medianMs: ordered.length
      ? Math.round(ordered[Math.ceil(ordered.length / 2) - 1])
      : null,
    p95Ms: ordered.length
      ? Math.round(ordered[Math.ceil(ordered.length * 0.95) - 1])
      : null,
  };
}

export async function evaluate(
  args: ReturnType<typeof parseArguments>,
  env: NodeJS.ProcessEnv,
) {
  const live = args.mode !== 'mock';
  const expectedProvider = args.mode === 'jev' ? 'typesafe' : 'laya';
  if (
    live &&
    (env.IOLAUS_SOURCE_DECISION_PROVIDER !== expectedProvider ||
      args.maxCalls === undefined ||
      !Number.isSafeInteger(args.maxCalls) ||
      args.maxCalls < 1 ||
      args.maxCalls > 99)
  )
    throw new Error(
      args.mode === 'jev'
        ? 'Explicit TypeSafe configuration required.'
        : 'Explicit Laya configuration required.',
    );
  const config = live ? resolveMatchingSourceDecisionConfig(env) : undefined;
  const expectedCheckpoint =
    config && config.transport === 'bifrost'
      ? config.model.slice(config.model.indexOf('/') + 1)
      : (config?.model ?? 'scripted');
  const spend =
    args.mode === 'jev'
      ? jevBudget(expectedCheckpoint, args.maxCostMicros, env)
      : undefined;
  const fixture = await readFixture(args.fixture ?? builtInFixture);
  const attempts: MatchingSourceDecisionAttempt[] = [];
  const provider = config
    ? await createMatchingSourceDecisionProvider(config, {
        onAttempt: (attempt) => attempts.push(attempt),
      })
    : fixtureProvider(false);
  const { transport } = provider.provenance;
  const codeOnly = fixtureProvider(true);
  let attemptsBudgeted = 0;
  let preparationVersion: string | undefined;
  async function evaluateSplit(cases: BenchmarkCase[]) {
    const candidates: ReturnType<typeof scoreClaims>[] = [];
    const codeOnlyScores: ReturnType<typeof scoreClaims>[] = [];
    const frozen: ReturnType<typeof scoreClaims>[] = [];
    const times: number[] = [];
    const controlTimes: number[] = [];
    const startAttempts = attempts.length;
    let evaluatedRequests = 0;
    let budgetBlockedRequests = 0;
    for (const item of cases) {
      const source = { ...item.source, sourceContentVersion: 1 };
      const gold = goldView(item);
      const started = performance.now();
      const candidate = await prepareMatchingSourceDecision(source, {
        provenance: provider.provenance,
        async decide(request) {
          evaluatedRequests++;
          if (
            args.maxCalls !== undefined &&
            attemptsBudgeted >= args.maxCalls
          ) {
            budgetBlockedRequests++;
            return { status: 'failed' };
          }
          if (spend && !reserveJevAttempt(spend)) {
            budgetBlockedRequests++;
            return { status: 'failed' };
          }
          attemptsBudgeted++;
          const before = attempts.length;
          const outcome = await provider.decide(request);
          if (spend && !settleJevAttempt(spend, attempts[before]))
            return { status: 'invalid' };
          return outcome;
        },
      });
      times.push(performance.now() - started);
      preparationVersion = candidate.identity.version;
      const controlStarted = performance.now();
      const control = await prepareMatchingSourceDecision(source, codeOnly);
      controlTimes.push(performance.now() - controlStarted);
      candidates.push(scoreClaims(gold, observedView(candidate), item));
      codeOnlyScores.push(scoreClaims(gold, observedView(control), item));
      frozen.push(scoreClaims(gold, abstentionControl(gold), item));
    }
    return {
      cases: cases.length,
      candidate: sumScores(candidates),
      controls: {
        codePathWithAbstention: sumScores(codeOnlyScores),
        frozenAbstentionV1: sumScores(frozen),
      },
      preparationLatency: latency(times),
      codePathWithAbstentionLatency: latency(controlTimes),
      evaluatedRequests,
      budgetBlockedRequests,
      usage: summarizeAttempts(
        attempts.slice(startAttempts),
        expectedCheckpoint,
      ),
    };
  }
  const synthetic = await evaluateSplit(fixture.synthetic);
  const heldOut = await evaluateSplit(fixture.heldOut);
  return {
    reportVersion: 2,
    evidence: live ? `live-${args.mode}` : 'scripted-plumbing-only',
    fixture: args.fixture
      ? { version: fixture.version, origin: 'external' }
      : {
          version: fixture.version,
          origin: 'built-in',
          fingerprint: digest(fixture),
        },
    preparationVersion,
    provider: provider.provenance.provider,
    transport,
    providerFingerprint: digest(provider.provenance),
    configuredModelFingerprint: digest(provider.provenance.model),
    maxInputBytes: provider.provenance.maxInputBytes,
    timeoutMs: config?.timeoutMs ?? null,
    callCap: args.maxCalls ?? 0,
    cost: spend
      ? {
          ...spend,
          inputTokenCeilingPerCall: jevInputTokenCeiling,
          reportedCostMicros: spend.settledCalls
            ? spend.reportedCostMicros
            : null,
        }
      : null,
    fullRunWithinBudget:
      synthetic.budgetBlockedRequests + heldOut.budgetBlockedRequests === 0,
    synthetic,
    heldOut,
    usage: summarizeAttempts(attempts, expectedCheckpoint),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = parseArguments(process.argv.slice(2));
    process.stdout.write(
      `${JSON.stringify(await evaluate(args, process.env), null, 2)}\n`,
    );
  } catch {
    process.stderr.write(
      'Source decision evaluation failed. Check the fixture, provider, opt-in flag, and required call and cost caps.\n',
    );
    process.exitCode = 1;
  }
}
