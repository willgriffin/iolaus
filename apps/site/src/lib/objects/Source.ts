import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import type { SourceCrawlJobArgs } from '../server/source-schedules.js';

@smrt({
  tableName: 'sources',
  idType: 'text',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class Source extends SmrtObject {
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  type = 'manual';
  @field({ type: 'text', required: true })
  sourceRole = 'unknown';
  @foreignKey(() => Source, { onDelete: 'RESTRICT' })
  parentSourceId: string | null = null;
  @field({ type: 'text' })
  provider = 'unknown';
  @field({ type: 'text' })
  url = '';
  @field({ type: 'text' })
  ownerProfileId = '';
  @field({ type: 'text' })
  owner = '';
  @field({ type: 'text' })
  accountStatus = 'unknown';
  @field({ type: 'text' })
  accountNotes = '';
  @field({ type: 'text' })
  loginIdentity = '';
  @field({ type: 'text' })
  accountOwnerRole = 'owner';
  @field({ type: 'text' })
  wardenReference = '';
  @field({ type: 'text' })
  searchQuery = '';
  @field({ type: 'text' })
  refreshCadence = 'weekly';
  @field({ type: 'datetime', nullable: true })
  lastCheckedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  nextCheckAt: Date | null = null;
  @field({ type: 'boolean' })
  isActive = false;

  async loadFromId(id?: string) {
    if (id) this.id = id;
    return await super.loadFromId();
  }

  async crawl(args: SourceCrawlJobArgs = {}, context?: JobExecutionContext) {
    const { getAppConfig } = await import('../server/app-config.js');
    if ('runtimeWorkspaceSubject' in args) {
      const { runAsSourceCrawlOperator } = await import(
        '../server/source-crawl-operator.js'
      );
      const { runSourceCrawlJob } = await import(
        '../server/source-crawl-job.js'
      );
      return await runAsSourceCrawlOperator(
        args,
        context as JobExecutionContext,
        async (subject, writeFence) => {
          const summary = await runSourceCrawlJob(this, args, context, {
            writeFence,
          });
          await writeFence(async () => {
            const { recordAgentAudit } = await import(
              '../server/application-workflow.js'
            );
            await recordAgentAudit({
              input: { sourceCrawlId: args.sourceCrawlId, reason: args.reason },
              output: { ...summary },
              runType: 'source_crawl_execute',
              sourceId: this.id ?? undefined,
              status: 'completed',
              user: { id: subject.userId },
            });
          });
          return summary;
        },
      );
    }
    if (getAppConfig().workspaceMode === 'shared') {
      throw new Error(
        'Shared workspace source crawls require an explicit operator dispatch.',
      );
    }
    const { runSourceCrawlJob } = await import('../server/source-crawl-job.js');
    return await runSourceCrawlJob(this, args, context);
  }
}
