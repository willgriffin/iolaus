import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Source } from './Source';

const sourceJob = vi.hoisted(() => ({
  run: vi.fn(),
  operator: vi.fn(),
  audit: vi.fn(),
  shared: false,
}));

vi.mock('../server/app-config.js', () => ({
  getAppConfig: () => ({
    workspaceMode: sourceJob.shared ? 'shared' : 'private',
  }),
}));
vi.mock('../server/source-crawl-operator.js', () => ({
  runAsSourceCrawlOperator: sourceJob.operator,
}));
vi.mock('../server/application-workflow.js', () => ({
  recordAgentAudit: sourceJob.audit,
}));
vi.mock('../server/source-crawl-job.js', () => ({
  runSourceCrawlJob: sourceJob.run,
}));

describe('Source TaskRunner loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sourceJob.shared = false;
    sourceJob.run.mockReset();
    sourceJob.operator.mockReset();
    sourceJob.audit.mockReset();
  });

  it('rejects an unbound shared source crawl before the crawl handler runs', async () => {
    sourceJob.shared = true;

    await expect(new Source().crawl()).rejects.toThrow(
      'explicit operator dispatch',
    );
    expect(sourceJob.run).not.toHaveBeenCalled();
  });

  it('delegates a shared bound crawl to the native operator fence and records the owned completion audit', async () => {
    sourceJob.shared = true;
    const subject = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      profileId: 'profile-1',
    };
    const fence = vi.fn(async (work: () => Promise<unknown>) => await work());
    sourceJob.operator.mockImplementation(
      async (_args, _context, work) => await work(subject, fence),
    );
    sourceJob.run.mockResolvedValue({ candidates: 1, created: 1 });
    const source = new Source();
    source.id = 'source-1';
    const args = { runtimeWorkspaceSubject: subject, sourceCrawlId: 'crawl-1' };
    const runner = { job: { jobId: 'job-1' } } as never;
    await expect(source.crawl(args, runner)).resolves.toMatchObject({
      created: 1,
    });
    expect(sourceJob.operator).toHaveBeenCalledWith(
      args,
      runner,
      expect.any(Function),
    );
    expect(sourceJob.run).toHaveBeenCalledWith(source, args, runner, {
      writeFence: fence,
    });
    expect(sourceJob.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-1',
        runType: 'source_crawl_execute',
        user: { id: 'user-1' },
      }),
    );
  });

  it('accepts the runner object id argument before delegating to base loadFromId', async () => {
    const baseLoad = vi
      .spyOn(SmrtObject.prototype, 'loadFromId')
      .mockResolvedValue(undefined);
    const source = new Source();

    await source.loadFromId('source-1');

    expect(source.id).toBe('source-1');
    expect(baseLoad).toHaveBeenCalledOnce();
  });

  it('generates a text parent foreign key that matches the Source primary key', () => {
    const schema = Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions(),
    ).find((candidate) => candidate.tableName === 'sources');

    expect(schema).toBeDefined();
    expect(schema?.columns.id).toMatchObject({
      primaryKey: true,
      type: 'TEXT',
    });
    expect(schema?.columns.parent_source_id).toMatchObject({
      foreignKey: {
        column: 'id',
        table: 'sources',
      },
      type: 'TEXT',
    });
  });
});
