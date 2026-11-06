import { createHash } from 'node:crypto';
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { matchingPostingInput } from '../src/lib/server/matching-projection-input.js';
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
import {
  MATCHING_SOURCE_EXTRACTION_VERSION,
  parseMatchingSourceExtraction,
} from '../src/lib/server/matching-source-extraction-contract.js';
import { runMatchingSourceExtraction } from '../src/lib/server/matching-source-extraction-worker.js';
import {
  matchingSourceCaptureDigest,
  matchingSourceDecisionRequestId,
} from '../src/lib/server/matching-source-identity.js';
import {
  MATCHING_SOURCE_JEV_PREPARATION_VERSION,
  type MatchingSourceJevAssessments,
  type MatchingSourceJevDiagnostics,
  prepareJevMatchingSource,
} from '../src/lib/server/matching-source-jev.js';
import type { MatchingSourceDecisionProfile } from '../src/lib/server/matching-source-semantics.js';
import { MATCHING_SOURCE_DECISION_READER_REVISION } from '../src/lib/server/matching-source-units.js';
import { MATCHING_POLICY_VERSION } from '../src/lib/server/normalized-matching.js';

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
  let report: string | undefined;
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
    else if (flag === '--report') report = value;
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
  if (report === cohort) throw new Error('Use a separate report path.');
  return { cohort, apply, maxCalls, maxCostMicros, report };
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

type CapturePin = {
  id: string;
  caseKey: string;
  title: string;
  sourceFingerprint: string;
  sourceDigest: string;
};

export function parseJevQaCapturePins(value: unknown): Map<string, CapturePin> {
  if (!Array.isArray(value)) throw new Error('Supply a selected cohort.');
  const pins = new Map<string, CapturePin>();
  if (value.every((entry) => typeof entry === 'string')) return pins;
  const ids = parseJevQaCohort(value.map((entry) => entry?.id));
  const caseKeys = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (
      typeof entry.caseKey !== 'string' ||
      !/^[a-z][a-z0-9-]{0,39}$/u.test(entry.caseKey) ||
      caseKeys.has(entry.caseKey) ||
      typeof entry.title !== 'string' ||
      !entry.title.trim() ||
      entry.title.length > 250 ||
      [entry.sourceFingerprint, entry.sourceDigest].some(
        (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash),
      )
    ) throw new Error('Invalid selected capture pin.');
    caseKeys.add(entry.caseKey);
    pins.set(ids[index], entry);
  }
  return pins;
}

export function matchesJevQaCapturePin(
  pin: CapturePin,
  capture: { id: unknown; title: unknown; fingerprint: unknown; digest?: string },
) {
  return capture.id === pin.id &&
    capture.title === pin.title &&
    capture.fingerprint === pin.sourceFingerprint &&
    (capture.digest === undefined || capture.digest === pin.sourceDigest);
}

type ReadbackRow = Record<string, unknown>;
type Stop = 'call-cap' | 'cost-cap' | 'unverified-usage';
type WorkerResult = Awaited<ReturnType<typeof runMatchingSourceExtraction>>;
type ResultStatus =
  | 'unattempted'
  | 'in-progress'
  | 'published'
  | 'retained'
  | 'cached'
  | 'ineligible'
  | 'obsolete'
  | 'retry';

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function revision(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  return /^\d+$/u.test(text) ? text : null;
}

function publicDecision(profile: MatchingSourceDecisionProfile) {
  const checkpoint = profile.model.split('/').at(-1) ?? '';
  return {
    provider: profile.provider,
    transport: profile.transport,
    model: /^jev-\d+\.\d+\.\d+$/u.test(checkpoint) ? checkpoint : null,
    modelFingerprint: fingerprint(profile.model),
    revisionFingerprint: fingerprint(profile.revision),
    preparationVersion: /^matching-source-jev\/v\d+$/u.test(
      profile.preparationVersion,
    )
      ? profile.preparationVersion
      : null,
    identity: matchingSourceDecisionRequestId(profile),
  };
}

function sourceDecisionReaderRevision(facts: unknown): string | null {
  if (typeof facts !== 'string') return null;
  try {
    const value: unknown = JSON.parse(facts)?.sourceDecisionReaderRevision;
    return typeof value === 'string' &&
      (value === MATCHING_SOURCE_DECISION_READER_REVISION ||
        /^[a-z][a-z0-9-]{0,50}\/v[0-9]{1,8}$/u.test(value))
      ? value
      : null;
  } catch {
    return null;
  }
}

export function describeJevQaReadback(
  row: ReadbackRow,
  requestedIdentity?: string,
) {
  const sourceContentVersion = revision(row.source_content_version);
  const proofVersion = revision(row.proof_source_content_version);
  const proofState = row.proof_state;
  const matchingCapture =
    sourceContentVersion !== null &&
    sourceContentVersion === proofVersion &&
    row.proof_source_fingerprint === row.source_content_fingerprint;
  const captureCurrent =
    matchingCapture &&
    row.proof_input_digest ===
      matchingSourceCaptureDigest(row.source_content_json);
  const matchingContract =
    row.proof_contract_version === MATCHING_SOURCE_EXTRACTION_VERSION;
  const payload =
    typeof row.proof_payload === 'string' ? row.proof_payload : '';
  const requestId =
    typeof row.proof_request_id === 'string' ? row.proof_request_id : '';
  let proofKind: 'legacy' | 'decision' | 'missing' | 'invalid' = 'missing';
  let proofIdentity: string | null = null;
  let storedDecision: ReturnType<typeof publicDecision> | null = null;
  if (matchingCapture && proofState === 'complete') {
    proofKind = 'invalid';
    if (matchingContract && payload && captureCurrent) {
      try {
        const source = matchingPostingInput(row);
        if (!source.title || !source.description) throw new Error();
        const proof = parseMatchingSourceExtraction(
          JSON.parse(payload),
          source,
        );
        const decision = proof.semantic?.decision;
        if (decision) {
          const details = publicDecision(decision);
          if (details.identity === requestId) {
            proofKind = 'decision';
            proofIdentity = details.identity;
            storedDecision = details;
          }
        } else if (!requestId.startsWith('decision:')) {
          proofKind = 'legacy';
          proofIdentity = `legacy:${fingerprint(payload)}`;
        }
      } catch {
        // Invalid stored data is reported as such. Its contents stay private.
      }
    }
  }
  const currentSourceRevision = revision(row.current_source_revision);
  const sourceFactsRevision = revision(row.facts_source_revision);
  const workRevision = revision(row.facts_work_revision);
  const readerRevision = sourceDecisionReaderRevision(row.facts_json);
  const factsCurrent =
    sourceFactsRevision !== null &&
    sourceFactsRevision === currentSourceRevision &&
    revision(row.facts_listing_revision) !== null &&
    revision(row.facts_listing_revision) ===
      revision(row.current_listing_revision) &&
    revision(row.facts_vocabulary_revision) !== null &&
    revision(row.facts_vocabulary_revision) ===
      revision(row.current_vocabulary_revision) &&
    row.facts_policy_version === MATCHING_POLICY_VERSION;
  return {
    sourceContentVersion,
    public: row.is_public === true,
    proof: {
      kind: proofKind,
      state:
        proofState === 'complete' ||
        proofState === 'running' ||
        proofState === 'retry' ||
        proofState === 'failed'
          ? proofState
          : null,
      sourceContentVersion: proofVersion,
      captureCurrent,
      contractCurrent: matchingContract,
      identity: proofIdentity,
      payloadFingerprint: proofIdentity ? fingerprint(payload) : null,
      requested: requestedIdentity
        ? proofKind === 'decision' && proofIdentity === requestedIdentity
          ? ('latest' as const)
          : proofKind === 'decision' || proofKind === 'legacy'
            ? ('retained' as const)
            : null
        : null,
      decision: storedDecision,
    },
    sharedSourceFacts: {
      state:
        sourceFactsRevision === null
          ? ('missing' as const)
          : factsCurrent
            ? ('current' as const)
            : ('stale' as const),
      currentSourceRevision,
      sourceRevision: sourceFactsRevision,
      workRevision,
      sourceDecisionReaderRevision: readerRevision,
      expectedSourceDecisionReaderRevision:
        MATCHING_SOURCE_DECISION_READER_REVISION,
      sourceDecisionReader:
        readerRevision === null
          ? ('unknown' as const)
          : readerRevision === MATCHING_SOURCE_DECISION_READER_REVISION
            ? ('current' as const)
            : ('older' as const),
    },
  };
}

type Readback = ReturnType<typeof describeJevQaReadback>;
type ReportRow = {
  index: number;
  ordinal: number;
  caseKey?: string;
  status: ResultStatus;
  result: WorkerResult | 'unattempted' | 'in-progress';
  calls: number;
  stopReason?: Stop;
  failure?: string;
  diagnostics?: MatchingSourceJevDiagnostics;
  requested: ReturnType<typeof publicDecision> | null;
  before: Readback;
  current: Readback;
};

export function classifyJevQaResult(
  result: WorkerResult,
  before: Readback,
  after: Readback,
  failure?: string,
): ResultStatus {
  if (result === 'published' || result === 'obsolete') return result;
  if (
    before.proof.identity &&
    before.proof.identity === after.proof.identity &&
    before.proof.payloadFingerprint === after.proof.payloadFingerprint &&
    (failure === 'PriorEvidenceRetained' || result === 'retry')
  )
    return 'retained';
  if (result === 'retry') return result;
  if (
    after.public &&
    before.proof.requested === 'latest' &&
    after.proof.requested === 'latest'
  )
    return 'cached';
  if (
    after.public &&
    after.proof.captureCurrent &&
    (after.proof.state === 'retry' || after.proof.state === 'running')
  )
    return 'retry';
  return 'ineligible';
}

export function jevQaStop(
  budget: ReturnType<typeof jevBudget>,
  calls: number,
  maxCalls: number,
): Stop | undefined {
  if (budget.stopReason) return budget.stopReason;
  if (calls >= maxCalls) return 'call-cap';
  if (
    budget.reportedCostMicros + budget.maxPerCallMicros >
    budget.maxCostMicros
  )
    return 'cost-cap';
}

export function countJevQaStatuses(rows: readonly Pick<ReportRow, 'status'>[]) {
  const counts: Record<ResultStatus, number> = {
    unattempted: 0,
    'in-progress': 0,
    published: 0,
    retained: 0,
    cached: 0,
    ineligible: 0,
    obsolete: 0,
    retry: 0,
  };
  for (const row of rows) counts[row.status]++;
  return counts;
}

async function readJevQaRows(
  database: DatabaseInterface,
  ids: readonly string[],
  requestedIdentity?: string,
  pins: ReadonlyMap<string, CapturePin> = new Map(),
): Promise<Readback[]> {
  const { rows } = await database.query(
    `WITH selected(id, ordinal) AS (
       VALUES ${ids.map((_, index) => `(CAST(? AS TEXT), ${index})`).join(', ')}
     )
     SELECT selected.id AS selected_id, o.source_content_version, o.source_content_fingerprint, o.source_content_json,
       o.title, o.description_raw, o.locations, o.location_notes, o.work_mode,
       (s.is_active=TRUE AND s.public_listing=TRUE AND ${liveMatchingOpportunitySql('o', 'postgres')}) AS is_public,
       x.state AS proof_state, x.contract_version AS proof_contract_version,
       x.source_content_version AS proof_source_content_version, x.source_fingerprint AS proof_source_fingerprint,
       x.payload_json AS proof_payload, x.request_id AS proof_request_id, x.input_digest AS proof_input_digest,
       sv.revision AS current_source_revision, sl.revision AS current_listing_revision, vv.revision AS current_vocabulary_revision,
       f.source_revision AS facts_source_revision, f.source_listing_revision AS facts_listing_revision,
       f.vocabulary_revision AS facts_vocabulary_revision, f.work_revision AS facts_work_revision,
       f.policy_version AS facts_policy_version, f.facts_json
     FROM selected
     LEFT JOIN opportunities o ON CAST(o.id AS TEXT)=selected.id
     LEFT JOIN sources s ON s.id=o.source_id
     LEFT JOIN matching_source_interpretations x ON x.opportunity_id=selected.id
     LEFT JOIN matching_source_facts f ON f.opportunity_id=selected.id
     LEFT JOIN matching_source_versions sv ON sv.opportunity_id=selected.id
     LEFT JOIN matching_source_listing_versions sl ON sl.source_id=s.id
     LEFT JOIN matching_vocabulary_version vv ON vv.id=1
     ORDER BY selected.ordinal`,
    [...ids],
  );
  return rows.map((row) => {
    const pin = pins.get(String(row.selected_id));
    if (pin && !matchesJevQaCapturePin(pin, {
      id: row.selected_id,
      title: matchingPostingInput(row).title,
      fingerprint: row.source_content_fingerprint,
      digest: typeof row.source_content_json === 'string' ? fingerprint(row.source_content_json) : '',
    })) throw new Error('Selected public capture changed.');
    return describeJevQaReadback(row, requestedIdentity);
  });
}

/** The report path is exclusively reserved. Later checkpoints replace it atomically. */
export async function openJevQaReport(path: string | undefined) {
  if (!path) return async (_report: unknown) => {};
  const reserved = await open(path, 'wx', 0o600);
  await reserved.close();
  return async (report: unknown) => {
    const directory = await mkdtemp(join(dirname(path), '.jev-report-'));
    const temporary = join(directory, 'report.json');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
      await rmdir(directory);
    }
  };
}

export async function runLocalJevQa(
  options: ReturnType<typeof parseJevQaArguments>,
  env: NodeJS.ProcessEnv,
) {
  const url = verifiedJevQaDatabase(env.DATABASE_URL);
  const data = await readFile(options.cohort, 'utf8');
  if (data.length > 32768) throw new Error('Cohort file exceeds the limit.');
  const selection: unknown = JSON.parse(data);
  const pins = parseJevQaCapturePins(selection);
  const cohort = pins.size ? [...pins.keys()] : parseJevQaCohort(selection);
  const database = await resolveDatabase({ type: 'postgres', url });
  try {
    const selected = await readJevQaRows(database, cohort, undefined, pins);
    if (
      selected.length !== cohort.length ||
      selected.some((row) => !row.public)
    )
      throw new Error(
        'Every selected posting must be currently public and active.',
      );
    const results: ReportRow[] = selected.map((before, index) => ({
      index,
      ordinal: index + 1,
      ...(pins.get(cohort[index]) && { caseKey: pins.get(cohort[index])?.caseKey }),
      status: 'unattempted',
      result: 'unattempted',
      calls: 0,
      requested: null,
      before,
      current: before,
    }));
    if (!options.apply) {
      const saveReport = await openJevQaReport(options.report);
      const report = {
        mode: 'dry-run',
        state: 'complete',
        selected: cohort.length,
        results,
        counts: countJevQaStatuses(results),
      };
      await saveReport(report);
      return report;
    }

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
    const requested = publicDecision(profile);
    const pinned = await readJevQaRows(database, cohort, requested.identity, pins);
    for (const [index, before] of pinned.entries())
      Object.assign(results[index], { requested, before, current: before });
    const saveReport = await openJevQaReport(options.report);
    let stopReason: Stop | undefined;
    let state: 'running' | 'complete' | 'interrupted' = 'running';
    const report = () => ({
      mode: 'published-local',
      state,
      selected: cohort.length,
      results,
      counts: countJevQaStatuses(results),
      ...(stopReason && { stopReason }),
      meter: { ...meter, elapsedMs: Math.round(meter.elapsedMs) },
      budget: {
        ...budget,
        reportedCostMicros: budget.settledCalls
          ? budget.reportedCostMicros
          : null,
      },
    });
    await saveReport(report());
    const maxCalls = options.maxCalls ?? 0;
    const bounded: MatchingSourceDecisionProvider = {
      provenance: sdk.provenance,
      async decide(request) {
        if (meter.providerCalls >= maxCalls) {
          stopReason = 'call-cap';
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
    try {
      for (const [index, opportunityId] of cohort.entries()) {
        const row = results[index];
        if (row.before.public && row.before.proof.requested === 'latest') {
          Object.assign(row, { status: 'cached', result: 'idle' });
          await saveReport(report());
          continue;
        }
        stopReason ??= jevQaStop(budget, meter.providerCalls, maxCalls);
        if (stopReason) {
          if (stopReason === 'cost-cap') budget.stopReason = stopReason;
          row.stopReason = stopReason;
          continue;
        }
        row.status = 'in-progress';
        row.result = 'in-progress';
        await saveReport(report());
        const before = meter.providerCalls;
        let failure: string | undefined;
        let diagnostics: MatchingSourceJevDiagnostics | undefined;
        let structures: Record<string, string> | undefined;
        let assessments: MatchingSourceJevAssessments | undefined;
        const pin = pins.get(opportunityId);
        const result = await runMatchingSourceExtraction(
          database,
          'postgres',
          budget.maxCostMicros,
          {
            opportunityId,
            decisionProfile: profile,
            ...(pin && {
              expectedCapture: {
                fingerprint: pin.sourceFingerprint,
                sha256: pin.sourceDigest,
                title: pin.title,
              },
            }),
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
              if (stopReason || budget.stopReason || !observedModels.size)
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
        Object.assign(row, {
          result,
          calls: meter.providerCalls - before,
          ...(failure && { failure }),
          ...(diagnostics && { diagnostics }),
        });
        const [current] = await readJevQaRows(
          database,
          [opportunityId],
          requested.identity,
          pins,
        );
        stopReason ??= budget.stopReason ?? undefined;
        Object.assign(row, {
          status: classifyJevQaResult(result, row.before, current, failure),
          current,
          result,
          ...(stopReason && { stopReason }),
        });
        await saveReport(report());
      }
      const final = await readJevQaRows(database, cohort, requested.identity, pins);
      for (const [index, current] of final.entries())
        results[index].current = current;
      state = 'complete';
    } catch (error) {
      state = 'interrupted';
      await saveReport(report());
      throw error;
    }
    await saveReport(report());
    return report();
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
