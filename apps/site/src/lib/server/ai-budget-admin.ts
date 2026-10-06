import {
  type AiSpendCaps,
  type AiSpendScope,
  type AiSpendSnapshot,
  type AiUserSpendStore,
  aiUsagePeriod,
  formatMicrosAsDollars,
} from './ai-usage-guard.js';

export const AI_BUDGET_USAGE = `Usage: pnpm --filter @willgriffin/iolaus-site ai:budget <command> [options]

Commands
  status [<user>]                 Show caps and usage (all users when omitted)
  set <user> [--lifetime N|default|none] [--monthly N|default|none] [--note TEXT]
                                  Override a user's caps in micro-dollars.
                                  "default" inherits IOLAUS_AI_USER_*_CAP_MICROS;
                                  "none" removes that cap for this user.
  adjust <user> --micros +N|-N [--note TEXT]
                                  Credit (negative) or debit (positive) usage.
  release-stale <user> [--minutes 30]
                                  Release reservations stranded by a crash.

<user> is --tenant-id ID --user-id ID, or --email ADDRESS.
1 dollar = 1000000 micro-dollars.`;

export interface AiBudgetAdminContext {
  defaults: AiSpendCaps;
  now?: Date;
  resolveEmail?: (email: string) => Promise<AiSpendScope[]>;
  store: AiUserSpendStore;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function parseCap(value: string, name: string): number | null {
  if (value === 'default') return null;
  if (value === 'none') return 0;
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `${name} must be a micro-dollar integer, default, or none.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${name} is out of range.`);
  return parsed;
}

async function resolveScope(
  args: string[],
  context: AiBudgetAdminContext,
): Promise<AiSpendScope> {
  const tenantId = option(args, '--tenant-id');
  const userId = option(args, '--user-id');
  if (tenantId && userId) return { tenantId, userId };
  const email = option(args, '--email');
  if (email && context.resolveEmail) {
    const matches = await context.resolveEmail(email);
    if (matches.length === 1) return matches[0];
    throw new Error(
      matches.length === 0
        ? 'No user found for that email.'
        : 'That email maps to several tenants; pass --tenant-id and --user-id.',
    );
  }
  throw new Error(
    'Identify the user with --tenant-id and --user-id, or --email.',
  );
}

function describe(scope: AiSpendScope, snapshot: AiSpendSnapshot): string {
  const cap = (value: number) =>
    value > 0 ? formatMicrosAsDollars(value) : 'no cap';
  return [
    `tenant=${scope.tenantId} user=${scope.userId}`,
    `  lifetime: ${formatMicrosAsDollars(snapshot.lifetimeSpentMicros)} used / ${cap(snapshot.lifetimeCapMicros)}`,
    `  ${snapshot.period}: ${formatMicrosAsDollars(snapshot.monthlySpentMicros)} used / ${cap(snapshot.monthlyCapMicros)}`,
    `  remaining: ${snapshot.remainingMicros === null ? 'uncapped' : formatMicrosAsDollars(snapshot.remainingMicros)}`,
  ].join('\n');
}

/** Executes one operator command and returns the lines to print. */
export async function runAiBudgetCommand(
  argv: string[],
  context: AiBudgetAdminContext,
): Promise<string[]> {
  const [command, ...args] = argv;
  const period = aiUsagePeriod(context.now);
  const { store, defaults } = context;
  const show = async (scope: AiSpendScope) =>
    describe(scope, await store.snapshot(scope, defaults, period));
  switch (command) {
    case 'status': {
      if (!args.length) {
        const users = await store.listUsers(defaults, period);
        return users.length
          ? users.map((user) => describe(user, user.snapshot))
          : ['No per-user AI usage has been recorded.'];
      }
      return [await show(await resolveScope(args, context))];
    }
    case 'set': {
      const scope = await resolveScope(args, context);
      const values: Parameters<AiUserSpendStore['setBudget']>[1] = {};
      const lifetime = option(args, '--lifetime');
      const monthly = option(args, '--monthly');
      if (lifetime !== undefined)
        values.lifetimeCapMicros = parseCap(lifetime, '--lifetime');
      if (monthly !== undefined)
        values.monthlyCapMicros = parseCap(monthly, '--monthly');
      const note = option(args, '--note');
      if (note !== undefined) values.note = note;
      if (Object.keys(values).length === 0) {
        throw new Error('Pass --lifetime, --monthly, or --note.');
      }
      await store.setBudget(scope, values);
      return [await show(scope)];
    }
    case 'adjust': {
      const scope = await resolveScope(args, context);
      const raw = option(args, '--micros') ?? '';
      if (!/^[+-]?\d+$/u.test(raw)) {
        throw new Error('--micros must be a signed micro-dollar integer.');
      }
      await store.adjust(
        scope,
        Number(raw),
        option(args, '--note') ?? '',
        period,
      );
      return [await show(scope)];
    }
    case 'release-stale': {
      const scope = await resolveScope(args, context);
      const minutes = Number(option(args, '--minutes') ?? '30');
      if (!Number.isSafeInteger(minutes) || minutes < 1) {
        throw new Error('--minutes must be a positive integer.');
      }
      const released = await store.releaseStale(scope, minutes);
      return [`Released ${released} stale reservation(s).`, await show(scope)];
    }
    default:
      return [AI_BUDGET_USAGE];
  }
}
