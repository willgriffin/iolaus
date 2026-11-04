const managedTriggerFunctions = [
  'enforce_source_parent_provenance',
  'enforce_source_parent_reverse_provenance',
  'matching_touch_opportunities',
  'matching_touch_sources',
  'matching_touch_candidate_profiles',
  'matching_touch_resume_skills',
  'matching_touch_resume_positions',
  'matching_touch_resume_achievements',
  'matching_touch_preference_rules',
  'matching_touch_memberships',
  'matching_touch_users',
  'matching_touch_tenants',
  'matching_touch_skill_terms',
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
    managedTables: [
      '_smrt_agent_schedules',
      'matching_revision_clock',
      'matching_source_versions',
      'matching_profile_versions',
      'matching_source_listing_versions',
      'matching_vocabulary_version',
      'matching_source_facts',
      'matching_source_interpretations',
      'matching_source_extraction_cursor',
      'matching_profile_facts',
      'matching_results',
      'matching_worker_cursor',
    ],
    retainedTables: [
      'asset_association_collections',
      'data_repair_audit',
      'data_repair_runs',
      'fact_content_collections',
    ],
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
