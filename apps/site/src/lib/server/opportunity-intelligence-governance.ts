import { createHash, randomUUID } from 'node:crypto';
import type { TokenUsage } from '@happyvertical/ai';
import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import { assertAiEnabled, reserveAiUserSpend } from './ai-usage-guard.js';
import { bumpOpportunityTableChangeFeed } from './change-feed.js';
import { getDbConfig } from './db.js';
import {
  OPPORTUNITY_INTELLIGENCE_PROVIDER_WINDOW_LIMITS,
  OPPORTUNITY_INTELLIGENCE_TYPESAFE_VOLUME_CONTRACTS,
  type OpportunityIntelligenceBudgetConfig,
  opportunityIntelligenceProviderVolume,
  pricingForOpportunityIntelligenceModel,
  reservedRequestSpendMicros,
  resolveOpportunityIntelligenceBudgetConfig,
} from './opportunity-intelligence-config.js';
import {
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getCollection } from './smrt.js';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';

export const OPPORTUNITY_INTELLIGENCE_CONTROL_KEY = 'opportunity-intelligence';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

function sqliteGovernanceDatabase(db: SmrtDatabase): boolean {
  return Boolean(db.url && detectEngine(db.url) === 'sqlite');
}

function governanceRowLock(db: SmrtDatabase): string {
  return sqliteGovernanceDatabase(db) ? '' : ' FOR UPDATE';
}

async function withGovernanceWriteLock<T>(
  db: SmrtDatabase,
  work: () => Promise<T>,
): Promise<T> {
  // The shared control window and each run/crawl budget belong to one ledger.
  // SQLite has no row locks: serialize the entire short write transaction,
  // including rollback/circuit transitions, across handles and processes.
  return sqliteGovernanceDatabase(db)
    ? await withSqliteOperationLock('opportunity-intelligence-governance', work)
    : await work();
}

export type OpportunityIntelligenceGovernanceErrorCode =
  | 'accounting_required'
  | 'budget_exhausted'
  | 'budget_missing'
  | 'circuit_open'
  | 'disabled'
  | 'duplicate_in_progress'
  | 'input_ceiling_exceeded'
  | 'pricing_missing'
  | 'prior_attempt_failed';

export class OpportunityIntelligenceGovernanceError extends Error {
  code: OpportunityIntelligenceGovernanceErrorCode;

  constructor(
    code: OpportunityIntelligenceGovernanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpportunityIntelligenceGovernanceError';
    this.code = code;
  }
}

export interface OpportunityIntelligenceRequestIdentity {
  agentRunId: string;
  contentFingerprint: string;
  feature: string;
  inputFingerprint?: string;
  model: string;
  opportunityId: string;
  outputSchemaVersion: string;
  preparedPayloadVersion: string;
  profile: string;
  promptVersion: string;
  sourceCrawlId?: string;
  sourceCrawlItemId?: string;
}

export interface OpportunityIntelligenceReservation
  extends OpportunityIntelligenceRequestIdentity {
  estimatedInputTokens: number;
  idempotencyKey: string;
  inputTokenCeiling: number;
  maxOutputTokens: number;
  requestId: string;
  reservedInputTokens: number;
  reservedSpendMicros: number;
  /** Present only for a verified candidate-owned assessment reservation. */
  workspaceSubject?: WorkspaceSubject;
}

export type OpportunityIntelligenceReserveResult<T> =
  | { kind: 'owner'; reservation: OpportunityIntelligenceReservation }
  | { kind: 'reused'; output: T; requestId: string }
  | {
      code: OpportunityIntelligenceGovernanceErrorCode;
      kind: 'blocked';
      message: string;
    };

export interface OpportunityIntelligenceTerminalResult<T> {
  accountingBasis?: OpportunityIntelligenceUsageAccountingBasis;
  durationMs: number;
  errorCode?: string;
  output?: T;
  providerRequestId?: string;
  status: 'aborted' | 'failed' | 'succeeded' | 'timed_out';
  usage?: TokenUsage;
}

export type OpportunityIntelligenceUsageAccountingBasis =
  | 'actual'
  | 'conservative'
  | 'missing';

export interface OpportunityIntelligenceGovernanceStore {
  complete<T>(
    reservation: OpportunityIntelligenceReservation,
    terminal: OpportunityIntelligenceTerminalResult<T> & {
      actualSpendMicros: number;
    },
  ): Promise<void>;
  reserve<T>(
    reservation: OpportunityIntelligenceReservation,
  ): Promise<OpportunityIntelligenceReserveResult<T>>;
  openCircuit?(reason: string): Promise<void>;
}

interface OpportunityIntelligenceInvocationMetadata {
  providerRequestId?: string;
  usage?: TokenUsage;
}

const invocationMetadata = new WeakMap<
  object,
  OpportunityIntelligenceInvocationMetadata
>();

export function attachOpportunityIntelligenceInvocationMetadata(
  error: unknown,
  metadata: OpportunityIntelligenceInvocationMetadata,
): unknown {
  if (error && typeof error === 'object') {
    invocationMetadata.set(error, metadata);
  }
  return error;
}

type OpportunityIntelligenceBlockedResult = Extract<
  OpportunityIntelligenceReserveResult<never>,
  { kind: 'blocked' }
>;

class ReservationBlocked extends Error {
  constructor(
    readonly result: OpportunityIntelligenceBlockedResult,
    readonly circuitReason = '',
  ) {
    super(result.message);
    this.name = 'ReservationBlocked';
  }
}

interface DatabaseRow extends Record<string, unknown> {
  id?: unknown;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value);
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function nonNegativeIntegerValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function boundedNonNegativeIntegerValue(
  value: unknown,
  hardMaximum: number,
): number | null {
  const parsed = nonNegativeIntegerValue(value);
  return parsed !== null && parsed <= hardMaximum ? parsed : null;
}

export function normalizeOpportunityIntelligenceCircuitThreshold(
  value: unknown,
  fallback: number | null,
  hardMaximum: number,
): number {
  const parsed = nonNegativeIntegerValue(
    value === undefined ? fallback : value,
  );
  if (parsed === null) {
    throw new Error(
      'Opportunity intelligence circuit thresholds must be non-negative integers.',
    );
  }
  return Math.min(parsed, hardMaximum);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseOutput<T>(value: unknown): T {
  if (typeof value !== 'string' || !value.trim()) return {} as T;
  return JSON.parse(value) as T;
}

function errorCode(error: unknown): string {
  if (error instanceof OpportunityIntelligenceGovernanceError) {
    return error.code;
  }
  if (error && typeof error === 'object') {
    return (
      stringValue((error as Record<string, unknown>).code) || 'request_failed'
    );
  }
  return 'request_failed';
}

function terminalStatus(
  error: unknown,
  signal?: AbortSignal,
): OpportunityIntelligenceTerminalResult<never>['status'] {
  if (signal?.aborted) {
    const reason = stringValue(signal.reason);
    return /timeout/i.test(reason) ? 'timed_out' : 'aborted';
  }
  return /timeout/i.test(errorCode(error)) ? 'timed_out' : 'failed';
}

export function opportunityIntelligenceIdempotencyKey(
  identity: OpportunityIntelligenceRequestIdentity,
): string {
  const values = [
    identity.contentFingerprint,
    identity.preparedPayloadVersion,
    identity.promptVersion,
    identity.profile,
    identity.model,
    identity.outputSchemaVersion,
    identity.feature,
  ];
  if (values.some((value) => !stringValue(value))) {
    throw new OpportunityIntelligenceGovernanceError(
      'budget_missing',
      'Complete idempotency provenance is required before paid intelligence work.',
    );
  }
  if (stringValue(identity.inputFingerprint)) {
    values.push(stringValue(identity.inputFingerprint));
  }
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function scopedOpportunityIntelligenceIdempotencyKey(
  identity: OpportunityIntelligenceRequestIdentity,
  workspaceSubject?: WorkspaceSubject,
): string {
  const base = opportunityIntelligenceIdempotencyKey(identity);
  if (!workspaceSubject) return base;
  const subject = requireWorkspaceSubject(workspaceSubject);
  // Candidate assessment results must not suppress or reuse another
  // workspace's result even if an upstream caller accidentally reuses an
  // otherwise complete request identity. Operator ledger identities remain
  // byte-for-byte unchanged.
  return createHash('sha256')
    .update(
      JSON.stringify({
        base,
        profileId: subject.profileId,
        tenantId: subject.tenantId,
        userId: subject.userId,
      }),
    )
    .digest('hex');
}

function requestCostMicros(
  usage: TokenUsage,
  pricing: OpportunityIntelligenceBudgetConfig['pricing'],
): number {
  return reservedRequestSpendMicros({
    inputTokens: numberValue(usage.promptTokens),
    maxOutputTokens: numberValue(usage.completionTokens),
    pricing,
  });
}

function queryRow(result: { rows?: DatabaseRow[] }): DatabaseRow | null {
  return result.rows?.[0] ?? null;
}

function reservationOwnership(reservation: OpportunityIntelligenceReservation) {
  return {
    candidateProfileId: reservation.workspaceSubject?.profileId ?? '',
    ownerUserId: reservation.workspaceSubject?.userId ?? '',
    tenantId: reservation.workspaceSubject?.tenantId ?? '',
  };
}

function ownershipPredicate(prefix = ''): string {
  const column = (name: string) => `${prefix}${name}`;
  return [
    `COALESCE(${column('tenant_id')}, '') = ?`,
    `COALESCE(${column('owner_user_id')}, '') = ?`,
    `COALESCE(${column('candidate_profile_id')}, '') = ?`,
  ].join(' AND ');
}

function ownershipValues(
  reservation: OpportunityIntelligenceReservation,
): string[] {
  const ownership = reservationOwnership(reservation);
  return [
    ownership.tenantId,
    ownership.ownerUserId,
    ownership.candidateProfileId,
  ];
}

function budgetBlock(reason: string): OpportunityIntelligenceBlockedResult {
  return {
    code: 'budget_exhausted',
    kind: 'blocked',
    message: `Opportunity intelligence budget exhausted (${reason}).`,
  };
}

function blocked(
  code: OpportunityIntelligenceGovernanceErrorCode,
  message: string,
): OpportunityIntelligenceBlockedResult {
  return { code, kind: 'blocked', message };
}

async function reserveBudgetRow(
  db: SmrtDatabase,
  table: 'agent_runs' | 'source_crawls',
  id: string,
  reservation: OpportunityIntelligenceReservation,
): Promise<'ok' | 'missing' | 'calls' | 'input_tokens' | 'spend'> {
  const ownerScoped =
    table === 'agent_runs' && Boolean(reservation.workspaceSubject);
  const predicate = ownerScoped ? ` AND ${ownershipPredicate()}` : '';
  const ownership = ownerScoped ? ownershipValues(reservation) : [];
  const result = await db.query(
    `SELECT * FROM ${table} WHERE id = ?${predicate}${governanceRowLock(db)}`,
    [id, ...ownership],
  );
  const row = queryRow(result);
  if (!row) return 'missing';
  const callLimit = numberValue(row.intelligence_call_limit);
  const tokenLimit = numberValue(row.intelligence_input_token_limit);
  const spendLimit = numberValue(row.intelligence_spend_limit_micros);
  if (callLimit <= 0 || tokenLimit <= 0 || spendLimit <= 0) return 'missing';
  if (
    numberValue(row.intelligence_reserved_calls) +
      numberValue(row.intelligence_actual_calls) +
      1 >
    callLimit
  ) {
    return 'calls';
  }
  if (
    numberValue(row.intelligence_reserved_input_tokens) +
      numberValue(row.intelligence_actual_input_tokens) +
      reservation.reservedInputTokens >
    tokenLimit
  ) {
    return 'input_tokens';
  }
  if (
    numberValue(row.intelligence_reserved_spend_micros) +
      numberValue(row.intelligence_actual_spend_micros) +
      reservation.reservedSpendMicros >
    spendLimit
  ) {
    return 'spend';
  }
  await db.query(
    `
      UPDATE ${table}
      SET intelligence_reserved_calls = intelligence_reserved_calls + 1,
          intelligence_reserved_input_tokens = intelligence_reserved_input_tokens + ?,
          intelligence_reserved_spend_micros = intelligence_reserved_spend_micros + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?${predicate}
    `,
    [
      reservation.reservedInputTokens,
      reservation.reservedSpendMicros,
      id,
      ...ownership,
    ],
  );
  return 'ok';
}

async function settleBudgetRow(
  db: SmrtDatabase,
  table: 'agent_runs' | 'source_crawls',
  id: string,
  reservation: OpportunityIntelligenceReservation,
  usage: TokenUsage,
  actualSpendMicros: number,
): Promise<void> {
  if (!id) return;
  const ownerScoped =
    table === 'agent_runs' && Boolean(reservation.workspaceSubject);
  const predicate = ownerScoped ? ` AND ${ownershipPredicate()}` : '';
  const ownership = ownerScoped ? ownershipValues(reservation) : [];
  const floor = sqliteGovernanceDatabase(db) ? 'MAX' : 'GREATEST';
  await db.query(
    `
      UPDATE ${table}
      SET intelligence_reserved_calls = ${floor}(0, intelligence_reserved_calls - 1),
          intelligence_reserved_input_tokens = ${floor}(0, intelligence_reserved_input_tokens - ?),
          intelligence_reserved_spend_micros = ${floor}(0, intelligence_reserved_spend_micros - ?),
          intelligence_actual_calls = intelligence_actual_calls + 1,
          intelligence_actual_input_tokens = intelligence_actual_input_tokens + ?,
          intelligence_actual_output_tokens = intelligence_actual_output_tokens + ?,
          intelligence_actual_spend_micros = intelligence_actual_spend_micros + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?${predicate}
    `,
    [
      reservation.reservedInputTokens,
      reservation.reservedSpendMicros,
      numberValue(usage.promptTokens),
      numberValue(usage.completionTokens),
      actualSpendMicros,
      id,
      ...ownership,
    ],
  );
}

function windowTimestamp(value: unknown): number | null {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validVolumeCounter(value: unknown): number {
  const number = boundedNonNegativeIntegerValue(value, Number.MAX_SAFE_INTEGER);
  if (number === null)
    throw new ReservationBlocked(
      blocked(
        'budget_missing',
        'Provider window accounting is missing or malformed.',
      ),
      'provider_window_accounting_invalid',
    );
  return number;
}

/** Called inside the main locked transaction; native ledger history is authority. */
async function providerVolumeReservation(
  db: SmrtDatabase,
  control: DatabaseRow,
  reservation: OpportunityIntelligenceReservation,
  requestThreshold: number,
  inputTokenThreshold: number,
) {
  const provider = opportunityIntelligenceProviderVolume(reservation);
  const limits = OPPORTUNITY_INTELLIGENCE_PROVIDER_WINDOW_LIMITS[provider];
  const anchor = windowTimestamp(control.window_started_at);
  if (anchor === null) {
    if (provider === 'typesafe')
      throw new ReservationBlocked(
        blocked(
          'budget_missing',
          'An explicitly accounted native window is required for JEV admission.',
        ),
        'provider_window_anchor_missing',
      );
    // Older controls retain their conservative shared counters until an
    // operator establishes an anchor. They cannot obtain the JEV allowance.
    return {
      provider,
      id: '',
      requests: validVolumeCounter(control.window_request_count) + 1,
      tokens:
        validVolumeCounter(control.window_input_tokens) +
        reservation.reservedInputTokens,
      requestThreshold: Math.min(requestThreshold, limits.requests),
      inputTokenThreshold: Math.min(inputTokenThreshold, limits.inputTokens),
    };
  }
  const key = `${OPPORTUNITY_INTELLIGENCE_CONTROL_KEY}:volume:${provider}`;
  const existing = await db.query(
    `SELECT * FROM opportunity_intelligence_controls WHERE control_key = ?${governanceRowLock(db)}`,
    [key],
  );
  if (existing.rows.length > 1)
    throw new ReservationBlocked(
      blocked('budget_missing', 'Provider window identity is ambiguous.'),
      'provider_window_accounting_invalid',
    );
  const row = queryRow(existing);
  const rowAnchor = row ? windowTimestamp(row.window_started_at) : null;
  if (row && rowAnchor === null)
    throw new ReservationBlocked(
      blocked('budget_missing', 'Provider window anchor is malformed.'),
      'provider_window_accounting_invalid',
    );
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const contract of OPPORTUNITY_INTELLIGENCE_TYPESAFE_VOLUME_CONTRACTS) {
    const versions = [...contract.versions, ...contract.historicalVersions];
    conditions.push(
      `(q.feature = ? AND q.profile = ? AND r.output_schema_version IN (${versions.map(() => '?').join(', ')}))`,
    );
    params.push(contract.feature, contract.profile, ...versions);
  }
  const known = `q.provider IN ('bifrost', 'typesafe') AND (${conditions.join(' OR ')}) AND r.prompt_version = r.output_schema_version AND r.prepared_payload_version = r.output_schema_version`;
  const filter = sqliteGovernanceDatabase(db)
    ? 'datetime(q.started_at) >= datetime(?)'
    : 'q.started_at >= ?';
  const ledger = queryRow(
    await db.query(
      `SELECT COALESCE(SUM(CASE WHEN ${known} THEN 1 ELSE 0 END), 0) AS typesafe_requests,
    COALESCE(SUM(CASE WHEN ${known} THEN q.reserved_input_tokens ELSE 0 END), 0) AS typesafe_tokens,
    COUNT(*) AS total_requests, COALESCE(SUM(q.reserved_input_tokens), 0) AS total_tokens
    FROM opportunity_intelligence_requests q LEFT JOIN opportunity_intelligence_results r
      ON r.owner_request_id = q.request_id AND r.request_id = q.request_id AND r.idempotency_key = q.idempotency_key
      AND r.opportunity_id = q.opportunity_id AND r.content_fingerprint = q.content_fingerprint AND r.input_fingerprint = q.input_fingerprint
      AND r.feature = q.feature AND r.profile = q.profile AND r.model = q.model AND q.model <> ''
      AND r.agent_run_id = q.agent_run_id AND COALESCE(r.source_crawl_id, '') = COALESCE(q.source_crawl_id, '')
      AND COALESCE(r.source_crawl_item_id, '') = COALESCE(q.source_crawl_item_id, '')
      AND COALESCE(r.tenant_id, '') = COALESCE(q.tenant_id, '') AND COALESCE(r.owner_user_id, '') = COALESCE(q.owner_user_id, '')
      AND COALESCE(r.candidate_profile_id, '') = COALESCE(q.candidate_profile_id, '')
    WHERE ${filter}`,
      [...params, ...params, control.window_started_at],
    ),
  );
  const typesafeRequests = validVolumeCounter(ledger?.typesafe_requests);
  const typesafeTokens = validVolumeCounter(ledger?.typesafe_tokens);
  const totalRequests = validVolumeCounter(ledger?.total_requests);
  const totalTokens = validVolumeCounter(ledger?.total_tokens);
  const historicRequests =
    provider === 'typesafe'
      ? typesafeRequests
      : totalRequests - typesafeRequests;
  const historicTokens =
    provider === 'typesafe' ? typesafeTokens : totalTokens - typesafeTokens;
  if (historicRequests < 0 || historicTokens < 0)
    throw new ReservationBlocked(
      blocked('budget_missing', 'Provider ledger projection is inconsistent.'),
      'provider_window_accounting_invalid',
    );
  const sameWindow = rowAnchor === anchor;
  const requests =
    Math.max(
      historicRequests,
      sameWindow ? validVolumeCounter(row?.window_request_count) : 0,
    ) + 1;
  const tokens =
    Math.max(
      historicTokens,
      sameWindow ? validVolumeCounter(row?.window_input_tokens) : 0,
    ) + reservation.reservedInputTokens;
  let chosenRequests =
    provider === 'typesafe'
      ? limits.requests
      : Math.min(requestThreshold, limits.requests);
  let chosenTokens =
    provider === 'typesafe'
      ? limits.inputTokens
      : Math.min(inputTokenThreshold, limits.inputTokens);
  if (sameWindow && row) {
    chosenRequests = Math.min(
      chosenRequests,
      validVolumeCounter(row.request_threshold),
    );
    chosenTokens = Math.min(
      chosenTokens,
      validVolumeCounter(row.input_token_threshold),
    );
  }
  const id = row ? stringValue(row.id) : randomUUID();
  if (!row)
    await db.query(
      `INSERT INTO opportunity_intelligence_controls
    (id, slug, context, control_key, enabled, circuit_state, circuit_reason, window_request_count, window_input_tokens,
     request_threshold, input_token_threshold, window_started_at, created_at, updated_at)
    VALUES (?, ?, '', ?, TRUE, 'closed', '', 0, 0, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, key, key, chosenRequests, chosenTokens, control.window_started_at],
    );
  return {
    provider,
    id,
    requests,
    tokens,
    requestThreshold: chosenRequests,
    inputTokenThreshold: chosenTokens,
  };
}

export class DatabaseOpportunityIntelligenceGovernanceStore
  implements OpportunityIntelligenceGovernanceStore
{
  constructor(private readonly database?: SmrtDatabase) {}

  private async db(): Promise<SmrtDatabase> {
    return this.database ?? (await resolveDatabase(getDbConfig()));
  }

  async openCircuit(reason: string): Promise<void> {
    const db = await this.db();
    await withGovernanceWriteLock(db, () =>
      this.openCircuitUnlocked(db, reason),
    );
  }

  private async openCircuitUnlocked(
    db: SmrtDatabase,
    reason: string,
  ): Promise<void> {
    await db.query(
      `
        UPDATE opportunity_intelligence_controls
        SET circuit_state = 'open', circuit_reason = ?,
            opened_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE control_key = ?
      `,
      [reason, OPPORTUNITY_INTELLIGENCE_CONTROL_KEY],
    );
  }

  async reserve<T>(
    reservation: OpportunityIntelligenceReservation,
  ): Promise<OpportunityIntelligenceReserveResult<T>> {
    const db = await this.db();
    if (!db.transaction) {
      return blocked(
        'budget_missing',
        'Transactional budget reservation is required for paid intelligence work.',
      );
    }
    const runTransaction = db.transaction.bind(db);
    return await withGovernanceWriteLock(db, async () => {
      try {
        return await runTransaction(async (transaction) => {
          const resultId = randomUUID();
          const inserted = await transaction.query(
            `
          INSERT INTO opportunity_intelligence_results (
            id, slug, context, idempotency_key, opportunity_id,
            tenant_id, owner_user_id, candidate_profile_id,
            source_crawl_id, source_crawl_item_id, agent_run_id,
            content_fingerprint, input_fingerprint, prepared_payload_version, prompt_version,
            output_schema_version, feature, profile, model, status,
            owner_request_id, request_id, output_json, error_code,
            started_at, created_at, updated_at
          ) VALUES (
            ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'started', ?, ?, '{}', '', CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id
        `,
            [
              resultId,
              reservation.idempotencyKey,
              reservation.idempotencyKey,
              reservation.opportunityId,
              ...ownershipValues(reservation),
              reservation.sourceCrawlId ?? '',
              reservation.sourceCrawlItemId ?? '',
              reservation.agentRunId,
              reservation.contentFingerprint,
              reservation.inputFingerprint ?? '',
              reservation.preparedPayloadVersion,
              reservation.promptVersion,
              reservation.outputSchemaVersion,
              reservation.feature,
              reservation.profile,
              reservation.model,
              reservation.requestId,
              reservation.requestId,
            ],
          );
          // LibSQL can report zero affected rows for INSERT ... RETURNING.
          // The returned, freshly generated ID proves this transaction owns
          // the insert; DO NOTHING returns no row for an existing key.
          const ownsResult = sqliteGovernanceDatabase(transaction)
            ? inserted.rows.length === 1 &&
              stringValue(inserted.rows[0]?.id) === resultId
            : inserted.rowCount > 0;
          if (!ownsResult) {
            const existing = queryRow(
              await transaction.query(
                `SELECT * FROM opportunity_intelligence_results
               WHERE idempotency_key = ? AND ${ownershipPredicate()}
               ${governanceRowLock(transaction)}`,
                [reservation.idempotencyKey, ...ownershipValues(reservation)],
              ),
            );
            if (stringValue(existing?.status) === 'completed') {
              return {
                kind: 'reused',
                output: parseOutput<T>(existing?.output_json),
                requestId: stringValue(existing?.request_id),
              };
            }
            const failed = stringValue(existing?.status) === 'failed';
            return {
              code: failed ? 'prior_attempt_failed' : 'duplicate_in_progress',
              kind: 'blocked',
              message: failed
                ? 'This idempotency key has a prior terminal failure and requires operator review.'
                : 'An identical opportunity intelligence request is already active.',
            };
          }

          const control = queryRow(
            await transaction.query(
              `SELECT * FROM opportunity_intelligence_controls WHERE control_key = ?${governanceRowLock(transaction)}`,
              [OPPORTUNITY_INTELLIGENCE_CONTROL_KEY],
            ),
          );
          if (!control || !booleanValue(control.enabled)) {
            throw new ReservationBlocked(
              blocked(
                'disabled',
                'Opportunity intelligence is disabled in persisted control state.',
              ),
            );
          }
          if (stringValue(control.circuit_state) !== 'closed') {
            throw new ReservationBlocked(
              blocked(
                'circuit_open',
                `Opportunity intelligence circuit is open (${stringValue(control.circuit_reason) || 'unspecified'}).`,
              ),
            );
          }

          const nextRequests =
            validVolumeCounter(control.window_request_count) + 1;
          const nextTokens =
            validVolumeCounter(control.window_input_tokens) +
            reservation.reservedInputTokens;
          const requestThreshold = boundedNonNegativeIntegerValue(
            control.request_threshold,
            100,
          );
          if (requestThreshold === null) {
            throw new ReservationBlocked(
              blocked(
                'budget_missing',
                'Persisted opportunity intelligence request threshold is missing or invalid.',
              ),
              'request_volume_threshold_invalid',
            );
          }
          const inputTokenThreshold = boundedNonNegativeIntegerValue(
            control.input_token_threshold,
            1_000_000,
          );
          if (inputTokenThreshold === null) {
            throw new ReservationBlocked(
              blocked(
                'budget_missing',
                'Persisted opportunity intelligence input-token threshold is missing or invalid.',
              ),
              'input_token_threshold_invalid',
            );
          }
          const volume = await providerVolumeReservation(
            transaction,
            control,
            reservation,
            requestThreshold,
            inputTokenThreshold,
          );
          if (volume.requests > volume.requestThreshold)
            throw new ReservationBlocked(
              budgetBlock(`${volume.provider} window requests`),
            );
          if (volume.tokens > volume.inputTokenThreshold)
            throw new ReservationBlocked(
              budgetBlock(`${volume.provider} window input tokens`),
            );

          const runBudget = await reserveBudgetRow(
            transaction,
            'agent_runs',
            reservation.agentRunId,
            reservation,
          );
          if (runBudget === 'missing') {
            throw new ReservationBlocked(
              blocked(
                'budget_missing',
                'Required AgentRun budget state is missing.',
              ),
              'run_budget_missing',
            );
          }
          if (runBudget !== 'ok') {
            throw new ReservationBlocked(
              budgetBlock(`run ${runBudget}`),
              `run_${runBudget}_budget_exhausted`,
            );
          }
          if (reservation.sourceCrawlId) {
            const crawlBudget = await reserveBudgetRow(
              transaction,
              'source_crawls',
              reservation.sourceCrawlId,
              reservation,
            );
            if (crawlBudget === 'missing') {
              throw new ReservationBlocked(
                blocked(
                  'budget_missing',
                  'Required source crawl budget state is missing.',
                ),
                'crawl_budget_missing',
              );
            }
            if (crawlBudget !== 'ok') {
              throw new ReservationBlocked(
                budgetBlock(`crawl ${crawlBudget}`),
                `crawl_${crawlBudget}_budget_exhausted`,
              );
            }
          }

          await transaction.query(
            `
          INSERT INTO opportunity_intelligence_requests (
            id, slug, context, request_id, provider_request_id,
            idempotency_key, feature, source_crawl_id, source_crawl_item_id,
            opportunity_id, tenant_id, owner_user_id, candidate_profile_id,
            agent_run_id, content_fingerprint, input_fingerprint, profile, model,
            provider, status, attempts, estimated_input_tokens,
            input_token_ceiling, requested_max_output_tokens,
            reserved_input_tokens, reserved_spend_micros,
            started_at, created_at, updated_at
          ) VALUES (
            ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'started', 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `,
            [
              randomUUID(),
              reservation.requestId,
              reservation.requestId,
              reservation.requestId,
              reservation.idempotencyKey,
              reservation.feature,
              reservation.sourceCrawlId ?? '',
              reservation.sourceCrawlItemId ?? '',
              reservation.opportunityId,
              ...ownershipValues(reservation),
              reservation.agentRunId,
              reservation.contentFingerprint,
              reservation.inputFingerprint ?? '',
              reservation.profile,
              reservation.model,
              volume.provider === 'typesafe' ? 'typesafe' : 'bifrost',
              reservation.estimatedInputTokens,
              reservation.inputTokenCeiling,
              reservation.maxOutputTokens,
              reservation.reservedInputTokens,
              reservation.reservedSpendMicros,
            ],
          );
          await transaction.query(
            `
          UPDATE opportunity_intelligence_controls
          SET window_request_count = ?, window_input_tokens = ?,
              last_request_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
            [nextRequests, nextTokens, stringValue(control.id)],
          );
          if (volume.id)
            await transaction.query(
              `UPDATE opportunity_intelligence_controls
            SET window_request_count = ?, window_input_tokens = ?, request_threshold = ?, input_token_threshold = ?,
                window_started_at = ?, last_request_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
              [
                volume.requests,
                volume.tokens,
                volume.requestThreshold,
                volume.inputTokenThreshold,
                control.window_started_at,
                volume.id,
              ],
            );
          return { kind: 'owner', reservation };
        });
      } catch (error) {
        if (!(error instanceof ReservationBlocked)) throw error;
        if (error.circuitReason)
          await this.openCircuitUnlocked(db, error.circuitReason);
        return error.result;
      }
    });
  }

  async complete<T>(
    reservation: OpportunityIntelligenceReservation,
    terminal: OpportunityIntelligenceTerminalResult<T> & {
      actualSpendMicros: number;
    },
  ): Promise<void> {
    const db = await this.db();
    if (!db.transaction) {
      throw new Error(
        'Transactional usage accounting is required for paid intelligence work.',
      );
    }
    const runTransaction = db.transaction.bind(db);
    await withGovernanceWriteLock(db, () =>
      runTransaction(async (transaction) => {
        const accountingBasis =
          terminal.accountingBasis ?? (terminal.usage ? 'actual' : 'missing');
        const usage = terminal.usage ?? {
          completionTokens: reservation.maxOutputTokens,
          promptTokens: reservation.reservedInputTokens,
          totalTokens:
            reservation.reservedInputTokens + reservation.maxOutputTokens,
        };
        const outputJson = JSON.stringify(terminal.output ?? {});
        await transaction.query(
          `
          UPDATE opportunity_intelligence_requests
          SET provider_request_id = ?, status = ?, actual_input_tokens = ?,
              actual_output_tokens = ?, actual_total_tokens = ?,
              actual_spend_micros = ?, accounting_basis = ?, duration_ms = ?, error_code = ?,
              finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE request_id = ? AND ${ownershipPredicate()}
        `,
          [
            terminal.providerRequestId ?? reservation.requestId,
            terminal.status,
            numberValue(usage.promptTokens),
            numberValue(usage.completionTokens),
            numberValue(usage.totalTokens),
            terminal.actualSpendMicros,
            accountingBasis,
            terminal.durationMs,
            terminal.status === 'succeeded'
              ? ''
              : terminal.errorCode || terminal.status,
            reservation.requestId,
            ...ownershipValues(reservation),
          ],
        );
        await transaction.query(
          `
          UPDATE opportunity_intelligence_results
          SET status = ?, output_json = ?, error_code = ?,
              finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE idempotency_key = ? AND owner_request_id = ?
            AND ${ownershipPredicate()}
        `,
          [
            terminal.status === 'succeeded' ? 'completed' : 'failed',
            outputJson,
            terminal.status === 'succeeded' ? '' : terminal.status,
            reservation.idempotencyKey,
            reservation.requestId,
            ...ownershipValues(reservation),
          ],
        );
        await settleBudgetRow(
          transaction,
          'agent_runs',
          reservation.agentRunId,
          reservation,
          usage,
          terminal.actualSpendMicros,
        );
        await settleBudgetRow(
          transaction,
          'source_crawls',
          reservation.sourceCrawlId ?? '',
          reservation,
          usage,
          terminal.actualSpendMicros,
        );

        const control = queryRow(
          await transaction.query(
            `SELECT * FROM opportunity_intelligence_controls WHERE control_key = ?${governanceRowLock(transaction)}`,
            [OPPORTUNITY_INTELLIGENCE_CONTROL_KEY],
          ),
        );
        if (!control) return;
        const isAbort = ['aborted', 'timed_out'].includes(terminal.status);
        const failures =
          terminal.status === 'succeeded'
            ? 0
            : numberValue(control.consecutive_failures) + 1;
        const aborts = isAbort
          ? numberValue(control.consecutive_aborts) + 1
          : terminal.status === 'succeeded'
            ? 0
            : numberValue(control.consecutive_aborts);
        let circuitReason = '';
        if (accountingBasis === 'missing') {
          circuitReason = 'usage_accounting_missing';
        } else if (
          terminal.durationMs > numberValue(control.latency_threshold_ms)
        ) {
          circuitReason = 'latency_threshold';
        } else if (aborts >= numberValue(control.abort_threshold)) {
          circuitReason = 'repeated_aborts';
        } else if (failures >= numberValue(control.failure_threshold)) {
          circuitReason = 'repeated_failures';
        } else if (
          numberValue(usage.promptTokens) > reservation.inputTokenCeiling
        ) {
          circuitReason = 'actual_input_tokens_exceeded_ceiling';
        }
        await transaction.query(
          `
          UPDATE opportunity_intelligence_controls
          SET consecutive_aborts = ?, consecutive_failures = ?,
              circuit_state = CASE WHEN ? = '' THEN circuit_state ELSE 'open' END,
              circuit_reason = CASE WHEN ? = '' THEN circuit_reason ELSE ? END,
              opened_at = CASE WHEN ? = '' THEN opened_at ELSE CURRENT_TIMESTAMP END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
          [
            aborts,
            failures,
            circuitReason,
            circuitReason,
            circuitReason,
            circuitReason,
            stringValue(control.id),
          ],
        );
      }),
    );
  }
}

async function safelyOpenCircuit(
  store: OpportunityIntelligenceGovernanceStore,
  reason: string,
): Promise<void> {
  try {
    await store.openCircuit?.(reason);
  } catch {
    // The request remains failed closed even if the independent control write fails.
  }
}

export async function executeGovernedOpportunityIntelligenceRequest<
  T,
>(options: {
  config?: OpportunityIntelligenceBudgetConfig;
  estimatedInputTokens: number;
  /** Optional larger financial reserve; never lowers the token-based spend reserve. */
  financialInputTokenCeiling?: number;
  identity: OpportunityIntelligenceRequestIdentity;
  inputTokenCeiling: number;
  invoke: (requestId: string) => Promise<{
    output: T;
    providerRequestId?: string;
    usage?: TokenUsage;
  }>;
  maxOutputTokens: number;
  signal?: AbortSignal;
  store?: OpportunityIntelligenceGovernanceStore;
  /**
   * User to bill when the result is not candidate-private (and so carries no
   * workspace subject), without scoping the governance ledger by owner.
   */
  billedUser?: { tenantId: string; userId: string };
  /** Server-verified owner tuple for a candidate-private provider result. */
  workspaceSubject?: WorkspaceSubject;
}): Promise<{ output: T; requestId: string; reused: boolean }> {
  // Global AI kill switch: refuse before any ledger, circuit, or provider work.
  // It is deliberately not latched into the persisted circuit, so clearing the
  // environment value restores service without an operator reset.
  assertAiEnabled();
  const store =
    options.store ?? new DatabaseOpportunityIntelligenceGovernanceStore();
  if (options.estimatedInputTokens > options.inputTokenCeiling) {
    await safelyOpenCircuit(store, 'input_ceiling_exceeded');
    throw new OpportunityIntelligenceGovernanceError(
      'input_ceiling_exceeded',
      `Prepared request requires ${options.estimatedInputTokens} tokens, above the ${options.inputTokenCeiling}-token ceiling.`,
    );
  }
  const config = options.config ?? resolveOpportunityIntelligenceBudgetConfig();
  const modelPricing = pricingForOpportunityIntelligenceModel(
    options.identity.model,
  );
  // GPT-6 production traffic always uses the pinned per-model rates. Retain
  // injectable legacy pricing only for isolated compatibility tests.
  const pricing = modelPricing.configured ? modelPricing : config.pricing;
  if (!config.enabled) {
    await safelyOpenCircuit(store, 'environment_kill_switch');
    throw new OpportunityIntelligenceGovernanceError(
      'disabled',
      'Opportunity intelligence is disabled.',
    );
  }
  if (!pricing.configured) {
    await safelyOpenCircuit(store, 'pricing_missing');
    throw new OpportunityIntelligenceGovernanceError(
      'pricing_missing',
      'Opportunity intelligence pricing is required for spend reservation.',
    );
  }
  if (
    config.run.calls <= 0 ||
    config.run.inputTokens <= 0 ||
    config.run.spendMicros <= 0
  ) {
    await safelyOpenCircuit(store, 'run_budget_missing');
    throw new OpportunityIntelligenceGovernanceError(
      'budget_missing',
      'Opportunity intelligence run limits are required.',
    );
  }
  if (
    options.financialInputTokenCeiling !== undefined &&
    (!Number.isSafeInteger(options.financialInputTokenCeiling) ||
      options.financialInputTokenCeiling < options.inputTokenCeiling)
  )
    throw new Error('Invalid financial input reservation.');
  const requestId = randomUUID();
  const workspaceSubject = options.workspaceSubject
    ? requireWorkspaceSubject(options.workspaceSubject)
    : undefined;
  const reservation: OpportunityIntelligenceReservation = {
    ...options.identity,
    estimatedInputTokens: options.estimatedInputTokens,
    idempotencyKey: scopedOpportunityIntelligenceIdempotencyKey(
      options.identity,
      workspaceSubject,
    ),
    inputTokenCeiling: options.inputTokenCeiling,
    maxOutputTokens: options.maxOutputTokens,
    requestId,
    reservedInputTokens: options.inputTokenCeiling,
    reservedSpendMicros: reservedRequestSpendMicros({
      inputTokens:
        options.financialInputTokenCeiling ?? options.inputTokenCeiling,
      maxOutputTokens: options.maxOutputTokens,
      pricing,
    }),
    workspaceSubject,
  };
  if (reservation.reservedSpendMicros <= 0) {
    await safelyOpenCircuit(store, 'pricing_missing');
    throw new OpportunityIntelligenceGovernanceError(
      'pricing_missing',
      'Opportunity intelligence spend reservation must be positive.',
    );
  }

  // Candidate-owned requests are billed to that user's cap before the
  // governance reservation so a refusal leaves no ledger row that could block
  // a later retry. Platform requests (crawl, shared catalog) carry no subject
  // and are never billed to a user.
  const billedUser = workspaceSubject ?? options.billedUser;
  const userSpend = billedUser
    ? await reserveAiUserSpend({
        feature: options.identity.feature,
        micros: reservation.reservedSpendMicros,
        requestId,
        subject: { tenantId: billedUser.tenantId, userId: billedUser.userId },
      })
    : null;
  let providerInvoked = false;
  let spentMicros: number | undefined;
  try {
    const reserved = await store.reserve<T>(reservation);
    if (reserved.kind === 'reused') {
      return {
        output: reserved.output,
        requestId: reserved.requestId,
        reused: true,
      };
    }
    if (reserved.kind === 'blocked') {
      throw new OpportunityIntelligenceGovernanceError(
        reserved.code,
        reserved.message,
      );
    }

    const startedAt = Date.now();
    let response: {
      output: T;
      providerRequestId?: string;
      usage?: TokenUsage;
    };
    try {
      options.signal?.throwIfAborted();
      providerInvoked = true;
      response = await options.invoke(requestId);
    } catch (error) {
      const metadata =
        error && typeof error === 'object'
          ? invocationMetadata.get(error)
          : undefined;
      const actualSpendMicros = metadata?.usage
        ? requestCostMicros(metadata.usage, pricing)
        : reservation.reservedSpendMicros;
      spentMicros = metadata?.usage ? actualSpendMicros : undefined;
      try {
        await store.complete(reservation, {
          accountingBasis: metadata?.usage ? 'actual' : 'conservative',
          actualSpendMicros,
          durationMs: Date.now() - startedAt,
          errorCode: errorCode(error),
          providerRequestId: metadata?.providerRequestId ?? requestId,
          status: terminalStatus(error, options.signal),
          usage: metadata?.usage,
        });
      } catch {
        await safelyOpenCircuit(store, 'accounting_persistence_failed');
        throw new OpportunityIntelligenceGovernanceError(
          'accounting_required',
          'The provider request failed and accounting could not be persisted; the circuit has been opened.',
        );
      }
      throw error;
    }

    if (!response.usage) {
      try {
        await store.complete(reservation, {
          accountingBasis: 'missing',
          actualSpendMicros: reservation.reservedSpendMicros,
          durationMs: Date.now() - startedAt,
          errorCode: 'usage_accounting_missing',
          output: response.output,
          providerRequestId: response.providerRequestId ?? requestId,
          status: 'failed',
        });
      } catch {
        await safelyOpenCircuit(store, 'accounting_persistence_failed');
      }
      throw new OpportunityIntelligenceGovernanceError(
        'accounting_required',
        'Provider usage accounting is required; the circuit has been opened.',
      );
    }

    const actualSpendMicros = requestCostMicros(response.usage, pricing);
    spentMicros = actualSpendMicros;
    try {
      await store.complete(reservation, {
        accountingBasis: 'actual',
        actualSpendMicros,
        durationMs: Date.now() - startedAt,
        output: response.output,
        providerRequestId: response.providerRequestId ?? requestId,
        status: 'succeeded',
        usage: response.usage,
      });
    } catch {
      await safelyOpenCircuit(store, 'accounting_persistence_failed');
      throw new OpportunityIntelligenceGovernanceError(
        'accounting_required',
        'Provider usage was returned but accounting could not be persisted; the circuit has been opened.',
      );
    }
    return { output: response.output, requestId, reused: false };
  } finally {
    // Settle the user's reservation: actual cost when usage was reported,
    // the full reservation when a provider call may have been charged, and a
    // full release when no provider call was made (reuse, block, refusal).
    if (userSpend) {
      if (!providerInvoked) await userSpend.release();
      else
        await userSpend.settle(
          spentMicros ?? reservation.reservedSpendMicros,
          spentMicros === undefined ? 'conservative' : 'actual',
        );
    }
  }
}

let governanceSchemaPromise: Promise<void> | null = null;

async function applyGovernanceSchema(db: SmrtDatabase): Promise<void> {
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunity_intelligence_control_key
      ON opportunity_intelligence_controls (control_key)
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunity_intelligence_result_key
      ON opportunity_intelligence_results (idempotency_key)
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunity_intelligence_request_id
      ON opportunity_intelligence_requests (request_id)
  `);
}

export async function ensureOpportunityIntelligenceGovernanceSchema(
  db?: SmrtDatabase,
): Promise<void> {
  if (db) return await applyGovernanceSchema(db);
  governanceSchemaPromise ??= resolveDatabase(getDbConfig())
    .then(applyGovernanceSchema)
    .catch((error: unknown) => {
      governanceSchemaPromise = null;
      throw error;
    });
  await governanceSchemaPromise;
}

export async function ensureOpportunityIntelligenceControl(): Promise<void> {
  const collection = await getCollection('OpportunityIntelligenceControl');
  const existing = await collection.list({
    limit: 1,
    where: { controlKey: OPPORTUNITY_INTELLIGENCE_CONTROL_KEY },
  });
  if (existing[0]) return;
  try {
    const control = await collection.create({
      circuitReason: 'operator_enable_required',
      circuitState: 'open',
      controlKey: OPPORTUNITY_INTELLIGENCE_CONTROL_KEY,
      enabled: false,
      windowStartedAt: new Date(),
    });
    await control.save();
  } catch {
    const raced = await collection.list({
      limit: 1,
      where: { controlKey: OPPORTUNITY_INTELLIGENCE_CONTROL_KEY },
    });
    if (!raced[0])
      throw new Error('Unable to initialize intelligence control.');
  }
}

export interface OpportunityIntelligenceControlStatus {
  affectedOpportunities: {
    capExhausted: number;
    failed: number;
    queuedWithoutActiveJob: number;
  };
  circuitReason: string;
  circuitState: string;
  consecutiveAborts: number;
  consecutiveFailures: number;
  enabled: boolean;
  inputTokenThreshold: number;
  pendingJobs: number;
  requestThreshold: number;
  recoveryAction: string;
  runningJobs: number;
  latestFailure: {
    accountingBasis: string;
    errorCode: string;
    feature: string;
    finishedAt: string;
    status: string;
  } | null;
  windowInputTokens: number;
  windowRequestCount: number;
}

export function opportunityIntelligenceRecoveryAction(options: {
  circuitReason: string;
  feature?: string;
}): string {
  const feature = stringValue(options.feature) || 'the latest provider step';
  if (options.circuitReason === 'usage_accounting_missing') {
    return `Inspect ${feature} for a successful response without provider usage, repair the usage mapping, run reconcile-status, then enable the circuit and enqueue a bounded recovery cohort.`;
  }
  if (options.circuitReason === 'repeated_failures') {
    return `Inspect ${feature} and its error code, correct provider or model access, run reconcile-status, then enable the circuit and enqueue a bounded recovery cohort.`;
  }
  if (options.circuitReason) {
    return `Resolve circuit reason ${options.circuitReason}, run reconcile-status, then enable the circuit and enqueue a bounded recovery cohort.`;
  }
  return 'No circuit recovery is required; reconcile stale terminal statuses before enqueueing additional work.';
}

export async function reconcileOpportunityIntelligenceStatuses(
  database?: SmrtDatabase,
): Promise<{ markedFailed: number }> {
  const db = database ?? (await resolveDatabase(getDbConfig()));
  const result = await db.query(`
    UPDATE opportunities AS opportunity
    SET source_intelligence_status = 'failed', updated_at = CURRENT_TIMESTAMP
    WHERE opportunity.source_intelligence_status IN ('queued', 'duplicate_active')
      AND NOT EXISTS (
        SELECT 1
        FROM _smrt_jobs AS job
        WHERE job.queue = 'opportunity-intelligence'
          AND job.object_id = CAST(opportunity.id AS TEXT)
          AND job.status IN ('pending', 'running')
          AND COALESCE(job.args ->> 'contentFingerprint', '') =
            opportunity.source_content_fingerprint
      )
  `);
  const markedFailed = Math.max(0, result.rowCount ?? 0);
  // Issue #436: a raw statement bypasses SMRT's change feed. This one cannot
  // return the affected ids cheaply, so it records a table-level bump.
  await bumpOpportunityTableChangeFeed(db, markedFailed);
  return { markedFailed };
}

export async function getOpportunityIntelligenceControlStatus(
  database?: SmrtDatabase,
): Promise<OpportunityIntelligenceControlStatus> {
  const db = database ?? (await resolveDatabase(getDbConfig()));
  const control = queryRow(
    await db.query(
      `SELECT * FROM opportunity_intelligence_controls WHERE control_key = ?`,
      [OPPORTUNITY_INTELLIGENCE_CONTROL_KEY],
    ),
  );
  if (!control) {
    throw new Error(
      'Opportunity intelligence control is missing. Run the database migration first.',
    );
  }
  const jobCounts = await db.query(
    `
      SELECT status, COUNT(*) AS count
      FROM _smrt_jobs
      WHERE queue = 'opportunity-intelligence'
        AND status IN ('pending', 'running')
      GROUP BY status
    `,
  );
  const counts = Object.fromEntries(
    (jobCounts.rows ?? []).map((row) => [
      stringValue(row.status),
      numberValue(row.count),
    ]),
  );
  const latestFailure = queryRow(
    await db.query(`
      SELECT accounting_basis, error_code, feature, finished_at, status
      FROM opportunity_intelligence_requests
      WHERE status IN ('aborted', 'failed', 'timed_out')
      ORDER BY finished_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `),
  );
  const affected = queryRow(
    await db.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE source_intelligence_status = 'cap_exhausted'
        ) AS cap_exhausted,
        COUNT(*) FILTER (
          WHERE source_intelligence_status = 'failed'
        ) AS failed,
        COUNT(*) FILTER (
          WHERE source_intelligence_status = 'queued'
            AND NOT EXISTS (
              SELECT 1
              FROM _smrt_jobs AS job
              WHERE job.queue = 'opportunity-intelligence'
                AND job.object_id = CAST(opportunities.id AS TEXT)
                AND job.status IN ('pending', 'running')
                AND COALESCE(job.args ->> 'contentFingerprint', '') =
                  opportunities.source_content_fingerprint
            )
        ) AS queued_without_active_job
      FROM opportunities
      WHERE source_intelligence_status IN ('cap_exhausted', 'failed', 'queued')
    `),
  );
  const inputTokenThreshold = boundedNonNegativeIntegerValue(
    control.input_token_threshold,
    1_000_000,
  );
  const requestThreshold = boundedNonNegativeIntegerValue(
    control.request_threshold,
    100,
  );
  if (inputTokenThreshold === null || requestThreshold === null) {
    throw new Error(
      'Persisted opportunity intelligence circuit thresholds are invalid.',
    );
  }
  return {
    affectedOpportunities: {
      capExhausted: numberValue(affected?.cap_exhausted),
      failed: numberValue(affected?.failed),
      queuedWithoutActiveJob: numberValue(affected?.queued_without_active_job),
    },
    circuitReason: stringValue(control.circuit_reason),
    circuitState: stringValue(control.circuit_state),
    consecutiveAborts: numberValue(control.consecutive_aborts),
    consecutiveFailures: numberValue(control.consecutive_failures),
    enabled: booleanValue(control.enabled),
    inputTokenThreshold,
    pendingJobs: counts.pending ?? 0,
    requestThreshold,
    recoveryAction: opportunityIntelligenceRecoveryAction({
      circuitReason: stringValue(control.circuit_reason),
      feature: stringValue(latestFailure?.feature),
    }),
    runningJobs: counts.running ?? 0,
    latestFailure: latestFailure
      ? {
          accountingBasis: stringValue(latestFailure.accounting_basis),
          errorCode: stringValue(latestFailure.error_code),
          feature: stringValue(latestFailure.feature),
          finishedAt: stringValue(latestFailure.finished_at),
          status: stringValue(latestFailure.status),
        }
      : null,
    windowInputTokens: numberValue(control.window_input_tokens),
    windowRequestCount: numberValue(control.window_request_count),
  };
}

export async function setOpportunityIntelligenceControl(options: {
  enabled: boolean;
  inputTokenThreshold?: number;
  reason: string;
  requestThreshold?: number;
}): Promise<OpportunityIntelligenceControlStatus> {
  const db = await resolveDatabase(getDbConfig());
  if (options.enabled) {
    const requestThreshold = normalizeOpportunityIntelligenceCircuitThreshold(
      options.requestThreshold,
      20,
      100,
    );
    const inputTokenThreshold =
      normalizeOpportunityIntelligenceCircuitThreshold(
        options.inputTokenThreshold,
        100_000,
        1_000_000,
      );
    await db.query(
      `
        UPDATE opportunity_intelligence_controls
        SET enabled = TRUE, circuit_state = 'closed', circuit_reason = '',
            consecutive_aborts = 0, consecutive_failures = 0,
            window_request_count = 0, window_input_tokens = 0,
            request_threshold = ?, input_token_threshold = ?,
            window_started_at = CURRENT_TIMESTAMP, opened_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE control_key = ?
      `,
      [
        requestThreshold,
        inputTokenThreshold,
        OPPORTUNITY_INTELLIGENCE_CONTROL_KEY,
      ],
    );
  } else {
    await db.query(
      `
        UPDATE opportunity_intelligence_controls
        SET enabled = FALSE, circuit_state = 'open', circuit_reason = ?,
            opened_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE control_key = ?
      `,
      [options.reason || 'operator_stop', OPPORTUNITY_INTELLIGENCE_CONTROL_KEY],
    );
  }
  return await getOpportunityIntelligenceControlStatus();
}

export async function startOpportunityIntelligenceAgentRun(options: {
  opportunityId: string;
  sourceCrawlId?: string;
  sourceId?: string;
  userId?: string;
  /** Present only for a verified candidate-owned assessment. */
  workspaceSubject?: WorkspaceSubject;
}): Promise<string> {
  const config = resolveOpportunityIntelligenceBudgetConfig();
  const collection = await getCollection('AgentRun');
  const run = await collection.create({
    candidateProfileId: options.workspaceSubject?.profileId ?? '',
    initiatedByUserId: options.workspaceSubject?.userId ?? options.userId ?? '',
    inputJson: JSON.stringify({
      sourceCrawlId: options.sourceCrawlId ?? '',
    }),
    intelligenceCallLimit: config.run.calls,
    intelligenceInputTokenLimit: config.run.inputTokens,
    intelligenceSpendLimitMicros: config.run.spendMicros,
    opportunityId: options.opportunityId,
    ownerUserId: options.workspaceSubject?.userId ?? '',
    runType: 'opportunity_intelligence',
    sourceId: options.sourceId ?? '',
    startedAt: new Date(),
    status: 'running',
    tenantId: options.workspaceSubject?.tenantId ?? '',
  });
  await run.save();
  return stringValue(run.id);
}

export async function finishOpportunityIntelligenceAgentRun(
  agentRunId: string,
  status: 'failed' | 'succeeded',
  error = '',
  workspaceSubject?: WorkspaceSubject,
): Promise<void> {
  if (!agentRunId) return;
  const collection = await getCollection('AgentRun');
  const run = (await collection.get(agentRunId)) as unknown as
    | (Record<string, unknown> & { save: () => Promise<void> })
    | null;
  if (!run) return;
  if (
    workspaceSubject &&
    (run.tenantId !== workspaceSubject.tenantId ||
      run.ownerUserId !== workspaceSubject.userId ||
      run.candidateProfileId !== workspaceSubject.profileId)
  ) {
    throw new Error('Agent run is outside the verified workspace subject.');
  }
  run.error = error;
  run.finishedAt = new Date();
  run.status = status;
  await run.save();
}
