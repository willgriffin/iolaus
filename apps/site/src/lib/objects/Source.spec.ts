import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Source } from './Source';

const sourceJob = vi.hoisted(() => ({
  run: vi.fn(),
  shared: false,
}));

vi.mock('../server/app-config.js', () => ({
  getAppConfig: () => ({
    workspaceMode: sourceJob.shared ? 'shared' : 'private',
  }),
}));
vi.mock('../server/source-crawl-job.js', () => ({
  runSourceCrawlJob: sourceJob.run,
}));

describe('Source TaskRunner loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sourceJob.shared = false;
    sourceJob.run.mockReset();
  });

  it('rejects an unbound shared source crawl before the crawl handler runs', async () => {
    sourceJob.shared = true;

    await expect(new Source().crawl()).rejects.toThrow(
      'explicit operator dispatch',
    );
    expect(sourceJob.run).not.toHaveBeenCalled();
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
