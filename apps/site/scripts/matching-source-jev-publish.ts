import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { liveMatchingOpportunitySql } from '../src/lib/server/matching-projection-read.js';
import {
  jevBudget,
  reserveJevAttempt,
  settleJevAttempt,
} from '../src/lib/server/matching-source-decision-budget.js';
import {
  createMatchingSourceDecisionProvider,
  type MatchingSourceDecisionAttempt,
  type MatchingSourceDecisionProvider,
  resolveMatchingSourceDecisionConfig,
} from '../src/lib/server/matching-source-decision-provider.js';
import { runMatchingSourceExtraction } from '../src/lib/server/matching-source-extraction-worker.js';
import {
  MATCHING_SOURCE_JEV_PREPARATION_VERSION,
  type MatchingSourceJevAssessments,
  type MatchingSourceJevDiagnostics,
  prepareJevMatchingSource,
} from '../src/lib/server/matching-source-jev.js';
import type { MatchingSourceDecisionProfile } from '../src/lib/server/matching-source-semantics.js';

export function verifiedJevQaDatabase(value: string | undefined): string {
  if (!value || !URL.canParse(value))
    throw new Error('Set an explicit local QA database URL.');
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '55490' ||
    url.pathname !== '/iolaus_sweep_clone' ||
    url.search ||
    url.hash
  )
    throw new Error('This runner is limited to the isolated local QA clone.');
  // Resolve the allowed localhost name to a literal loopback connection.
  url.hostname = '127.0.0.1';
  return url.href;
}

export function parseJevQaArguments(args: string[]) {
  const seen = new Set<string>();
  let cohort: string | undefined;
  let maxCalls: number | undefined;
  let maxCostMicros: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('Duplicate QA option.');
    seen.add(flag);
    if (flag === '--apply') continue;
    const value = args[++index];
    if (!value || value.startsWith('--'))
      throw new Error('Missing QA option value.');
    if (flag === '--cohort') cohort = value;
    else if (
      flag === '--max-calls' &&
      /^[1-9]\d{0,3}$/u.test(value) &&
      Number(value) <= 1500
    )
      maxCalls = Number(value);
    else if (
      flag === '--max-cost-micros' &&
      /^[1-9]\d{0,5}$/u.test(value) &&
      Number(value) <= 500_000
    )
      maxCostMicros = Number(value);
    else throw new Error('Unsupported QA option or limit.');
  }
  const apply = seen.has('--apply');
  if (
    !cohort ||
    (apply ? !maxCalls || !maxCostMicros : maxCalls || maxCostMicros)
  )
    throw new Error(
      'Select a cohort and use explicit call and spend caps with --apply.',
    );
  return { cohort, apply, maxCalls, maxCostMicros };
}

export function parseJevQaCohort(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 40 ||
    new Set(value).size !== value.length ||
    value.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id),
    )
  )
    throw new Error('Supply 1 to 40 distinct public posting IDs.');
  return value;
}

async function runLocalJevQa(
  options: ReturnType<typeof parseJevQaArguments>,
  env: NodeJS.ProcessEnv,
) {
  const url = verifiedJevQaDatabase(env.DATABASE_URL);
  const data = await readFile(options.cohort, 'utf8');
  if (data.length > 8192) throw new Error('Cohort file exceeds the limit.');
  const cohort = parseJevQaCohort(JSON.parse(data));
  const database = await resolveDatabase({ type: 'postgres', url });
  try {
    const { rows } = await database.query(
      `SELECT CAST(o.id AS TEXT) AS id FROM opportunities o
       JOIN sources s ON s.id=o.source_id AND s.is_active=TRUE AND s.public_listing=TRUE
       WHERE CAST(o.id AS TEXT) IN (${cohort.map(() => '?').join(', ')})
         AND ${liveMatchingOpportunitySql('o', 'postgres')}`,
      cohort,
    );
    if (rows.length !== cohort.length)
      throw new Error(
        'Every selected posting must be currently public and active.',
      );
    if (!options.apply) return { mode: 'dry-run', selected: cohort.length };

    const config = resolveMatchingSourceDecisionConfig(env);
    if (config.provider !== 'typesafe')
      throw new Error('Use a pinned TypeSafe Jev provider for this QA runner.');
    const checkpoint =
      config.transport === 'bifrost'
        ? config.model.slice(config.model.indexOf('/') + 1)
        : config.model;
    if (checkpoint !== 'jev-1.14.0')
      throw new Error('Local source QA uses the pinned Jev 1.14.0 checkpoint.');
    const budget = jevBudget(checkpoint, options.maxCostMicros, env);
    const meter = {
      providerCalls: 0,
      preflightSkips: 0,
      retries: 0,
      reportedInputTokens: 0,
      reportedOutputTokens: 0,
      unknownUsageCalls: 0,
      elapsedMs: 0,
    };
    let lastAttempt: MatchingSourceDecisionAttempt | undefined;
    const observedModels = new Set<string>();
    const sdk = await createMatchingSourceDecisionProvider(config, {
      onAttempt(event) {
        lastAttempt = event;
        meter.providerCalls += event.calls;
        meter.preflightSkips += Number(event.calls === 0);
        meter.retries += event.retries;
        meter.elapsedMs += event.elapsedMs;
        meter.reportedInputTokens += event.usage?.promptTokens ?? 0;
        meter.reportedOutputTokens += event.usage?.completionTokens ?? 0;
        meter.unknownUsageCalls += Number(event.calls > 0 && !event.usage);
        if (event.status === 'ok' && event.observedModel)
          observedModels.add(event.observedModel);
      },
    });
    const profile: MatchingSourceDecisionProfile = {
      provider: config.provider,
      transport: config.transport,
      model: config.model,
      revision: config.revision,
      maxInputBytes: sdk.provenance.maxInputBytes,
      preparationVersion: MATCHING_SOURCE_JEV_PREPARATION_VERSION,
    };
    let capBlocked = false;
    const maxCalls = options.maxCalls ?? 0;
    const bounded: MatchingSourceDecisionProvider = {
      provenance: sdk.provenance,
      async decide(request) {
        if (meter.providerCalls >= maxCalls) {
          capBlocked = true;
          return { status: 'failed' };
        }
        if (!reserveJevAttempt(budget)) return { status: 'failed' };
        lastAttempt = undefined;
        const outcome = await sdk.decide(request);
        if (!settleJevAttempt(budget, lastAttempt))
          return { status: 'invalid' };
        return outcome;
      },
    };
    const results = [];
    for (const [index, opportunityId] of cohort.entries()) {
      if (capBlocked || budget.stopReason || meter.providerCalls >= maxCalls)
        break;
      const before = meter.providerCalls;
      let failure: string | undefined;
      let diagnostics: MatchingSourceJevDiagnostics | undefined;
      let structures: Record<string, string> | undefined;
      let assessments: MatchingSourceJevAssessments | undefined;
      const result = await runMatchingSourceExtraction(
        database,
        'postgres',
        budget.maxCostMicros,
        {
          opportunityId,
          decisionProfile: profile,
          onFailure(kind) {
            failure = kind;
          },
          provider: async (input) => {
            observedModels.clear();
            const semantic = await prepareJevMatchingSource(input, bounded, {
              onDiagnostics(summary) {
                diagnostics = summary;
              },
              onAssessments(value) {
                assessments = value;
              },
              onStructures(value) {
                structures = value;
              },
            });
            if (capBlocked || budget.stopReason || !observedModels.size)
              throw new Error(
                'This posting did not complete metered decision preparation.',
              );
            return {
              requestId: '',
              extraction: {
                coverage: 'partial',
                role: null,
                geography: null,
                noRequirements: null,
                required: [],
                preferred: [],
                unresolved: [],
                semantic: {
                  ...semantic,
                  decision: {
                    ...profile,
                    observedModels: [...observedModels].sort(),
                    diagnostics,
                    structures,
                    ...assessments,
                  },
                },
              },
            };
          },
        },
      );
      results.push({
        index,
        result,
        calls: meter.providerCalls - before,
        ...(failure && { failure }),
        ...(diagnostics && { diagnostics }),
      });
    }
    return {
      mode: 'published-local',
      selected: cohort.length,
      results,
      meter: { ...meter, elapsedMs: Math.round(meter.elapsedMs) },
      budget: {
        ...budget,
        reportedCostMicros: budget.settledCalls
          ? budget.reportedCostMicros
          : null,
      },
    };
  } finally {
    await database.close?.();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await runLocalJevQa(
      parseJevQaArguments(process.argv.slice(2)),
      process.env,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch {
    process.stderr.write(
      'Local Jev publication failed. Check the isolated database, cohort, explicit limits and provider settings.\n',
    );
    process.exitCode = 1;
  }
}
