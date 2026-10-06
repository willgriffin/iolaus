import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('./sqlite-operation-lock.js', async () => {
  const { withKeyedFileLock } = await import(
    '../../../../../scripts/smrt-keyed-lock.mjs'
  );
  return {
    withSqliteOperationLock: async <T>(key: string, action: () => Promise<T>) =>
      await withKeyedFileLock(
        { stateRoot: state.root, key, retryMs: 1 },
        action,
      ),
  };
});

import { runAiBudgetCommand } from './ai-budget-admin.js';
import {
  AiUsageRefusedError,
  type AiUserSpendStore,
  aiKillSwitchEngaged,
  assertAiEnabled,
  createAiUserSpendStore,
  getAiUsageSummary,
  meterAiWritingCall,
  reserveAiUserSpend,
  resolveAiUsagePolicy,
  withAiUserSpend,
} from './ai-usage-guard.js';

const alice = { tenantId: 'tenant-a', userId: 'user-a' };
const bob = { tenantId: 'tenant-b', userId: 'user-b' };
const none = { lifetimeCapMicros: 0, monthlyCapMicros: 0 };
const shared = {
  IOLAUS_WORKSPACE_MODE: 'shared',
  SMRT_APP_ID: 'beta-app',
  SMRT_RUNTIME_PROFILE: 'self-hosted',
};

const entriesDdl = `CREATE TABLE ai_user_spend_entries (
  id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT, owner_user_id TEXT,
  period TEXT, feature TEXT, request_id TEXT, status TEXT,
  reserved_micros INTEGER DEFAULT 0, actual_micros INTEGER DEFAULT 0,
  accounting_basis TEXT, settled_at TEXT, created_at TEXT, updated_at TEXT)`;
const budgetsDdl = `CREATE TABLE ai_user_budgets (
  id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT, owner_user_id TEXT,
  lifetime_cap_micros INTEGER, monthly_cap_micros INTEGER, note TEXT,
  created_at TEXT, updated_at TEXT, UNIQUE (tenant_id, owner_user_id))`;

describe('AI usage policy', () => {
  it('is disabled by default and in private mode', () => {
    expect(resolveAiUsagePolicy({})).toEqual({
      accounting: false,
      defaultLifetimeCapMicros: 0,
      defaultMonthlyCapMicros: 0,
      disabled: false,
    });
  });

  it('accounts in shared mode and when a cap is set explicitly', () => {
    expect(resolveAiUsagePolicy(shared).accounting).toBe(true);
    expect(
      resolveAiUsagePolicy({ IOLAUS_AI_USER_MONTHLY_CAP_MICROS: '5000000' }),
    ).toMatchObject({ accounting: true, defaultMonthlyCapMicros: 5_000_000 });
  });

  it('rejects malformed caps instead of treating them as disabled', () => {
    for (const value of ['abc', '-1', '1.5', '1e6']) {
      expect(() =>
        resolveAiUsagePolicy({ IOLAUS_AI_USER_LIFETIME_CAP_MICROS: value }),
      ).toThrow(/non-negative integer/u);
    }
  });

  it('kill switch engages for anything but an explicit false', () => {
    for (const value of ['true', '1', 'yes', 'on', 'typo'])
      expect(aiKillSwitchEngaged({ IOLAUS_AI_DISABLED: value })).toBe(true);
    for (const value of ['', 'false', '0', 'no', 'off', undefined])
      expect(aiKillSwitchEngaged({ IOLAUS_AI_DISABLED: value })).toBe(false);
    expect(() => assertAiEnabled({ IOLAUS_AI_DISABLED: 'true' })).toThrow(
      AiUsageRefusedError,
    );
    expect(() => assertAiEnabled({})).not.toThrow();
  });
});

describe.each([
  false,
  true,
])('per-user AI spend ledger on real SQLite (built-in driver: %s)', (native) => {
  let directory = '';
  let db: DatabaseInterface;
  let otherDb: DatabaseInterface;
  let store: AiUserSpendStore;
  let otherStore: AiUserSpendStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(await realpath(tmpdir()), 'iolaus-ai-'));
    state.root = directory;
    const config = {
      cache: false,
      type: 'sqlite' as const,
      url: `file:${join(directory, 'ledger.sqlite')}`,
      ...(native
        ? {
            secureFile: {
              custody: 'trusted-parent' as const,
              driver: 'node:sqlite' as const,
              root: directory,
            },
          }
        : {}),
    };
    db = await getDatabase(config);
    await db.query(entriesDdl);
    await db.query(budgetsDdl);
    otherDb = await getDatabase(config);
    store = createAiUserSpendStore(db as never);
    otherStore = createAiUserSpendStore(otherDb as never);
  });

  afterEach(async () => {
    await db.close?.();
    await otherDb.close?.();
    await rm(directory, { force: true, recursive: true });
  });

  const reserve = (
    micros: number,
    defaults = { lifetimeCapMicros: 1_000, monthlyCapMicros: 0 },
    overrides: { period?: string; scope?: typeof alice } = {},
  ) =>
    store.reserve({
      defaults,
      feature: 'test',
      micros,
      period: overrides.period ?? '2026-10',
      scope: overrides.scope ?? alice,
    });

  it('refuses a reservation that would exceed the lifetime cap and writes nothing', async () => {
    expect((await reserve(600)).kind).toBe('reserved');
    const refused = await reserve(500);
    expect(refused).toMatchObject({ kind: 'exhausted', limit: 'lifetime' });
    const rows = await db.query('SELECT status FROM ai_user_spend_entries');
    expect(rows.rows).toHaveLength(1);
    expect((await reserve(400)).kind).toBe('reserved');
  });

  it('enforces the monthly cap per UTC month and lets the next month through', async () => {
    const monthly = { lifetimeCapMicros: 0, monthlyCapMicros: 1_000 };
    expect((await reserve(900, monthly)).kind).toBe('reserved');
    expect((await reserve(200, monthly)).kind).toBe('exhausted');
    expect((await reserve(900, monthly, { period: '2026-11' })).kind).toBe(
      'reserved',
    );
  });

  it('counts only the requesting user', async () => {
    await reserve(900);
    expect((await reserve(900, undefined, { scope: bob })).kind).toBe(
      'reserved',
    );
    const snapshot = await store.snapshot(
      alice,
      { lifetimeCapMicros: 1_000, monthlyCapMicros: 0 },
      '2026-10',
    );
    expect(snapshot.lifetimeSpentMicros).toBe(900);
  });

  it('settles to actual cost, returns released reservations, and stays idempotent', async () => {
    const first = await reserve(600);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await store.settle(alice, first.entryId, 100, 'actual');
    // A second settle of a settled entry is a no-op.
    await store.settle(alice, first.entryId, 900, 'actual');
    const second = await reserve(800);
    expect(second.kind).toBe('reserved');
    if (second.kind !== 'reserved') return;
    await store.release(alice, second.entryId);
    const snapshot = await store.snapshot(
      alice,
      { lifetimeCapMicros: 1_000, monthlyCapMicros: 0 },
      '2026-10',
    );
    expect(snapshot).toMatchObject({
      lifetimeSpentMicros: 100,
      remainingMicros: 900,
    });
  });

  it('operator overrides take precedence over deployment defaults', async () => {
    await store.setBudget(alice, { lifetimeCapMicros: 50 });
    expect((await reserve(60)).kind).toBe('exhausted');
    await store.setBudget(alice, { lifetimeCapMicros: 0 });
    expect((await reserve(60_000)).kind).toBe('reserved');
    await store.setBudget(alice, { lifetimeCapMicros: null });
    expect((await reserve(1)).kind).toBe('exhausted');
    // Another user still sees the default.
    expect((await reserve(900, undefined, { scope: bob })).kind).toBe(
      'reserved',
    );
  });

  it('operator adjustments credit usage and cannot drive it negative', async () => {
    const first = await reserve(900);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await store.settle(alice, first.entryId, 900, 'actual');
    expect((await reserve(500)).kind).toBe('exhausted');
    await store.adjust(alice, -600, 'goodwill credit', '2026-10');
    expect((await reserve(500)).kind).toBe('reserved');
    await expect(store.adjust(alice, -100_000, 'x', '2026-10')).rejects.toThrow(
      /negative/u,
    );
  });

  it('never overspends under parallel reservations across independent handles', async () => {
    const defaults = { lifetimeCapMicros: 450, monthlyCapMicros: 0 };
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 ? otherStore : store).reserve({
          defaults,
          feature: 'race',
          micros: 100,
          period: '2026-10',
          scope: alice,
        }),
      ),
    );
    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(
      4,
    );
    const total = await db.query(
      "SELECT SUM(reserved_micros) AS total FROM ai_user_spend_entries WHERE status = 'reserved'",
    );
    expect(Number(total.rows[0]?.total)).toBe(400);
  });

  it('releases only reservations older than the stale window', async () => {
    await reserve(300);
    expect(await store.releaseStale(alice, 30)).toBe(0);
    await db.query(
      "UPDATE ai_user_spend_entries SET created_at = datetime('now', '-2 hours')",
    );
    expect(await store.releaseStale(alice, 30)).toBe(1);
    expect((await reserve(1_000)).kind).toBe('reserved');
  });

  describe('guarded calls', () => {
    const capped = {
      ...shared,
      IOLAUS_AI_USER_LIFETIME_CAP_MICROS: '1000',
    };

    it('makes no provider call once the cap is hit and explains the refusal', async () => {
      const provider = vi.fn(async () => ({ result: 'ok', actualMicros: 400 }));
      const call = () =>
        withAiUserSpend({
          environment: capped,
          feature: 'resume-fit',
          invoke: provider,
          micros: 600,
          store,
          subject: alice,
        });
      await expect(call()).resolves.toBe('ok');
      // 400 actual was settled; 400 + 600 fits exactly, then nothing fits.
      await expect(call()).resolves.toBe('ok');
      await expect(call()).rejects.toMatchObject({
        code: 'user_budget_exhausted',
        message: expect.stringMatching(/No AI request was made/u),
        status: 429,
      });
      expect(provider).toHaveBeenCalledTimes(2);
    });

    it('charges the full reservation when the provider call fails', async () => {
      await expect(
        withAiUserSpend({
          environment: capped,
          feature: 'x',
          invoke: async () => {
            throw new Error('provider down');
          },
          micros: 700,
          store,
          subject: alice,
        }),
      ).rejects.toThrow('provider down');
      const summary = await getAiUsageSummary(alice, {
        environment: capped,
        now: new Date('2026-10-05T00:00:00Z'),
        store,
      });
      expect(summary?.lifetimeSpentMicros).toBe(700);
    });

    it('kill switch refuses before touching the ledger, even for platform calls', async () => {
      const spy = vi.spyOn(store, 'reserve');
      const environment = { ...capped, IOLAUS_AI_DISABLED: 'true' };
      for (const subject of [alice, null]) {
        await expect(
          reserveAiUserSpend({
            environment,
            feature: 'x',
            micros: 1,
            store,
            subject,
          }),
        ).rejects.toMatchObject({ code: 'ai_disabled', status: 503 });
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not bill platform calls and leaves private mode untouched', async () => {
      const spy = vi.spyOn(store, 'reserve');
      expect(
        await reserveAiUserSpend({
          environment: capped,
          feature: 'crawl',
          micros: 5,
          store,
          subject: null,
        }),
      ).toBeNull();
      expect(
        await reserveAiUserSpend({
          environment: {},
          feature: 'x',
          micros: 5,
          store,
          subject: alice,
        }),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('fails closed when the ledger is unavailable', async () => {
      const broken = {
        reserve: async () => {
          throw new Error('db down');
        },
      } as unknown as AiUserSpendStore;
      await expect(
        reserveAiUserSpend({
          environment: capped,
          feature: 'x',
          micros: 5,
          store: broken,
          subject: alice,
        }),
      ).rejects.toMatchObject({ code: 'user_budget_unavailable' });
    });

    describe('metered writing calls', () => {
      const priced = {
        ...capped,
        IOLAUS_AI_WRITING_INPUT_COST_MICROS_PER_MILLION: '1000000',
        IOLAUS_AI_WRITING_OUTPUT_COST_MICROS_PER_MILLION: '2000000',
      };
      const call = (
        environment: Record<string, string>,
        invoke: () => Promise<{ result: string; usage?: object }>,
        subject: typeof alice | null = alice,
      ) =>
        meterAiWritingCall({
          environment,
          feature: 'application-plan',
          inputChars: 200,
          invoke,
          maxOutputTokens: 100,
          store,
          subject,
        });

      it('is a plain call when no accounting applies, but the kill switch still wins', async () => {
        const invoke = vi.fn(async () => ({ result: 'ok' }));
        await expect(call({}, invoke)).resolves.toBe('ok');
        await expect(
          call({ IOLAUS_AI_DISABLED: '1' }, invoke),
        ).rejects.toMatchObject({ code: 'ai_disabled' });
        expect(invoke).toHaveBeenCalledTimes(1);
      });

      it('keeps working in shared mode with no cap and no writing prices', async () => {
        const invoke = vi.fn(async () => ({ result: 'ok' }));
        await expect(call(shared, invoke)).resolves.toBe('ok');
        await expect(call(shared, invoke, null)).resolves.toBe('ok');
        expect(invoke).toHaveBeenCalledTimes(2);
      });

      it('refuses unattributed or unpriced calls instead of spending unmetered', async () => {
        const invoke = vi.fn(async () => ({ result: 'ok' }));
        await expect(call(priced, invoke, null)).rejects.toMatchObject({
          code: 'user_budget_unavailable',
        });
        await expect(call(capped, invoke)).rejects.toMatchObject({
          code: 'user_budget_pricing_missing',
        });
        expect(invoke).not.toHaveBeenCalled();
      });

      it('reserves the worst case, settles reported usage, and stops at the cap', async () => {
        // Worst case: 100 input + 100 output tokens = 100 + 200 micros.
        const invoke = vi.fn(async () => ({
          result: 'ok',
          usage: { completionTokens: 10, promptTokens: 20 },
        }));
        const environment = {
          ...priced,
          IOLAUS_AI_USER_LIFETIME_CAP_MICROS: '700',
        };
        await call(environment, invoke);
        await call(environment, invoke);
        // Actual cost is 20 + 20 = 40 micros each, so the cap is not reached.
        const summary = await getAiUsageSummary(alice, { environment, store });
        expect(summary?.lifetimeSpentMicros).toBe(80);
        const failing = vi.fn(async () => {
          throw new Error('provider down');
        });
        await expect(call(environment, failing)).rejects.toThrow(
          'provider down',
        );
        await expect(call(environment, failing)).rejects.toThrow(
          'provider down',
        );
        // Two failures keep their full 300-micro reservations (80 + 600), so a third needs 300 more than the 700 cap.
        await expect(call(environment, invoke)).rejects.toMatchObject({
          code: 'user_budget_exhausted',
        });
        expect(invoke).toHaveBeenCalledTimes(2);
      });
    });

    it('reports the remaining budget, or nothing when uncapped', async () => {
      const reservation = await reserveAiUserSpend({
        environment: capped,
        feature: 'x',
        micros: 250,
        store,
        subject: alice,
      });
      await reservation?.settle(250);
      const summary = await getAiUsageSummary(alice, {
        environment: capped,
        store,
      });
      expect(summary).toMatchObject({
        capped: true,
        disabled: false,
        remainingLabel: '$0.001 AI budget left',
        remainingMicros: 750,
      });
      expect(
        await getAiUsageSummary(alice, { environment: shared, store }),
      ).toBe(null);
      expect(await getAiUsageSummary(alice, { environment: {}, store })).toBe(
        null,
      );
    });
  });

  describe('operator command', () => {
    const context = () => ({
      defaults: none,
      now: new Date('2026-10-05T00:00:00Z'),
      resolveEmail: async (email: string) =>
        email === 'a@example.com' ? [alice] : [],
      store,
    });

    it('sets, inspects, adjusts and lists a user by id or email', async () => {
      const set = await runAiBudgetCommand(
        [
          'set',
          '--email',
          'a@example.com',
          '--lifetime',
          '5000000',
          '--monthly',
          '2000000',
        ],
        context(),
      );
      expect(set[0]).toContain('lifetime: $0.000 used / $5.00');
      expect(set[0]).toContain('2026-10: $0.000 used / $2.00');
      await runAiBudgetCommand(
        [
          'adjust',
          '--tenant-id',
          'tenant-a',
          '--user-id',
          'user-a',
          '--micros',
          '+1500',
        ],
        context(),
      );
      const status = await runAiBudgetCommand(['status'], context());
      expect(status.join('\n')).toContain('tenant=tenant-a user=user-a');
      expect(status.join('\n')).toContain('$0.002 used');
      await runAiBudgetCommand(
        [
          'set',
          '--email',
          'a@example.com',
          '--lifetime',
          'default',
          '--monthly',
          'none',
        ],
        context(),
      );
      const reset = await runAiBudgetCommand(
        ['status', '--email', 'a@example.com'],
        context(),
      );
      expect(reset[0]).toContain('remaining: uncapped');
    });

    it('rejects ambiguous or malformed operator input', async () => {
      await expect(
        runAiBudgetCommand(
          ['set', '--email', 'nobody@example.com', '--lifetime', '1'],
          context(),
        ),
      ).rejects.toThrow(/No user found/u);
      await expect(
        runAiBudgetCommand(
          ['set', '--email', 'a@example.com', '--lifetime', 'abc'],
          context(),
        ),
      ).rejects.toThrow(/micro-dollar/u);
      await expect(
        runAiBudgetCommand(
          ['adjust', '--email', 'a@example.com', '--micros', '1.5'],
          context(),
        ),
      ).rejects.toThrow(/signed/u);
    });
  });
});
