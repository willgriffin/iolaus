import { executeAsPrincipal } from '@happyvertical/smrt-agents';
import {
  type AssetRuntimeLike,
  createAssetRuntime,
} from '@happyvertical/smrt-assets';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { IngestionService } from '@happyvertical/smrt-ingestion/server';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDbConfig } from './db.js';
import {
  type RuntimeWorkspaceSubject,
  requireActiveRunnerExecutionContext,
  runAsRevalidatedJobWorkspaceSubject,
} from './job-workspace-subject.js';
import { ownerPrincipalOptions } from './owner-principal.js';
import { invalidatePublishedResumeCache } from './resume-data.js';
import { extractResumeImport } from './resume-import-extraction.js';
import {
  createResumeImportHost,
  RESUME_IMPORT_JOB_TARGET,
  type ResumeImportHost,
} from './resume-import-host.js';
import { RESUME_IMPORT_INGESTION_QUEUE } from './resume-import-job-schema.js';
import { getIolausUserAssetsRoot } from './runtime-paths.js';
import {
  type CandidateWorkspaceSubject,
  requireCandidateWorkspaceSubject,
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from './workspace-subject.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

export const RESUME_IMPORT_OPERATION_MODEL =
  '@willgriffin/iolaus-site:ResumeImport';
export { RESUME_IMPORT_INGESTION_QUEUE } from './resume-import-job-schema.js';
export const RESUME_IMPORT_OPERATION = {
  action: 'apply',
  collection: 'resumeimports',
} as const;

type ResumeImportLocals = Parameters<typeof workspaceSubjectFromLocals>[0];
type ResumeImportAuthority = { permissions: string[] };

function sameSubject(
  left: CandidateWorkspaceSubject,
  right: CandidateWorkspaceSubject,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.profileId === right.profileId
  );
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 160 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`Invalid resume import ${label}.`);
  }
  return value;
}

function capturedPrincipal(value: unknown): string {
  let data: unknown = value;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error(
        'Resume import receipt has invalid ownership provenance.',
      );
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Resume import receipt has invalid ownership provenance.');
  }
  const ceiling = (data as Record<string, unknown>).capturedCeiling;
  const execution =
    ceiling && typeof ceiling === 'object' && !Array.isArray(ceiling)
      ? (ceiling as Record<string, unknown>).execution
      : undefined;
  return identifier(
    execution && typeof execution === 'object' && !Array.isArray(execution)
      ? (execution as Record<string, unknown>).principalId
      : undefined,
    'captured principal ID',
  );
}

async function currentDatabase(): Promise<DatabaseInterface> {
  return (getRequestScopedDatabase() ??
    (await resolveDatabase(getDbConfig()))) as DatabaseInterface;
}

async function createResumeImportAssets(
  db: DatabaseInterface,
): Promise<AssetRuntimeLike> {
  return await createAssetRuntime({
    db,
    storage: { type: 'local', basePath: getIolausUserAssetsRoot() },
  });
}

async function authorizeRequestResumeImport(
  locals: ResumeImportLocals,
  subject: CandidateWorkspaceSubject,
  db: DatabaseInterface,
): Promise<ResumeImportAuthority> {
  return await executeAsPrincipal(
    {
      ...(await ownerPrincipalOptions(locals, {
        action: 'resume-import.authorize',
      })),
      db,
    },
    async (run) =>
      await withVerifiedWorkspaceSubject(subject, async (verified) => {
        const current = requireCandidateWorkspaceSubject(verified);
        if (!sameSubject(current, subject)) {
          throw new Error('Resume import workspace subject changed.');
        }
        const profile = workspaceWorkflowOperation('profile.manage');
        await run.assertOperation(profile.collection, profile.action);
        await run.assertOperation(
          RESUME_IMPORT_OPERATION.collection,
          RESUME_IMPORT_OPERATION.action,
        );
        return {
          permissions: ['workflow.profile.manage', 'resumeimports.apply'],
        };
      }),
  );
}

/** Construct a host only from hook-verified request authority and storage. */
export async function getResumeImportHost(
  locals: ResumeImportLocals,
): Promise<ResumeImportHost> {
  const subject = requireCandidateWorkspaceSubject(
    workspaceSubjectFromLocals(locals),
  );
  const db = await currentDatabase();
  const assets = await createResumeImportAssets(db);
  return createResumeImportHost({
    assets,
    db,
    subject,
    operationModel: RESUME_IMPORT_OPERATION_MODEL,
    onApplied: invalidatePublishedResumeCache,
    authorize: async ({ db: executor }) =>
      await authorizeRequestResumeImport(locals, subject, executor),
    extract: async (input) => await extractResumeImport({ ...input, subject }),
  });
}

type ResumeImportJobArgs = {
  dispatchId: string;
  itemId: string;
  revision: number;
};

function jobArgs(value: Record<string, unknown>): ResumeImportJobArgs {
  if (
    Object.keys(value).length !== 3 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  ) {
    throw new Error('Invalid resume import ingestion job arguments.');
  }
  return {
    dispatchId: identifier(value.dispatchId, 'dispatch ID'),
    itemId: identifier(value.itemId, 'item ID'),
    revision: value.revision as number,
  };
}

export async function resolveResumeImportReceiptSubject(
  db: DatabaseInterface,
  itemId: string,
): Promise<RuntimeWorkspaceSubject> {
  const result = await db.query(
    `SELECT item.tenant_id, profile.owner_user_id, item.confidential_scope_id, item.data
       FROM intake_items AS item
       JOIN candidate_profiles AS profile
         ON CAST(profile.id AS TEXT) = item.confidential_scope_id
        AND profile.tenant_id = item.tenant_id
      WHERE item.id = ?`,
    [itemId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('Resume import receipt is unavailable.');
  const userId = identifier(row.owner_user_id, 'user ID');
  if (capturedPrincipal(row.data) !== userId) {
    throw new Error(
      'Resume import receipt owner no longer matches its profile.',
    );
  }
  return {
    tenantId: identifier(row.tenant_id, 'tenant ID'),
    userId,
    profileId: identifier(row.confidential_scope_id, 'profile ID'),
  };
}

async function authorizeQueuedResumeImport(
  subject: RuntimeWorkspaceSubject,
  db: DatabaseInterface,
): Promise<ResumeImportAuthority> {
  return await executeAsPrincipal(
    {
      db,
      action: 'resume-import.job.authorize',
      onBehalfOfUserId: subject.userId,
      postgresRls: false,
      principal: {
        allowedTools: [],
        runAsUserId: subject.userId,
        tenantId: subject.tenantId,
      },
    },
    async (run) => {
      const profile = workspaceWorkflowOperation('profile.manage');
      await run.assertOperation(profile.collection, profile.action);
      await run.assertOperation(
        RESUME_IMPORT_OPERATION.collection,
        RESUME_IMPORT_OPERATION.action,
      );
      return {
        permissions: ['workflow.profile.manage', 'resumeimports.apply'],
      };
    },
  );
}

/** Native worker entrypoint. The durable receipt, not JSON arguments, owns scope. */
export async function runResumeImportIngestionJob(
  rawArgs: Record<string, unknown>,
  context: JobExecutionContext | undefined,
  db: DatabaseInterface,
) {
  const runner = requireActiveRunnerExecutionContext(context);
  const args = jobArgs(rawArgs);
  if (
    runner.job.objectType !== RESUME_IMPORT_JOB_TARGET.objectType ||
    runner.job.method !== RESUME_IMPORT_JOB_TARGET.method ||
    runner.job.queue !== RESUME_IMPORT_INGESTION_QUEUE
  ) {
    throw new Error('Resume import requires its authentic ingestion job.');
  }
  const subject = await resolveResumeImportReceiptSubject(db, args.itemId);
  if (runner.job.tenantId !== subject.tenantId) {
    throw new Error('Resume import job tenant does not match its receipt.');
  }
  return await runAsRevalidatedJobWorkspaceSubject(
    subject,
    'profile.manage',
    async (current, run) => {
      await run.assertOperation(
        RESUME_IMPORT_OPERATION.collection,
        RESUME_IMPORT_OPERATION.action,
      );
      const assets = await createResumeImportAssets(db);
      const host = createResumeImportHost({
        assets,
        db,
        subject: current,
        operationModel: RESUME_IMPORT_OPERATION_MODEL,
        authorize: async ({ db: executor }) =>
          await authorizeQueuedResumeImport(current, executor),
        extract: async (input) =>
          await extractResumeImport({ ...input, subject: current }),
      });
      await runner.progress({ stage: 'queued', progress: 0 });
      return await host.process(
        args.itemId,
        args.revision,
        async (stage) => await runner.progress({ stage, progress: 0 }),
      );
    },
  );
}

/** Recovery hook for a verified owner after a worker restart or lost enqueue. */
export async function repairResumeImportDispatches(
  locals: ResumeImportLocals,
): Promise<number> {
  return await (await getResumeImportHost(locals)).repair();
}

/**
 * Startup/interval recovery for every still-authorized private receipt scope.
 * Each scope is revalidated immediately before its receipt repair; revoked or
 * suspended users are deliberately skipped rather than being processed by a
 * daemon principal.
 */
export async function repairQueuedResumeImports(
  db: DatabaseInterface,
): Promise<number> {
  const expired = await purgeExpiredResumeImportAssets(db);
  const result = await db.query(
    `SELECT DISTINCT item.tenant_id, profile.owner_user_id, item.confidential_scope_id
       FROM intake_items AS item
       JOIN candidate_profiles AS profile
         ON CAST(profile.id AS TEXT) = item.confidential_scope_id
        AND profile.tenant_id = item.tenant_id
      WHERE item.visibility NOT IN ('expired', 'deleted')
        AND (item.expires_at IS NULL OR item.expires_at > CURRENT_TIMESTAMP)`,
  );
  let repaired = expired;
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const subject: RuntimeWorkspaceSubject = {
      tenantId: identifier(row.tenant_id, 'tenant ID'),
      userId: identifier(row.owner_user_id, 'user ID'),
      profileId: identifier(row.confidential_scope_id, 'profile ID'),
    };
    try {
      repaired += await runAsRevalidatedJobWorkspaceSubject(
        subject,
        'profile.manage',
        async (current, run) => {
          await run.assertOperation(
            RESUME_IMPORT_OPERATION.collection,
            RESUME_IMPORT_OPERATION.action,
          );
          const host = createResumeImportHost({
            assets: await createResumeImportAssets(db),
            db,
            subject: current,
            operationModel: RESUME_IMPORT_OPERATION_MODEL,
            authorize: async ({ db: executor }) =>
              await authorizeQueuedResumeImport(current, executor),
            extract: async (input) =>
              await extractResumeImport({ ...input, subject: current }),
          });
          return await host.repair();
        },
      );
    } catch (cause) {
      // A revoked member or an unavailable account must not strand the other
      // tenants' receipts. Its durable receipt remains for a later authorized
      // repair or account-deletion purge.
      console.warn(
        'Skipped resume import recovery for an unavailable scope:',
        cause,
      );
    }
  }
  return repaired;
}

/**
 * Retention is independent of profile authority. A suspended or deleted
 * owner cannot authorize more analysis, but their expired private bytes must
 * still be revoked and swept from asset storage.
 */
export async function purgeExpiredResumeImportAssets(
  db: DatabaseInterface,
): Promise<number> {
  const result = await db.query(
    `SELECT item.id, item.tenant_id, item.confidential_scope_id, item.data
       FROM intake_items AS item
      WHERE item.visibility NOT IN ('expired', 'deleted')
        AND item.expires_at IS NOT NULL
        AND item.expires_at <= CURRENT_TIMESTAMP`,
  );
  const assets = await createResumeImportAssets(db);
  let purged = 0;
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const service = new IngestionService({
      assets,
      db,
      scope: {
        tenantId: identifier(row.tenant_id, 'tenant ID'),
        actorId: capturedPrincipal(row.data),
        confidentialScopeId: identifier(
          row.confidential_scope_id,
          'profile ID',
        ),
      },
      jobTarget: RESUME_IMPORT_JOB_TARGET,
      // This is a retention-only system operation. It neither extracts nor
      // applies profile data and cannot re-enable a revoked owner.
      authorize: async () => true,
      purgeDerived: async () => {},
    });
    await service.expire(identifier(row.id, 'receipt ID'));
    purged += 1;
  }
  return purged;
}

/**
 * Trusted account-deletion cleanup. It uses the ingestion service's durable
 * revoke-and-repair path so an asset write that races deletion is swept again
 * from retained cleanup locators. This must run before account suspension.
 */
export async function purgeResumeImportAccountData(
  db: DatabaseInterface,
  scope: Pick<RuntimeWorkspaceSubject, 'tenantId' | 'userId'>,
): Promise<number> {
  const rows = await db.query(
    `SELECT item.id, item.confidential_scope_id, item.data
       FROM intake_items AS item
      WHERE item.tenant_id = ?`,
    [scope.tenantId],
  );
  const items = rows.rows as Array<Record<string, unknown>>;
  const assets = await createResumeImportAssets(db);
  let purged = 0;
  for (const row of items) {
    if (capturedPrincipal(row.data) !== scope.userId) continue;
    const itemId = identifier(row.id, 'receipt ID');
    const profileId = identifier(row.confidential_scope_id, 'profile ID');
    const service = new IngestionService({
      assets,
      db,
      scope: {
        tenantId: scope.tenantId,
        actorId: scope.userId,
        confidentialScopeId: profileId,
      },
      jobTarget: RESUME_IMPORT_JOB_TARGET,
      authorize: async () => true,
      purgeDerived: async () => {},
    });
    await service.expire(itemId);
    purged += 1;
  }
  return purged;
}

/** Metadata-only account export; source bytes remain private and are not URLs. */
export async function exportResumeImportReceipts(
  db: DatabaseInterface,
  scope: Pick<RuntimeWorkspaceSubject, 'tenantId' | 'userId'>,
): Promise<Array<Record<string, unknown>>> {
  const result = await db.query(
    `SELECT item.id, item.receipt_state, item.processing_state, item.analysis_revision, item.created_at,
            item.expires_at, item.visibility, item.data
       FROM intake_items AS item
       JOIN candidate_profiles AS profile
         ON CAST(profile.id AS TEXT) = item.confidential_scope_id
        AND profile.tenant_id = item.tenant_id
      WHERE item.tenant_id = ? AND profile.owner_user_id = ?
      ORDER BY item.created_at ASC`,
    [scope.tenantId, scope.userId],
  );
  return (result.rows as Array<Record<string, unknown>>)
    .filter((row) => capturedPrincipal(row.data) === scope.userId)
    .map((row) => ({
      analysisRevision: Number(row.analysis_revision),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      id: row.id,
      processingState: row.processing_state,
      receiptState: row.receipt_state,
      visibility: row.visibility,
    }));
}
