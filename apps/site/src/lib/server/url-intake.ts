import { createHash } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase, type User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { resolveUrlIntake, type UrlIntakeDetection } from '$lib/url-intake';
import { getDbConfig } from './db.js';
import { importJobOpportunity } from './job-search-webmcp.js';
import { enqueueOpportunityIntelligenceWithStatus } from './opportunity-intelligence-job.js';
import {
  type OwnerPrincipalLocals,
  type PrincipalRun,
  runAsOwner,
} from './owner-principal.js';
import {
  PUBLIC_HTTPS_TIMEOUT_MS,
  validatePublicHttpsUrl,
} from './public-https.js';
import { getCollection } from './smrt.js';
import {
  assertSourceCrawlOperations,
  requireSourceCrawlOperator,
} from './source-crawl-operator.js';
import {
  createRootSourceFromWebMcp,
  enqueueRootSourceCrawl,
  type SourceWebMcpDependencies,
} from './source-webmcp.js';
import {
  KeyedLockTimeoutError,
  withSqliteOperationLock,
} from './sqlite-operation-lock.js';
import {
  requireCandidateWorkspaceSubject,
  workspaceSubjectFromLocals,
} from './workspace-subject.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

export interface UrlIntakeResult {
  status: 'needs_choice' | 'queued' | 'saved';
  kind: UrlIntakeDetection['kind'];
  url: string;
  message: string;
  created?: boolean;
  href?: string;
  jobId?: string;
  crawlId?: string;
}

async function workflow(
  run: PrincipalRun,
  capability: 'audit.record' | 'assessment.execute',
) {
  const operation = workspaceWorkflowOperation(capability);
  await run.assertOperation(operation.collection, operation.action);
}

async function reuseOrCreateSource(
  detection: UrlIntakeDetection,
  user: Pick<User, 'id'>,
) {
  const database =
    getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
  const transact = database.transaction?.bind(database);
  if (!transact) error(503, 'Transactional source creation is unavailable.');
  const key = `url-intake-source:${createHash('sha256').update(detection.url).digest('hex')}`;
  const work = async () =>
    await transact(async (transaction) => {
      if (getDbConfig().type !== 'sqlite') {
        await transaction.query("SET LOCAL lock_timeout = '15s'");
        await transaction.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
          key,
        ]);
      }
      const sources = (await getCollection('Source', {
        db: transaction,
      })) as unknown as NonNullable<
        SourceWebMcpDependencies['sourceCollection']
      >;
      const existing = await sources.list({
        limit: 2,
        where: { url: detection.url, sourceRole: 'root' },
      });
      if (existing.length > 1)
        error(
          409,
          'This URL has multiple existing sources. Open Sources to resolve them.',
        );
      if (existing[0])
        return {
          id: String(existing[0].id ?? ''),
          created: false,
          active: existing[0].isActive === true,
        };
      const source = await createRootSourceFromWebMcp(
        {
          url: detection.url,
          name: detection.name,
          provider: detection.provider,
          type: 'company_careers',
          active: true,
        },
        user,
        { database: transaction, sourceCollection: sources },
      );
      return { id: source.id, created: true, active: true };
    });
  try {
    return getDbConfig().type === 'sqlite'
      ? await withSqliteOperationLock(key, work)
      : await work();
  } catch (cause) {
    if (cause instanceof KeyedLockTimeoutError)
      error(409, 'This URL is already being added. Try again shortly.');
    throw cause;
  }
}

/** This form delegates to existing native workflows; no browser-owned IDs or authority are accepted. */
export async function ingestPublicUrl(
  input: Record<string, unknown>,
  locals: OwnerPrincipalLocals,
): Promise<UrlIntakeResult> {
  const subject = requireCandidateWorkspaceSubject(
    workspaceSubjectFromLocals(locals),
  );
  const detection = resolveUrlIntake(input.url, input.kind);
  // Authenticate and freshly verify membership even for a no-network classification response.
  await runAsOwner(locals, async () => undefined, {
    action: 'admin.url_intake.detect',
  });
  if (detection.kind === 'choice')
    return {
      status: 'needs_choice',
      kind: 'choice',
      url: detection.url,
      message: 'Is this one opportunity or a job board/careers page?',
    };
  await validatePublicHttpsUrl(
    detection.url,
    undefined,
    Date.now() + PUBLIC_HTTPS_TIMEOUT_MS,
  );
  const user = locals.user;
  if (!user) error(401, 'Sign in before adding a URL.');
  if (detection.kind === 'opportunity') {
    const imported = await runAsOwner(
      locals,
      async (run) => {
        run.assertToolAllowed('job_search_import_opportunity');
        await workflow(run, 'audit.record');
        await run.assertOperation('companies', 'read');
        for (const operation of ['read', 'create', 'update', 'delete'] as const)
          await run.assertOperation('opportunities', operation);
        return await importJobOpportunity({ url: detection.url }, user);
      },
      { action: 'admin.url_intake.import' },
    );
    const id = imported.opportunity.id;
    const href = `/admin/opportunities/${encodeURIComponent(id)}`;
    if (!['resolved', 'reused'].includes(imported.detail.status))
      return {
        status: 'saved',
        kind: 'opportunity',
        url: detection.url,
        created: imported.created,
        href,
        message: `Opportunity saved. ${imported.detail.message || 'Posting details are not available yet.'}`,
      };
    try {
      const queued = await runAsOwner(
        locals,
        async (run) => {
          await workflow(run, 'assessment.execute');
          return await enqueueOpportunityIntelligenceWithStatus(id, {
            modes: 'assessment',
            reason: 'url_intake',
          });
        },
        { action: 'admin.url_intake.process' },
      );
      return {
        status: 'queued',
        kind: 'opportunity',
        url: detection.url,
        created: imported.created,
        href,
        ...(queued.job.id ? { jobId: queued.job.id } : {}),
        message: `${imported.created ? 'Opportunity added' : 'Existing opportunity found'}. ${queued.stage === 'source_preparation' ? 'Source preparation' : 'Assessment'} ${queued.enqueued ? 'queued' : 'already queued'}. Follow progress in Activities.`,
      };
    } catch (cause) {
      return {
        status: 'saved',
        kind: 'opportunity',
        url: detection.url,
        created: imported.created,
        href,
        message: `Opportunity saved; processing was not queued. ${cause instanceof Error ? cause.message : 'Open the opportunity to try processing again.'}`,
      };
    }
  }
  const source = await runAsOwner(
    locals,
    async (run) => {
      try {
        requireSourceCrawlOperator();
      } catch {
        error(403, 'Only a workspace operator can add a source.');
      }
      run.assertToolAllowed('job_search_create_source');
      for (const operation of ['read', 'create'] as const)
        await run.assertOperation('sources', operation);
      await workflow(run, 'audit.record');
      return await reuseOrCreateSource(detection, user);
    },
    { action: 'admin.url_intake.source' },
  );
  const href = `/admin/sources/${encodeURIComponent(source.id)}`;
  if (!source.active)
    return {
      status: 'saved',
      kind: 'source',
      url: detection.url,
      created: false,
      href,
      message:
        'This source already exists and is paused. Open it to choose whether to resume pulling listings.',
    };
  const idempotencyKey = `url-intake:v1:${createHash('sha256')
    .update(
      JSON.stringify([
        detection.url,
        subject.tenantId,
        subject.userId,
        subject.profileId,
      ]),
    )
    .digest('hex')}`;
  try {
    const queued = await runAsOwner(
      locals,
      async (run) => {
        run.assertToolAllowed('job_search_crawl_source');
        await assertSourceCrawlOperations(run);
        await workflow(run, 'audit.record');
        return await enqueueRootSourceCrawl(
          {
            sourceId: source.id,
            idempotencyKey,
            limit: 25,
            reason: 'url_intake',
          },
          user,
        );
      },
      { action: 'admin.url_intake.crawl' },
    );
    if (!['pending', 'queued', 'running'].includes(queued.status))
      return {
        status: 'saved',
        kind: 'source',
        url: detection.url,
        created: source.created,
        href,
        jobId: queued.jobId,
        crawlId: queued.crawlId,
        message: `Existing source found. Its initial pull is ${queued.status}. Open the source to review the result; adding this URL again does not start another pull.`,
      };
    return {
      status: 'queued',
      kind: 'source',
      url: detection.url,
      created: source.created,
      href,
      jobId: queued.jobId,
      crawlId: queued.crawlId,
      message: `${source.created ? 'Source added' : 'Existing source found'}. Initial pull ${queued.reused ? 'already requested' : 'queued'} (up to 25 listings). Follow progress in Activities.`,
    };
  } catch (cause) {
    return {
      status: 'saved',
      kind: 'source',
      url: detection.url,
      created: source.created,
      href,
      message: `Source saved; its initial pull was not queued. ${cause instanceof Error ? cause.message : 'Open the source to retry.'}`,
    };
  }
}
