import { createHash, randomUUID } from 'node:crypto';
import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import { getAppConfig } from './app-config.js';
import { getDbConfig } from './db.js';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';

/**
 * Hosted-AI usage policy: a global kill switch plus a per-user (tenant +
 * owner) spend cap that is reserved atomically before every billable provider
 * call and settled afterwards. Shared-catalog crawl and source intelligence
 * are platform costs: they carry no workspace subject and never reach the
 * per-user ledger.
 */

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

export const AI_DISABLED_ENV = 'IOLAUS_AI_DISABLED';
export const AI_USER_LIFETIME_CAP_ENV = 'IOLAUS_AI_USER_LIFETIME_CAP_MICROS';
export const AI_USER_MONTHLY_CAP_ENV = 'IOLAUS_AI_USER_MONTHLY_CAP_MICROS';
export const AI_WRITING_INPUT_COST_ENV =
  'IOLAUS_AI_WRITING_INPUT_COST_MICROS_PER_MILLION';
export const AI_WRITING_OUTPUT_COST_ENV =
  'IOLAUS_AI_WRITING_OUTPUT_COST_MICROS_PER_MILLION';

const MAX_CAP_MICROS = 1_000_000_000_000;

export type AiUsageRefusalCode =
  | 'ai_disabled'
  | 'user_budget_exhausted'
  | 'user_budget_unavailable'
  | 'user_budget_pricing_missing';

/** User-presentable refusal. No provider call was made when this is thrown. */
export class AiUsageRefusedError extends Error {
  readonly code: AiUsageRefusalCode;
  readonly status: 429 | 503;

  constructor(code: AiUsageRefusalCode, message: string) {
    super(message);
    this.name = 'AiUsageRefusedError';
    this.code = code;
    this.status = code === 'user_budget_exhausted' ? 429 : 503;
  }
}

export function isAiUsageRefusedError(
  value: unknown,
): value is AiUsageRefusedError {
  return value instanceof AiUsageRefusedError;
}

type Environment = Record<string, string | undefined>;

export interface AiUsagePolicy {
  /** True when every model call is refused. */
  disabled: boolean;
  defaultLifetimeCapMicros: number;
  defaultMonthlyCapMicros: number;
  /** Per-user accounting is active (shared mode, or a cap set explicitly). */
  accounting: boolean;
}

function capFrom(environment: Environment, name: string): number {
  const raw = environment[name]?.trim() ?? '';
  if (!raw) return 0;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a non-negative integer of micro-dollars.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_CAP_MICROS) {
    throw new Error(`${name} is out of range.`);
  }
  return value;
}

/**
 * The kill switch fails closed: anything other than an explicit false value
 * disables AI, so a typo cannot silently leave spending on.
 */
export function aiKillSwitchEngaged(
  environment: Environment = process.env,
): boolean {
  const raw = (environment[AI_DISABLED_ENV] ?? '').trim().toLowerCase();
  if (!raw) return false;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

export function resolveAiUsagePolicy(
  environment: Environment = process.env,
): AiUsagePolicy {
  const defaultLifetimeCapMicros = capFrom(
    environment,
    AI_USER_LIFETIME_CAP_ENV,
  );
  const defaultMonthlyCapMicros = capFrom(environment, AI_USER_MONTHLY_CAP_ENV);
  return {
    accounting:
      getAppConfig(environment).workspaceMode === 'shared' ||
      defaultLifetimeCapMicros > 0 ||
      defaultMonthlyCapMicros > 0,
    defaultLifetimeCapMicros,
    defaultMonthlyCapMicros,
    disabled: aiKillSwitchEngaged(environment),
  };
}

export const AI_DISABLED_MESSAGE =
  'AI features are temporarily turned off. No request was sent to a model.';

/** Global kill switch: refuse before any provider client is created. */
export function assertAiEnabled(environment: Environment = process.env): void {
  if (aiKillSwitchEngaged(environment)) {
    throw new AiUsageRefusedError('ai_disabled', AI_DISABLED_MESSAGE);
  }
}

export function formatMicrosAsDollars(micros: number): string {
  const dollars = Math.max(0, micros) / 1_000_000;
  return `$${dollars.toFixed(dollars < 1 ? 3 : 2)}`;
}

export function aiUsagePeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export interface AiSpendScope {
  tenantId: string;
  userId: string;
}

export interface AiSpendCaps {
  /** Zero means no cap. */
  lifetimeCapMicros: number;
  monthlyCapMicros: number;
}

export interface AiSpendSnapshot extends AiSpendCaps {
  lifetimeSpentMicros: number;
  monthlySpentMicros: number;
  period: string;
  /** Smallest remaining headroom across active caps; null when uncapped. */
  remainingMicros: number | null;
}

export type AiSpendReserveResult =
  | { entryId: string; kind: 'reserved'; snapshot: AiSpendSnapshot }
  | {
      kind: 'exhausted';
      limit: 'lifetime' | 'monthly';
      snapshot: AiSpendSnapshot;
    };

type SqlRow = Record<string, unknown>;

function integer(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(result) ? result : 0;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function isSqlite(db: SmrtDatabase): boolean {
  return Boolean(db.url && detectEngine(db.url) === 'sqlite');
}

function lockKey(scope: AiSpendScope): string {
  return `ai-user-spend:${createHash('sha256')
    .update(`${scope.tenantId}\u0000${scope.userId}`)
    .digest('hex')}`;
}

function remainingFor(
  caps: AiSpendCaps,
  lifetimeSpent: number,
  monthlySpent: number,
): number | null {
  const remaining: number[] = [];
  if (caps.lifetimeCapMicros > 0)
    remaining.push(caps.lifetimeCapMicros - lifetimeSpent);
  if (caps.monthlyCapMicros > 0)
    remaining.push(caps.monthlyCapMicros - monthlySpent);
  return remaining.length ? Math.max(0, Math.min(...remaining)) : null;
}

const SPEND_SUM = `COALESCE(SUM(
  CASE WHEN status = 'settled' THEN actual_micros
       WHEN status = 'reserved' THEN reserved_micros
       ELSE 0 END
), 0)`;

export function createAiUserSpendStore(database: SmrtDatabase) {
  if (typeof database.transaction !== 'function') {
    throw new Error('Per-user AI spend accounting requires transactions.');
  }

  /**
   * Every spend mutation for one user runs under the same lock: a PostgreSQL
   * advisory transaction lock, or the keyed file lock used by the other
   * SQLite ledgers. Concurrent reservations therefore observe each other.
   */
  const locked = async <T>(
    scope: AiSpendScope,
    work: (transaction: SmrtDatabase) => Promise<T>,
  ): Promise<T> => {
    const run = async () =>
      await database.transaction!(async (transaction) => {
        if (!isSqlite(database)) {
          await transaction.query("SET LOCAL lock_timeout = '15s'");
          await transaction.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
            lockKey(scope),
          ]);
        }
        return await work(transaction);
      });
    return isSqlite(database)
      ? await withSqliteOperationLock(lockKey(scope), run)
      : await run();
  };

  const readBudget = async (
    db: SmrtDatabase,
    scope: AiSpendScope,
    defaults: AiSpendCaps,
  ): Promise<AiSpendCaps> => {
    const result = await db.query(
      `SELECT lifetime_cap_micros AS "lifetimeCap", monthly_cap_micros AS "monthlyCap"
       FROM ai_user_budgets WHERE tenant_id = ? AND owner_user_id = ? LIMIT 1`,
      [scope.tenantId, scope.userId],
    );
    const row = result.rows[0] as SqlRow | undefined;
    return {
      lifetimeCapMicros:
        nullableInteger(row?.lifetimeCap) ?? defaults.lifetimeCapMicros,
      monthlyCapMicros:
        nullableInteger(row?.monthlyCap) ?? defaults.monthlyCapMicros,
    };
  };

  const readSpend = async (
    db: SmrtDatabase,
    scope: AiSpendScope,
    period: string,
  ): Promise<{ lifetime: number; monthly: number }> => {
    const result = await db.query(
      `SELECT ${SPEND_SUM} AS "lifetime",
              COALESCE(SUM(CASE WHEN period = ? THEN
                CASE WHEN status = 'settled' THEN actual_micros
                     WHEN status = 'reserved' THEN reserved_micros
                     ELSE 0 END
                ELSE 0 END), 0) AS "monthly"
       FROM ai_user_spend_entries
       WHERE tenant_id = ? AND owner_user_id = ?`,
      [period, scope.tenantId, scope.userId],
    );
    const row = (result.rows[0] ?? {}) as SqlRow;
    return { lifetime: integer(row.lifetime), monthly: integer(row.monthly) };
  };

  const snapshotFrom = (
    caps: AiSpendCaps,
    spend: { lifetime: number; monthly: number },
    period: string,
  ): AiSpendSnapshot => ({
    ...caps,
    lifetimeSpentMicros: spend.lifetime,
    monthlySpentMicros: spend.monthly,
    period,
    remainingMicros: remainingFor(caps, spend.lifetime, spend.monthly),
  });

  return {
    /** Atomically reserve `micros` against the user's caps. */
    async reserve(options: {
      defaults: AiSpendCaps;
      feature: string;
      micros: number;
      period: string;
      requestId?: string;
      scope: AiSpendScope;
    }): Promise<AiSpendReserveResult> {
      if (!Number.isSafeInteger(options.micros) || options.micros <= 0) {
        throw new Error('An AI spend reservation must be a positive integer.');
      }
      return await locked(options.scope, async (transaction) => {
        const caps = await readBudget(
          transaction,
          options.scope,
          options.defaults,
        );
        const spend = await readSpend(
          transaction,
          options.scope,
          options.period,
        );
        const snapshot = snapshotFrom(caps, spend, options.period);
        if (
          caps.lifetimeCapMicros > 0 &&
          spend.lifetime + options.micros > caps.lifetimeCapMicros
        ) {
          return { kind: 'exhausted', limit: 'lifetime', snapshot };
        }
        if (
          caps.monthlyCapMicros > 0 &&
          spend.monthly + options.micros > caps.monthlyCapMicros
        ) {
          return { kind: 'exhausted', limit: 'monthly', snapshot };
        }
        const entryId = randomUUID();
        const requestId = options.requestId ?? entryId;
        await transaction.query(
          `INSERT INTO ai_user_spend_entries (
             id, slug, context, tenant_id, owner_user_id, period, feature,
             request_id, status, reserved_micros, actual_micros,
             accounting_basis, created_at, updated_at
           ) VALUES (?, ?, 'ai-user-spend', ?, ?, ?, ?, ?, 'reserved', ?, 0, 'reserved',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            entryId,
            entryId,
            options.scope.tenantId,
            options.scope.userId,
            options.period,
            options.feature.slice(0, 120),
            requestId,
            options.micros,
          ],
        );
        return {
          entryId,
          kind: 'reserved',
          snapshot: snapshotFrom(
            caps,
            {
              lifetime: spend.lifetime + options.micros,
              monthly: spend.monthly + options.micros,
            },
            options.period,
          ),
        };
      });
    },

    /** Replace a reservation with its actual (or conservative) cost. */
    async settle(
      scope: AiSpendScope,
      entryId: string,
      actualMicros: number,
      basis: 'actual' | 'conservative',
    ): Promise<void> {
      await locked(scope, async (transaction) => {
        await transaction.query(
          `UPDATE ai_user_spend_entries
           SET status = 'settled', actual_micros = ?, accounting_basis = ?,
             settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'reserved'`,
          [
            Math.max(0, Math.trunc(actualMicros)),
            basis,
            entryId,
            scope.tenantId,
            scope.userId,
          ],
        );
      });
    },

    /** The provider was never called: return the reservation. */
    async release(scope: AiSpendScope, entryId: string): Promise<void> {
      await locked(scope, async (transaction) => {
        await transaction.query(
          `UPDATE ai_user_spend_entries
           SET status = 'released', accounting_basis = 'released',
             settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'reserved'`,
          [entryId, scope.tenantId, scope.userId],
        );
      });
    },

    async snapshot(
      scope: AiSpendScope,
      defaults: AiSpendCaps,
      period: string,
    ): Promise<AiSpendSnapshot> {
      const caps = await readBudget(database, scope, defaults);
      return snapshotFrom(
        caps,
        await readSpend(database, scope, period),
        period,
      );
    },

    /** Operator credit (negative spend) or debit; never below zero in total. */
    async adjust(
      scope: AiSpendScope,
      deltaMicros: number,
      note: string,
      period: string,
    ): Promise<void> {
      if (!Number.isSafeInteger(deltaMicros) || deltaMicros === 0) {
        throw new Error('An adjustment must be a non-zero integer.');
      }
      await locked(scope, async (transaction) => {
        const spend = await readSpend(transaction, scope, period);
        if (spend.lifetime + deltaMicros < 0) {
          throw new Error('The adjustment would make lifetime usage negative.');
        }
        const id = randomUUID();
        await transaction.query(
          `INSERT INTO ai_user_spend_entries (
             id, slug, context, tenant_id, owner_user_id, period, feature,
             request_id, status, reserved_micros, actual_micros,
             accounting_basis, settled_at, created_at, updated_at
           ) VALUES (?, ?, 'ai-user-spend', ?, ?, ?, 'operator-adjustment', ?, 'settled', 0, ?,
             'operator', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            id,
            id,
            scope.tenantId,
            scope.userId,
            period,
            note.slice(0, 120) || id,
            deltaMicros,
          ],
        );
      });
    },

    /** Release reservations stranded by a crashed process. */
    async releaseStale(
      scope: AiSpendScope,
      olderThanMinutes: number,
    ): Promise<number> {
      return await locked(scope, async (transaction) => {
        const result = await transaction.query(
          isSqlite(database)
            ? `UPDATE ai_user_spend_entries
               SET status = 'released', accounting_basis = 'released_stale',
                 settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE tenant_id = ? AND owner_user_id = ? AND status = 'reserved'
                 AND created_at <= datetime('now', ?)`
            : `UPDATE ai_user_spend_entries
               SET status = 'released', accounting_basis = 'released_stale',
                 settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE tenant_id = ? AND owner_user_id = ? AND status = 'reserved'
                 AND created_at <= CURRENT_TIMESTAMP - (CAST(? AS integer) * INTERVAL '1 minute')`,
          [
            scope.tenantId,
            scope.userId,
            isSqlite(database)
              ? `-${Math.trunc(olderThanMinutes)} minutes`
              : Math.trunc(olderThanMinutes),
          ],
        );
        return integer(result.rowCount);
      });
    },

    async setBudget(
      scope: AiSpendScope,
      values: {
        lifetimeCapMicros?: number | null;
        monthlyCapMicros?: number | null;
        note?: string;
      },
    ): Promise<void> {
      await locked(scope, async (transaction) => {
        const existing = await transaction.query(
          `SELECT id, lifetime_cap_micros AS "lifetimeCap", monthly_cap_micros AS "monthlyCap", note
           FROM ai_user_budgets WHERE tenant_id = ? AND owner_user_id = ? LIMIT 1`,
          [scope.tenantId, scope.userId],
        );
        const row = existing.rows[0] as SqlRow | undefined;
        const lifetime =
          values.lifetimeCapMicros !== undefined
            ? values.lifetimeCapMicros
            : nullableInteger(row?.lifetimeCap);
        const monthly =
          values.monthlyCapMicros !== undefined
            ? values.monthlyCapMicros
            : nullableInteger(row?.monthlyCap);
        const note = values.note ?? String(row?.note ?? '');
        if (row) {
          await transaction.query(
            `UPDATE ai_user_budgets
             SET lifetime_cap_micros = ?, monthly_cap_micros = ?, note = ?,
               updated_at = CURRENT_TIMESTAMP
             WHERE tenant_id = ? AND owner_user_id = ?`,
            [lifetime, monthly, note, scope.tenantId, scope.userId],
          );
          return;
        }
        const id = randomUUID();
        await transaction.query(
          `INSERT INTO ai_user_budgets (
             id, slug, context, tenant_id, owner_user_id,
             lifetime_cap_micros, monthly_cap_micros, note, created_at, updated_at
           ) VALUES (?, ?, 'ai-user-budget', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [id, id, scope.tenantId, scope.userId, lifetime, monthly, note],
        );
      });
    },

    /** Operator listing of every user with ledger or override rows. */
    async listUsers(
      defaults: AiSpendCaps,
      period: string,
    ): Promise<Array<AiSpendScope & { snapshot: AiSpendSnapshot }>> {
      const result = await database.query(
        `SELECT tenant_id AS "tenantId", owner_user_id AS "userId" FROM ai_user_spend_entries
         UNION
         SELECT tenant_id AS "tenantId", owner_user_id AS "userId" FROM ai_user_budgets`,
      );
      const users: Array<AiSpendScope & { snapshot: AiSpendSnapshot }> = [];
      for (const row of result.rows as SqlRow[]) {
        const scope = {
          tenantId: String(row.tenantId ?? ''),
          userId: String(row.userId ?? ''),
        };
        users.push({
          ...scope,
          snapshot: await this.snapshot(scope, defaults, period),
        });
      }
      return users.sort((a, b) =>
        `${a.tenantId}/${a.userId}`.localeCompare(`${b.tenantId}/${b.userId}`),
      );
    },
  };
}

export type AiUserSpendStore = ReturnType<typeof createAiUserSpendStore>;

export interface AiUserSpendReservation {
  /** Idempotent: only the first settle/release takes effect. */
  release(): Promise<void>;
  settle(
    actualMicros: number,
    basis?: 'actual' | 'conservative',
  ): Promise<void>;
  snapshot: AiSpendSnapshot;
}

export function aiBudgetExhaustedMessage(
  snapshot: AiSpendSnapshot,
  limit: 'lifetime' | 'monthly',
): string {
  const cap =
    limit === 'lifetime'
      ? snapshot.lifetimeCapMicros
      : snapshot.monthlyCapMicros;
  const used =
    limit === 'lifetime'
      ? snapshot.lifetimeSpentMicros
      : snapshot.monthlySpentMicros;
  return limit === 'monthly'
    ? `You have reached your monthly AI budget (${formatMicrosAsDollars(used)} of ${formatMicrosAsDollars(cap)} used). No AI request was made. It resets next month, or contact the operator to raise it.`
    : `You have reached your AI usage budget (${formatMicrosAsDollars(used)} of ${formatMicrosAsDollars(cap)} used). No AI request was made. Contact the operator to raise it.`;
}

let defaultStorePromise: Promise<AiUserSpendStore> | null = null;

async function defaultStore(): Promise<AiUserSpendStore> {
  defaultStorePromise ??= (async () =>
    createAiUserSpendStore(await resolveDatabase(getDbConfig())))();
  try {
    return await defaultStorePromise;
  } catch (error) {
    defaultStorePromise = null;
    throw error;
  }
}

export interface ReserveAiUserSpendOptions {
  environment?: Environment;
  feature: string;
  /** Worst-case cost of the provider call, in micro-dollars. */
  micros: number;
  now?: Date;
  requestId?: string;
  store?: AiUserSpendStore;
  subject: AiSpendScope | null | undefined;
}

/**
 * Refuse a model call when AI is switched off, or reserve it against the
 * user's budget. Returns null when no user is billed (no workspace subject, or
 * private mode with no explicit cap). Fails closed if the ledger is
 * unreachable while accounting is active.
 */
export async function reserveAiUserSpend(
  options: ReserveAiUserSpendOptions,
): Promise<AiUserSpendReservation | null> {
  const environment = options.environment ?? process.env;
  assertAiEnabled(environment);
  if (!options.subject) return null;
  const policy = resolveAiUsagePolicy(environment);
  if (!policy.accounting) return null;

  const scope = {
    tenantId: options.subject.tenantId,
    userId: options.subject.userId,
  };
  const period = aiUsagePeriod(options.now);
  let outcome: AiSpendReserveResult;
  let store: AiUserSpendStore;
  try {
    store = options.store ?? (await defaultStore());
    outcome = await store.reserve({
      defaults: {
        lifetimeCapMicros: policy.defaultLifetimeCapMicros,
        monthlyCapMicros: policy.defaultMonthlyCapMicros,
      },
      feature: options.feature,
      micros: options.micros,
      period,
      requestId: options.requestId,
      scope,
    });
  } catch {
    throw new AiUsageRefusedError(
      'user_budget_unavailable',
      'AI usage could not be checked right now, so no AI request was made. Try again shortly.',
    );
  }
  if (outcome.kind === 'exhausted') {
    throw new AiUsageRefusedError(
      'user_budget_exhausted',
      aiBudgetExhaustedMessage(outcome.snapshot, outcome.limit),
    );
  }
  let done = false;
  const finish = async (work: () => Promise<void>) => {
    if (done) return;
    done = true;
    try {
      await work();
    } catch {
      // A failed settlement leaves the full reservation counted, which can
      // only over-state spend. Never let accounting mask the provider result.
    }
  };
  return {
    release: () => finish(() => store.release(scope, outcome.entryId)),
    settle: (actualMicros, basis = 'actual') =>
      finish(() => store.settle(scope, outcome.entryId, actualMicros, basis)),
    snapshot: outcome.snapshot,
  };
}

/** Run one metered provider call for a user (reserve, invoke, settle). */
export async function withAiUserSpend<T>(
  options: ReserveAiUserSpendOptions & {
    invoke: () => Promise<{ actualMicros?: number; result: T }>;
  },
): Promise<T> {
  const reservation = await reserveAiUserSpend(options);
  try {
    const { actualMicros, result } = await options.invoke();
    await reservation?.settle(
      actualMicros ?? options.micros,
      actualMicros === undefined ? 'conservative' : 'actual',
    );
    return result;
  } catch (error) {
    // The provider may have been charged; keep the conservative reservation.
    await reservation?.settle(options.micros, 'conservative');
    throw error;
  }
}

/**
 * Meter one writing-profile call (cover letters, application planning) that
 * has no pinned model price. With accounting inactive it is a plain call (the
 * kill switch still applies). With accounting active it needs an attributable
 * user and explicit prices, then reserves the worst case and settles actual
 * usage; otherwise it is refused rather than spent unmetered.
 */
export async function meterAiWritingCall<T>(options: {
  environment?: Environment;
  feature: string;
  /** Total characters sent, used as a conservative input-token bound. */
  inputChars: number;
  invoke: () => Promise<{
    result: T;
    usage?: { completionTokens?: unknown; promptTokens?: unknown };
  }>;
  maxOutputTokens: number;
  store?: AiUserSpendStore;
  subject: AiSpendScope | null | undefined;
}): Promise<T> {
  const environment = options.environment ?? process.env;
  assertAiEnabled(environment);
  if (!resolveAiUsagePolicy(environment).accounting) {
    return (await options.invoke()).result;
  }
  if (!options.subject) {
    throw new AiUsageRefusedError(
      'user_budget_unavailable',
      'AI usage could not be attributed to your account, so no AI request was made.',
    );
  }
  const pricing = resolveAiWritingPricing(environment);
  if (!pricing) {
    throw new AiUsageRefusedError(
      'user_budget_pricing_missing',
      'AI writing is not configured for metered use, so no AI request was made.',
    );
  }
  const microsFor = (input: number, output: number) =>
    Math.max(
      1,
      Math.ceil(
        (input * pricing.inputMicrosPerMillion +
          output * pricing.outputMicrosPerMillion) /
          1_000_000,
      ),
    );
  let reported:
    | { completionTokens?: unknown; promptTokens?: unknown }
    | undefined;
  return await withAiUserSpend({
    environment,
    feature: options.feature,
    micros: microsFor(
      Math.ceil(options.inputChars / 2),
      options.maxOutputTokens,
    ),
    store: options.store,
    subject: options.subject,
    invoke: async () => {
      const { result, usage } = await options.invoke();
      reported = usage;
      const prompt = Number(reported?.promptTokens);
      const completion = Number(reported?.completionTokens);
      return {
        actualMicros:
          Number.isSafeInteger(prompt) && Number.isSafeInteger(completion)
            ? microsFor(prompt, completion)
            : undefined,
        result,
      };
    },
  });
}

export interface AiUsageSummary {
  disabled: boolean;
  /** True when a cap applies to this user. */
  capped: boolean;
  lifetimeCapMicros: number;
  lifetimeSpentMicros: number;
  monthlyCapMicros: number;
  monthlySpentMicros: number;
  remainingLabel: string | null;
  remainingMicros: number | null;
}

/** Remaining-budget view for the signed-in user; null when nothing applies. */
export async function getAiUsageSummary(
  subject: AiSpendScope | null | undefined,
  options: {
    environment?: Environment;
    now?: Date;
    store?: AiUserSpendStore;
  } = {},
): Promise<AiUsageSummary | null> {
  const environment = options.environment ?? process.env;
  const disabled = aiKillSwitchEngaged(environment);
  if (!subject) return null;
  const policy = resolveAiUsagePolicy(environment);
  if (!policy.accounting) return null;
  const store = options.store ?? (await defaultStore());
  const snapshot = await store.snapshot(
    { tenantId: subject.tenantId, userId: subject.userId },
    {
      lifetimeCapMicros: policy.defaultLifetimeCapMicros,
      monthlyCapMicros: policy.defaultMonthlyCapMicros,
    },
    aiUsagePeriod(options.now),
  );
  const capped = snapshot.remainingMicros !== null;
  if (!capped && !disabled) return null;
  return {
    capped,
    disabled,
    lifetimeCapMicros: snapshot.lifetimeCapMicros,
    lifetimeSpentMicros: snapshot.lifetimeSpentMicros,
    monthlyCapMicros: snapshot.monthlyCapMicros,
    monthlySpentMicros: snapshot.monthlySpentMicros,
    remainingLabel:
      snapshot.remainingMicros === null
        ? null
        : `${formatMicrosAsDollars(snapshot.remainingMicros)} AI budget left`,
    remainingMicros: snapshot.remainingMicros,
  };
}

/** Explicit pricing for the writing profile; null when not configured. */
export function resolveAiWritingPricing(
  environment: Environment = process.env,
): { inputMicrosPerMillion: number; outputMicrosPerMillion: number } | null {
  const read = (name: string) => {
    const raw = environment[name]?.trim() ?? '';
    return /^\d+$/u.test(raw) && Number(raw) > 0 ? Number(raw) : 0;
  };
  const inputMicrosPerMillion = read(AI_WRITING_INPUT_COST_ENV);
  const outputMicrosPerMillion = read(AI_WRITING_OUTPUT_COST_ENV);
  return inputMicrosPerMillion && outputMicrosPerMillion
    ? { inputMicrosPerMillion, outputMicrosPerMillion }
    : null;
}
