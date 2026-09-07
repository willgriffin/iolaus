const managedTriggerFunctions = [
  'enforce_source_parent_provenance',
  'enforce_source_parent_reverse_provenance',
];

/**
 * PostgreSQL deployment access is an explicit operator opt-in. Keeping this
 * separate from the normal runtime configuration preserves local SQLite and
 * ordinary hosted deployments until their offline qualification is complete.
 */
export function postgresPermissionsForRuntime({ enabled, profile }) {
  if (profile === 'local' || !enabled) return undefined;

  return {
    schema: 'public',
    schemaExclusive: true,
    migrationOwner: 'iolaus_willgriffin_migration',
    runtimeRole: 'iolaus_willgriffin_runtime',
    managedTables: ['_smrt_agent_schedules'],
    retainedTables: ['data_repair_audit', 'data_repair_runs'],
    managedTriggerFunctions,
    monitor: {
      role: 'iolaus_willgriffin_monitor',
      tables: {
        _smrt_jobs: ['queue', 'status'],
        source_crawls: ['status', 'started_at', 'finished_at'],
      },
    },
  };
}
