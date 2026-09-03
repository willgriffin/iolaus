import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Source } from './Source';

describe('Source TaskRunner loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
