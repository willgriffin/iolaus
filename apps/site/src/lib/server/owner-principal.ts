import {
  type ExecuteAsPrincipalOptions,
  executeAsPrincipal,
  type PrincipalAuditEntry,
  type PrincipalBinding,
  type PrincipalRun,
  PrincipalToolNotAllowedError,
} from '@happyvertical/smrt-agents';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { OperationPermissionError } from '@happyvertical/smrt-users';
import { getAppConfig } from './app-config.js';
import { getRequestScopedSmrtOptions } from './smrt.js';
import {
  revalidateWorkspaceIdentity,
  WorkspaceSubjectError,
  type WorkspaceSubjectLocals,
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from './workspace-subject.js';

/**
 * Stable agent-class identifier recorded on every owner-principal audit entry.
 */
/**
 * Loaded lazily: the tool catalog depends on Vite-only virtual modules, so a
 * static import would break script entry points (db:migrate) that reach this
 * file through the opportunity-assessment store.
 */
async function loadOwnerToolNames(): Promise<string[]> {
  return (await import('./tool-catalog.js')).listOwnerToolNames();
}

export const OWNER_AGENT_CLASS = getAppConfig().agentClass;

/**
 * The slice of `App.Locals` the owner principal binds from. Both the cookie
 * session handler and the terminal Bearer path populate these.
 */
export type OwnerPrincipalLocals = WorkspaceSubjectLocals;

export interface RunAsOwnerOptions {
  /** Audit action label, e.g. `webmcp.job_search_import_opportunity`. */
  action?: string;
  /** Override the derived allow-list (tests only; production derives it). */
  allowedTools?: string[];
  /** Extra audit metadata merged into the emitted entry. */
  auditMetadata?: Record<string, unknown>;
}

export class OwnerPrincipalError extends Error {
  readonly status = 401;

  constructor(message = 'An authenticated owner session is required.') {
    super(message);
    this.name = 'OwnerPrincipalError';
  }
}

function localsFrom(
  source: OwnerPrincipalLocals | { locals: OwnerPrincipalLocals },
): OwnerPrincipalLocals {
  return 'locals' in source ? source.locals : source;
}

function requireOwnerUserId(locals: OwnerPrincipalLocals): string {
  const userId = locals.user?.id?.trim();
  if (!userId) throw new OwnerPrincipalError();
  return userId;
}

/**
 * Bind the signed-in user as the principal. `allowedTools` is every tool this
 * application can expose to that user, so effective authority collapses to the
 * user's own RBAC: bound-user permissions ∩ (full tool set).
 */
export function ownerPrincipalBinding(
  locals: OwnerPrincipalLocals,
  allowedTools: string[],
): PrincipalBinding {
  // When the hook supplied a workspace subject, bind the principal from that
  // verified object rather than from any route/tool input. Lower-level unit
  // callers without request locals retain the minimal explicit test contract.
  const subject = locals.workspaceSubject
    ? workspaceSubjectFromLocals(locals)
    : null;
  return {
    allowedTools,
    runAsUserId: subject?.userId ?? requireOwnerUserId(locals),
    tenantId: subject?.tenantId ?? locals.tenantId ?? null,
  };
}

export async function resolveOwnerPrincipalBinding(
  locals: OwnerPrincipalLocals,
): Promise<PrincipalBinding> {
  requireOwnerUserId(locals);
  return ownerPrincipalBinding(locals, await loadOwnerToolNames());
}

/**
 * Structured audit line for owner-principal executions. Kept as JSON on one
 * line so log shippers can index `event`, `action`, and `tool` directly.
 */
export function logOwnerPrincipalAudit(entry: PrincipalAuditEntry): void {
  console.info(
    JSON.stringify({
      event: 'owner_principal.audit',
      timestamp: new Date().toISOString(),
      ...entry,
    }),
  );
}

/**
 * Run `fn` as the signed-in owner inside `executeAsPrincipal()`.
 *
 * Native permission resolution reads current roles at each entry; request
 * permission snapshots must never grant authority across a write boundary.
 */
/**
 * The owner principal binding as plain options, without running anything.
 *
 * `runAsOwner` enters the principal itself, which suits a request handler that
 * owns its whole body. The data-surface adapter does not: it enters the
 * principal at its own boundaries, around each of preview and apply, so it can
 * repeat authorization and eligibility at apply time rather than trusting a
 * decision made during preview. That adapter needs the binding as a value.
 */
export async function ownerPrincipalOptions(
  source: OwnerPrincipalLocals | { locals: OwnerPrincipalLocals },
  options: RunAsOwnerOptions = {},
): Promise<ExecuteAsPrincipalOptions> {
  const locals = localsFrom(source);
  const userId = requireOwnerUserId(locals);
  const allowedTools = options.allowedTools ?? (await loadOwnerToolNames());
  const principal = ownerPrincipalBinding(locals, allowedTools);
  if (principal.tenantId) {
    await revalidateWorkspaceIdentity({ tenantId: principal.tenantId, userId });
  }

  return {
    ...getRequestScopedSmrtOptions(),
    action: options.action ?? 'owner.run',
    agentClass: OWNER_AGENT_CLASS,
    audit: logOwnerPrincipalAudit,
    auditMetadata: options.auditMetadata,
    onBehalfOfUserId: userId,
    postgresRls: false,
    principal,
  };
}

export async function runAsOwner<T>(
  source: OwnerPrincipalLocals | { locals: OwnerPrincipalLocals },
  fn: (run: PrincipalRun) => Promise<T>,
  options: RunAsOwnerOptions = {},
): Promise<T> {
  return await executeAsPrincipal(
    await ownerPrincipalOptions(source, options),
    async (run) => {
      const locals = localsFrom(source);
      if (locals.workspaceSubject) {
        return await withVerifiedWorkspaceSubject(
          workspaceSubjectFromLocals(locals),
          async () => await fn(run),
        );
      }
      const context = getCurrentTenant();
      if (context?.tenantId) {
        const { user } = await revalidateWorkspaceIdentity({
          tenantId: context.tenantId,
          userId: requireOwnerUserId(locals),
        });
        context.user = user;
      }
      return await fn(run);
    },
  );
}

/**
 * True when `error` is an authority denial raised by the owner principal:
 * either the tool is outside the derived allow-list or the bound user lacks
 * the generated operation permission.
 */
export function isOwnerAuthorityDenial(error: unknown): boolean {
  return (
    error instanceof PrincipalToolNotAllowedError ||
    error instanceof OperationPermissionError ||
    error instanceof WorkspaceSubjectError
  );
}

export type { PrincipalRun };
export { PrincipalToolNotAllowedError };
