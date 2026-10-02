import { createHash } from 'node:crypto';
import { type DecisionResult, getAI } from '@happyvertical/ai';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';
import { runAsRevalidatedJobWorkspaceSubject } from './job-workspace-subject.js';
import { assessmentDecisionOutputTokenCeiling } from './opportunity-assessment.js';
import { resolveOpportunityIntelligenceBudgetConfig } from './opportunity-intelligence-config.js';
import {
  attachOpportunityIntelligenceInvocationMetadata,
  executeGovernedOpportunityIntelligenceRequest,
  type OpportunityIntelligenceGovernanceStore,
} from './opportunity-intelligence-governance.js';
import {
  OPPORTUNITY_SCREENING_MAX_OUTPUT_TOKENS,
  OPPORTUNITY_SCREENING_MAX_REQUEST_BYTES,
  OPPORTUNITY_SCREENING_VERSION,
  type OpportunityScreeningResult,
  type PreparedOpportunityScreening,
  prepareOpportunityScreening,
  resolveOpportunityScreening,
} from './opportunity-screening.js';
import {
  candidateProfileWhere,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getCollection } from './smrt.js';

export const OPPORTUNITY_SCREENING_FEATURE = 'opportunity-screening';
export const OPPORTUNITY_SCREENING_PROFILE = 'typesafe-opportunity-screening';
type Row = Record<string, unknown>;
export interface OpportunityScreeningProviderDependencies {
  getOpportunity?: (id: string) => Promise<Row | null>;
  getProfile?: (id: string) => Promise<Row | null>;
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  database?: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>;
  };
}
export interface CurrentOpportunityAssessmentScreen {
  outcome: OpportunityScreeningResult['status'];
  agentRunId: string;
  requestId: string;
  /** Opaque native identity binds the request to its opportunity and private tuple. */
  inputFingerprint: string;
  reservation: { calls: number; reservedTokens: number; spendMicros: number };
  screen: OpportunityScreeningResult;
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('Screening requires an exact native identity.');
  return value;
}
function model(): string {
  return (
    process.env.OPPORTUNITY_ASSESSMENT_DECISION_MODEL?.trim() ||
    process.env.OPPORTUNITY_SKILL_DECISION_MODEL?.trim() ||
    'jev-latest'
  );
}
function inputFingerprint(
  prepared: PreparedOpportunityScreening,
  opportunityId: string,
  subject: WorkspaceSubject,
): string {
  return hash({
    version: OPPORTUNITY_SCREENING_VERSION,
    opportunityId,
    subject,
    prepared: prepared.inputFingerprint,
  });
}
async function nativeRow(
  collectionName: 'Opportunity' | 'CandidateProfile',
  identity: string,
): Promise<Row | null> {
  const row = await (await getCollection(collectionName)).get(
    { id: identity },
    { cache: false },
  );
  return row?.toJSON() ?? null;
}
async function loadPrepared(
  opportunityId: string,
  subject: WorkspaceSubject,
  deps: OpportunityScreeningProviderDependencies,
): Promise<PreparedOpportunityScreening> {
  const opportunity = await (
    deps.getOpportunity ?? ((identity) => nativeRow('Opportunity', identity))
  )(id(opportunityId));
  const profile = await (
    deps.getProfile ?? ((identity) => nativeRow('CandidateProfile', identity))
  )(subject.profileId);
  if (!opportunity || opportunity.id !== opportunityId)
    throw new Error('Current screening opportunity is missing.');
  if (
    !profile ||
    profile.id !== subject.profileId ||
    profile.active !== true ||
    Object.entries(candidateProfileWhere(subject)).some(
      ([key, value]) => profile[key] !== value,
    )
  )
    throw new Error(
      'Current screening profile is not active and owned by the selected workspace.',
    );
  return prepareOpportunityScreening({
    sourceContentJson: String(opportunity.sourceContentJson ?? ''),
    sourceContentFingerprint: String(
      opportunity.sourceContentFingerprint ?? '',
    ),
    sourceContentVersion: Number(opportunity.sourceContentVersion),
    profile,
  });
}
async function fresh<T>(
  opportunityId: string,
  supplied: WorkspaceSubject,
  deps: OpportunityScreeningProviderDependencies,
  work: (
    prepared: PreparedOpportunityScreening,
    subject: WorkspaceSubject,
  ) => Promise<T>,
): Promise<T> {
  const subject = requireWorkspaceSubject(supplied);
  return await (deps.runFresh ?? runAsRevalidatedJobWorkspaceSubject)(
    subject,
    'assessment.execute',
    async (current, run) => {
      await run.assertOperation('opportunities', 'read');
      return await work(
        await loadPrepared(opportunityId, current, deps),
        current,
      );
    },
  );
}
function samePrepared(
  expected: PreparedOpportunityScreening,
  current: PreparedOpportunityScreening,
): void {
  if (hash(expected) !== hash(current))
    throw new Error(
      'Screening source or selected profile changed; prepare current material before transport.',
    );
}
export async function prepareCurrentOpportunityAssessmentScreen(
  opportunityId: string,
  subject: WorkspaceSubject,
  dependencies: OpportunityScreeningProviderDependencies = {},
): Promise<PreparedOpportunityScreening> {
  return await fresh(
    opportunityId,
    subject,
    dependencies,
    async (prepared) => prepared,
  );
}
function nonNegative(value: unknown): number | undefined {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^\d+$/u.test(value))
  )
    return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
function positive(value: unknown): number | undefined {
  const n = nonNegative(value);
  return n !== undefined && n > 0 ? n : undefined;
}
function boundedRun(row: Row): boolean {
  // Governance settles completed requests into actual counters and releases
  // outstanding reservations. Check both sides of that native budget.
  if (
    !positive(row.run_actual_calls) ||
    nonNegative(row.run_actual_output_tokens) === undefined
  )
    return false;
  const dimensions = [
    ['run_calls', 'run_actual_calls', 'run_call_limit', 4],
    ['run_tokens', 'run_actual_tokens', 'run_token_limit', 80_000],
    ['run_spend', 'run_actual_spend', 'run_spend_limit', 100_000],
  ] as const;
  return dimensions.every(([reserved, actual, limit, maximum]) => {
    const outstanding = nonNegative(row[reserved]);
    const settled = nonNegative(row[actual]);
    const configured = positive(row[limit]);
    if (
      outstanding === undefined ||
      settled === undefined ||
      configured === undefined
    )
      return false;
    const total = outstanding + settled;
    return (
      Number.isSafeInteger(total) && total <= Math.min(configured, maximum)
    );
  });
}
async function receipt(
  prepared: PreparedOpportunityScreening,
  opportunityId: string,
  subject: WorkspaceSubject,
  requestId: string | undefined,
  deps: OpportunityScreeningProviderDependencies,
): Promise<CurrentOpportunityAssessmentScreen | undefined> {
  const database = deps.database ?? (await resolveDatabase(getDbConfig()));
  const expectedInput = inputFingerprint(prepared, opportunityId, subject);
  const configuredModel = model();
  const found = await database.query(
    `SELECT r.owner_request_id, r.request_id AS result_request_id, r.output_json,
    r.idempotency_key AS result_key, q.idempotency_key AS request_key, r.agent_run_id,
    r.opportunity_id, r.content_fingerprint, r.input_fingerprint, r.feature, r.profile, r.model,
    r.prompt_version, r.output_schema_version, r.prepared_payload_version, r.status AS result_status,
    r.tenant_id, r.owner_user_id, r.candidate_profile_id,
    q.request_id, q.status AS request_status, q.accounting_basis, q.actual_total_tokens,
    q.reserved_input_tokens, q.requested_max_output_tokens, q.reserved_spend_micros,
    q.tenant_id AS request_tenant_id, q.owner_user_id AS request_owner_user_id, q.candidate_profile_id AS request_candidate_profile_id,
    a.opportunity_id AS run_opportunity_id, a.tenant_id AS run_tenant_id, a.owner_user_id AS run_owner_user_id,
    a.candidate_profile_id AS run_candidate_profile_id, a.intelligence_reserved_calls AS run_calls,
    a.intelligence_reserved_input_tokens AS run_tokens, a.intelligence_reserved_spend_micros AS run_spend,
    a.intelligence_actual_calls AS run_actual_calls, a.intelligence_actual_input_tokens AS run_actual_tokens,
    a.intelligence_actual_output_tokens AS run_actual_output_tokens, a.intelligence_actual_spend_micros AS run_actual_spend,
    a.intelligence_call_limit AS run_call_limit, a.intelligence_input_token_limit AS run_token_limit,
    a.intelligence_spend_limit_micros AS run_spend_limit
    FROM opportunity_intelligence_results r JOIN opportunity_intelligence_requests q
      ON q.request_id = r.owner_request_id AND r.request_id = q.request_id AND q.idempotency_key = r.idempotency_key
      AND q.opportunity_id = r.opportunity_id AND q.agent_run_id = r.agent_run_id
      AND q.content_fingerprint = r.content_fingerprint AND q.input_fingerprint = r.input_fingerprint
      AND q.feature = r.feature AND q.profile = r.profile AND q.model = r.model
      AND q.tenant_id = r.tenant_id AND q.owner_user_id = r.owner_user_id AND q.candidate_profile_id = r.candidate_profile_id
    JOIN agent_runs a ON CAST(a.id AS TEXT) = CAST(q.agent_run_id AS TEXT)
    WHERE r.opportunity_id = ? AND r.content_fingerprint = ? AND r.input_fingerprint = ?
      AND r.feature = ? AND r.profile = ? AND r.model = ?
      AND r.prompt_version = ? AND r.output_schema_version = ? AND r.prepared_payload_version = ?
      AND r.tenant_id = ? AND r.owner_user_id = ? AND r.candidate_profile_id = ?
      AND r.status = 'completed' AND q.status = 'succeeded' AND q.accounting_basis = 'actual' AND q.actual_total_tokens > 0
      ${requestId ? 'AND r.owner_request_id = ?' : ''} LIMIT 2`,
    [
      opportunityId,
      prepared.sourceIdentity.sourceContentFingerprint,
      expectedInput,
      OPPORTUNITY_SCREENING_FEATURE,
      OPPORTUNITY_SCREENING_PROFILE,
      configuredModel,
      OPPORTUNITY_SCREENING_VERSION,
      OPPORTUNITY_SCREENING_VERSION,
      OPPORTUNITY_SCREENING_VERSION,
      subject.tenantId,
      subject.userId,
      subject.profileId,
      ...(requestId ? [id(requestId)] : []),
    ],
  );
  if (found.rows.length !== 1) return undefined;
  const row = found.rows[0];
  if (
    !row.owner_request_id ||
    row.owner_request_id !== row.request_id ||
    row.result_request_id !== row.request_id ||
    (requestId && row.request_id !== requestId) ||
    !row.result_key ||
    row.result_key !== row.request_key ||
    row.opportunity_id !== opportunityId ||
    row.content_fingerprint !==
      prepared.sourceIdentity.sourceContentFingerprint ||
    row.input_fingerprint !== expectedInput ||
    row.feature !== OPPORTUNITY_SCREENING_FEATURE ||
    row.profile !== OPPORTUNITY_SCREENING_PROFILE ||
    row.model !== configuredModel ||
    row.prompt_version !== OPPORTUNITY_SCREENING_VERSION ||
    row.output_schema_version !== OPPORTUNITY_SCREENING_VERSION ||
    row.prepared_payload_version !== OPPORTUNITY_SCREENING_VERSION ||
    row.result_status !== 'completed' ||
    row.request_status !== 'succeeded' ||
    row.accounting_basis !== 'actual' ||
    !positive(row.actual_total_tokens) ||
    row.run_opportunity_id !== opportunityId ||
    !boundedRun(row)
  )
    return undefined;
  for (const [key, expected] of [
    ['tenant_id', subject.tenantId],
    ['owner_user_id', subject.userId],
    ['candidate_profile_id', subject.profileId],
  ] as const)
    if (
      row[key] !== expected ||
      row[`request_${key}`] !== expected ||
      row[`run_${key}`] !== expected
    )
      return undefined;
  const reservedInput = positive(row.reserved_input_tokens);
  const output = positive(row.requested_max_output_tokens);
  const spend = positive(row.reserved_spend_micros);
  if (
    !reservedInput ||
    reservedInput !== prepared.requestBytes ||
    output !== prepared.maxOutputTokens ||
    spend === undefined
  )
    return undefined;
  try {
    const decision = JSON.parse(String(row.output_json)) as DecisionResult;
    if (
      decision.model !== configuredModel ||
      decision.provenance?.model !== configuredModel
    )
      return undefined;
    const screen = resolveOpportunityScreening(
      prepared,
      decision,
      id(row.request_id),
    );
    return {
      outcome: screen.status,
      agentRunId: id(row.agent_run_id),
      requestId: screen.requestId,
      inputFingerprint: expectedInput,
      reservation: {
        calls: 1,
        reservedTokens: reservedInput + output,
        spendMicros: spend,
      },
      screen,
    };
  } catch {
    return undefined;
  }
}
/** Provider-free replay of current PRIVATE actual native authority. */
export async function readCurrentOpportunityAssessmentScreen(
  input: {
    opportunityId: string;
    subject: WorkspaceSubject;
    requestId?: string;
  },
  dependencies: OpportunityScreeningProviderDependencies = {},
): Promise<CurrentOpportunityAssessmentScreen | undefined> {
  return await fresh(
    input.opportunityId,
    input.subject,
    dependencies,
    async (prepared, subject) =>
      await receipt(
        prepared,
        input.opportunityId,
        subject,
        input.requestId,
        dependencies,
      ),
  );
}
/** Any attempted exact identity, including failed/orphan/unfinished rows, prevents a new run reset. */
export async function assertOpportunityAssessmentScreenNotAttempted(
  prepared: PreparedOpportunityScreening,
  options: { opportunityId: string; workspaceSubject: WorkspaceSubject },
  dependencies: OpportunityScreeningProviderDependencies = {},
): Promise<void> {
  await fresh(
    options.opportunityId,
    options.workspaceSubject,
    dependencies,
    async (current, subject) => {
      samePrepared(prepared, current);
      const database =
        dependencies.database ?? (await resolveDatabase(getDbConfig()));
      const found = await database.query(
        `SELECT request_id FROM opportunity_intelligence_requests
      WHERE opportunity_id = ? AND content_fingerprint = ? AND input_fingerprint = ?
      AND feature = ? AND profile = ? AND model = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ? LIMIT 1`,
        [
          options.opportunityId,
          current.sourceIdentity.sourceContentFingerprint,
          inputFingerprint(current, options.opportunityId, subject),
          OPPORTUNITY_SCREENING_FEATURE,
          OPPORTUNITY_SCREENING_PROFILE,
          model(),
          subject.tenantId,
          subject.userId,
          subject.profileId,
        ],
      );
      if (found.rows.length)
        throw new Error(
          'This exact private screening identity was already attempted; reuse its actual completed receipt or request operator review.',
        );
    },
  );
}
export async function evaluateOpportunityAssessmentScreen(
  prepared: PreparedOpportunityScreening,
  options: {
    agentRunId: string;
    opportunityId: string;
    contentFingerprint: string;
    workspaceSubject: WorkspaceSubject;
    signal?: AbortSignal;
    store?: OpportunityIntelligenceGovernanceStore;
  },
  dependencies: OpportunityScreeningProviderDependencies = {},
): Promise<CurrentOpportunityAssessmentScreen> {
  if (process.env.OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED !== 'true')
    throw new Error('Private opportunity screening is disabled.');
  return await fresh(
    options.opportunityId,
    options.workspaceSubject,
    dependencies,
    async (current, subject) => {
      samePrepared(prepared, current);
      id(options.agentRunId);
      if (
        options.contentFingerprint !==
        current.sourceIdentity.sourceContentFingerprint
      )
        throw new Error('Screening requires current native source identity.');
      const config = resolveOpportunityIntelligenceBudgetConfig();
      if (
        current.version !== OPPORTUNITY_SCREENING_VERSION ||
        Object.keys(current.request.questions).length !== 14 ||
        current.maxOutputTokens !==
          assessmentDecisionOutputTokenCeiling(current.request) ||
        current.maxOutputTokens > OPPORTUNITY_SCREENING_MAX_OUTPUT_TOKENS ||
        current.requestBytes !==
          Buffer.byteLength(JSON.stringify(current.request), 'utf8') ||
        current.requestBytes > OPPORTUNITY_SCREENING_MAX_REQUEST_BYTES ||
        current.requestBytes + current.maxOutputTokens >
          Math.min(80_000, config.run.inputTokens)
      )
        throw new Error(
          'Screening request exceeds its exact coarse request or lifecycle bound.',
        );
      const price = (name: string) => {
        const value = process.env[name];
        if (
          !value ||
          !/^\d+$/u.test(value) ||
          !Number.isSafeInteger(Number(value))
        )
          throw new Error(
            `Configure ${name} for private screening accounting.`,
          );
        return Number(value);
      };
      config.pricing = {
        configured: true,
        inputMicrosPerMillion: price(
          'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
        ),
        outputMicrosPerMillion: price(
          'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
        ),
      };
      const apiKey = process.env.TYPESAFE_API_KEY?.trim();
      if (!apiKey)
        throw new Error('TYPESAFE_API_KEY is required for private screening.');
      const configuredModel = model();
      const response =
        await executeGovernedOpportunityIntelligenceRequest<DecisionResult>({
          config,
          estimatedInputTokens: current.requestBytes,
          inputTokenCeiling: current.requestBytes,
          maxOutputTokens: current.maxOutputTokens,
          identity: {
            agentRunId: options.agentRunId,
            opportunityId: options.opportunityId,
            contentFingerprint: current.sourceIdentity.sourceContentFingerprint,
            inputFingerprint: inputFingerprint(
              current,
              options.opportunityId,
              subject,
            ),
            feature: OPPORTUNITY_SCREENING_FEATURE,
            profile: OPPORTUNITY_SCREENING_PROFILE,
            model: configuredModel,
            promptVersion: OPPORTUNITY_SCREENING_VERSION,
            outputSchemaVersion: OPPORTUNITY_SCREENING_VERSION,
            preparedPayloadVersion: OPPORTUNITY_SCREENING_VERSION,
          },
          workspaceSubject: subject,
          signal: options.signal,
          store: options.store,
          invoke: async (requestId) => {
            if (process.env.OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED !== 'true')
              throw new Error('Private opportunity screening is disabled.');
            await fresh(
              options.opportunityId,
              subject,
              dependencies,
              async (before) => samePrepared(current, before),
            );
            const client = await getAI({
              type: 'typesafe',
              apiKey,
              defaultModel: configuredModel,
            });
            if (!(await client.getCapabilities()).decisions || !client.decide)
              throw new Error(
                'Private screening requires typed provider decisions.',
              );
            const result = await client.decide(current.request, {
              model: configuredModel,
              signal: options.signal,
              timeout: 30_000,
            });
            try {
              await fresh(
                options.opportunityId,
                subject,
                dependencies,
                async (after) => samePrepared(current, after),
              );
              if (
                result.model !== configuredModel ||
                result.provenance?.model !== configuredModel
              )
                throw new Error(
                  'Screening provider model provenance is not current.',
                );
              resolveOpportunityScreening(current, result, requestId);
            } catch (error) {
              throw attachOpportunityIntelligenceInvocationMetadata(error, {
                usage: result.usage,
                providerRequestId: requestId,
              });
            }
            return {
              output: result,
              usage: result.usage,
              providerRequestId: requestId,
            };
          },
        });
      const actual = await readCurrentOpportunityAssessmentScreen(
        {
          opportunityId: options.opportunityId,
          subject,
          requestId: response.requestId,
        },
        dependencies,
      );
      if (
        !actual ||
        (!response.reused && actual.agentRunId !== options.agentRunId)
      )
        throw new Error(
          'Private screening completion lacks its exact current successful actual native receipt.',
        );
      return actual;
    },
  );
}
