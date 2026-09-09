import { describe, expect, it } from 'vitest';
import { postgresPermissionsForRuntime } from './postgres-permissions-config.js';

describe('PostgreSQL deployment permissions configuration', () => {
  it('keeps the local SQLite profile outside the PostgreSQL contract', () => {
    expect(
      postgresPermissionsForRuntime({ enabled: true, profile: 'local' }),
    ).toBeUndefined();
  });

  it('requires an explicit deployment opt-in', () => {
    expect(
      postgresPermissionsForRuntime({ enabled: false, profile: 'self-hosted' }),
    ).toBeUndefined();
  });

  it('declares only Iolaus deployment roles and the monitor read surface', () => {
    expect(
      postgresPermissionsForRuntime({ enabled: true, profile: 'self-hosted' }),
    ).toEqual({
      schema: 'public',
      schemaExclusive: true,
      migrationOwner: 'iolaus_willgriffin_migration',
      runtimeRole: 'iolaus_willgriffin_runtime',
      managedTables: ['_smrt_agent_schedules'],
      retainedTables: [
        'asset_association_collections',
        'data_repair_audit',
        'data_repair_runs',
        'fact_content_collections',
      ],
      managedTriggerFunctions: [
        'enforce_source_parent_provenance',
        'enforce_source_parent_reverse_provenance',
      ],
      monitor: {
        role: 'iolaus_willgriffin_monitor',
        tables: {
          _smrt_jobs: ['queue', 'status'],
          source_crawls: ['status', 'started_at', 'finished_at'],
        },
      },
    });
  });

  it('retains only the observed physical collection-wrapper artifacts', () => {
    const contract = postgresPermissionsForRuntime({
      enabled: true,
      profile: 'self-hosted',
    });

    expect(contract?.retainedTables).toEqual(
      expect.arrayContaining([
        'asset_association_collections',
        'fact_content_collections',
      ]),
    );
    for (const table of [
      'asset_association_collections',
      'fact_content_collections',
    ]) {
      expect(contract?.managedTables).not.toContain(table);
      expect(contract?.monitor.tables).not.toHaveProperty(table);
    }
    expect(contract?.retainedTables).not.toEqual(
      expect.arrayContaining(['fact_source_collections']),
    );
  });
});
