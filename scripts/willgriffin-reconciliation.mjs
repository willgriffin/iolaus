import { createHash } from 'node:crypto';

export const MIGRATION_RECONCILIATION_SCHEMA_VERSION = 1;

export const RECONCILIATION_REASON_CODES = Object.freeze({
  assetChecksumMismatch: 'ASSET_CHECKSUM_MISMATCH',
  assetInvalidChecksum: 'ASSET_INVALID_CHECKSUM',
  assetMissing: 'ASSET_MISSING',
  duplicateNaturalKey: 'DUPLICATE_NATURAL_KEY',
  invalidQualifiedType: 'INVALID_QUALIFIED_STI',
  junctionCardinality: 'JUNCTION_CARDINALITY_MISMATCH',
  malformedUuid: 'MALFORMED_UUID',
  missingParent: 'MISSING_PARENT',
  referenceCycle: 'REFERENCE_CYCLE',
  stableIdCollision: 'STABLE_ID_COLLISION',
  tenantMismatch: 'TENANT_MISMATCH',
});

export const INTENTIONAL_MIGRATION_EXCLUSIONS = Object.freeze([
  { category: 'authentication', item: 'sessions-and-tokens' },
  { category: 'authentication', item: 'api-and-cli-credentials' },
  { category: 'configuration', item: 'deployment-secrets' },
  { category: 'operational', item: 'live-worker-and-delivery-leases' },
  { category: 'operational', item: 'framework-migration-and-change-telemetry' },
  { category: 'transient', item: 'preview-and-idempotency-rows' },
  { category: 'transient', item: 'unreferenced-temporary-artifacts' },
]);

export const SMRT_UPGRADE_HAZARDS = Object.freeze([
  {
    code: 'DOMAIN_PACKAGE_QUALIFIER_RENAME',
    disposition: 'table-bound-domain-rows',
    status: 'verified',
    verification:
      'Domain rows are imported by table; obsolete class/object registries are excluded.',
  },
  {
    code: 'PERSISTED_QUALIFIED_STI',
    disposition: 'validated',
    status: 'verified',
    verification: 'Every persisted _meta_type value must be present and package-qualified.',
  },
  {
    code: 'SOURCE_UUID_TO_TEXT_ID',
    disposition: 'explicit-adapter',
    status: 'verified',
    verification: 'Source.id is the approved UUID-to-TEXT contract exception.',
  },
  {
    code: 'APPLICATION_SCHEDULE_TEXT_ID',
    disposition: 'explicit-adapter',
    status: 'verified',
    verification: 'Application schedule ids retain their source-crawl:<uuid> text shape.',
  },
]);

// PostgreSQL's UUID input type accepts the complete 128-bit UUID domain, not
// only RFC-generated values with a version/variant nibble. Reconciliation must
// therefore validate canonical storage compatibility rather than provenance.
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const QUALIFIED_STI = /^@[a-z0-9][a-z0-9._/-]*:[A-Za-z_$][A-Za-z0-9_$]*$/u;

const REFERENCE_OVERRIDES = Object.freeze({
  _smrt_job_events: { job_id: '_smrt_jobs' },
  access_requests: { resulting_user_id: 'users' },
  achievement_attachments: {
    achievement_id: 'achievements',
    attachment_id: 'attachments',
  },
  achievement_tags: { achievement_id: 'achievements', tag_id: 'tags' },
  achievements: { experience_id: 'experiences', project_id: 'projects' },
  agent_runs: {
    application_id: 'applications',
    actor_profile_id: 'profiles',
    initiated_by_user_id: 'users',
    opportunity_id: 'opportunities',
    organization_profile_id: 'profiles',
    source_id: 'sources',
    task_id: 'tasks',
  },
  application_material_comments: {
    application_id: 'applications',
    reviewer_profile_id: 'profiles',
    reviewer_user_id: 'users',
  },
  applications: {
    approved_by_profile_id: 'profiles',
    approved_by_user_id: 'users',
    cover_letter_asset_id: 'resume_assets',
    decision_id: 'decisions',
    evaluation_score_id: 'evaluation_scores',
    final_approved_by_user_id: 'users',
    opportunity_id: 'opportunities',
    packet_asset_id: 'resume_assets',
    resume_asset_id: 'resume_assets',
    resume_variant_id: 'resume_variants',
    source_crawl_id: 'source_crawls',
    source_crawl_item_id: 'source_crawl_items',
    submitted_by_profile_id: 'profiles',
    submitted_by_user_id: 'users',
  },
  candidate_profile_links: {
    profile_key: ['candidate_profiles', 'profile_key'],
  },
  candidate_answers: {
    profile_key: ['candidate_profiles', 'profile_key'],
  },
  company_attachments: { attachment_id: 'attachments', company_id: 'companies' },
  company_research: {
    hq_place_id: 'places',
    organization_profile_id: 'profiles',
  },
  company_tags: { company_id: 'companies', tag_id: 'tags' },
  decision_tags: { decision_id: 'decisions', tag_id: 'tags' },
  decisions: {
    agent_run_id: 'agent_runs',
    application_id: 'applications',
    decider_profile_id: 'profiles',
    decider_user_id: 'users',
    evaluation_score_id: 'evaluation_scores',
    opportunity_id: 'opportunities',
    source_crawl_id: 'source_crawls',
    source_crawl_item_id: 'source_crawl_items',
    task_id: 'tasks',
  },
  duties: { experience_id: 'experiences', project_id: 'projects' },
  duty_tags: { duty_id: 'duties', tag_id: 'tags' },
  education: { profile_key: ['candidate_profiles', 'profile_key'] },
  education_tags: { education_id: 'education', tag_id: 'tags' },
  employment_role_tags: { role_id: 'employment_roles', tag_id: 'tags' },
  evaluation_scores: {
    agent_run_id: 'agent_runs',
    created_by_profile_id: 'profiles',
    opportunity_id: 'opportunities',
    source_crawl_id: 'source_crawls',
    source_crawl_item_id: 'source_crawl_items',
    source_id: 'sources',
  },
  experience_companies: { company_id: 'companies', experience_id: 'experiences' },
  experience_roles: { experience_id: 'experiences', role_id: 'employment_roles' },
  experience_tags: { experience_id: 'experiences', tag_id: 'tags' },
  fact_candidates: {
    created_fact_id: 'facts',
    fact_intake_id: 'fact_intakes',
    reviewed_by_profile_id: 'profiles',
    reviewed_by_user_id: 'users',
  },
  fact_intakes: {
    created_by_profile_id: 'profiles',
    created_by_user_id: 'users',
  },
  opportunity_companies: {
    company_research_id: 'company_research',
    opportunity_id: 'opportunities',
    organization_profile_id: 'profiles',
    source_crawl_item_id: 'source_crawl_items',
  },
  opportunity_intelligence_requests: {
    agent_run_id: 'agent_runs',
    opportunity_id: 'opportunities',
    source_crawl_id: 'source_crawls',
    source_crawl_item_id: 'source_crawl_items',
  },
  opportunity_intelligence_results: {
    agent_run_id: 'agent_runs',
    opportunity_id: 'opportunities',
    owner_request_id: 'opportunity_intelligence_requests',
    source_crawl_id: 'source_crawls',
    source_crawl_item_id: 'source_crawl_items',
  },
  opportunity_places: { opportunity_id: 'opportunities', place_id: 'places' },
  opportunity_roles: { opportunity_id: 'opportunities', role_id: 'employment_roles' },
  opportunity_tags: { opportunity_id: 'opportunities', tag_id: 'tags' },
  opportunities: {
    company_id: 'companies',
    organization_profile_id: 'profiles',
    reviewed_by_profile_id: 'profiles',
    reviewed_by_user_id: 'users',
    source_id: 'sources',
    source_intelligence_job_id: '_smrt_jobs',
  },
  people: { company_id: 'companies' },
  project_attachments: { attachment_id: 'attachments', project_id: 'projects' },
  project_tags: { project_id: 'projects', tag_id: 'tags' },
  projects: { experience_id: 'experiences' },
  resume_achievements: {
    position_id: ['resume_positions', 'position_id'],
  },
  resume_assets: {
    application_id: 'applications',
    candidate_profile_id: 'candidate_profiles',
    source_asset_id: 'resume_assets',
    tailoring_id: 'resume_tailoring_configs',
    target_opportunity_id: 'opportunities',
  },
  resume_skill_categories: { category_id: 'skill_categories' },
  resume_skill_groups: { group_id: 'skill_groups' },
  resume_skills: { category_id: 'skill_categories', skill_id: 'tags' },
  resume_variants: {
    application_id: 'applications',
    candidate_profile_id: 'candidate_profiles',
    company_id: 'companies',
    opportunity_id: 'opportunities',
    resume_asset_id: 'resume_assets',
    source_variant_id: 'resume_variants',
    tailoring_config_id: 'resume_tailoring_configs',
  },
  skill_category_members: { category_id: 'skill_categories', tag_id: 'tags' },
  skill_group_members: { group_id: 'skill_groups', tag_id: 'tags' },
  source_crawl_items: {
    duplicate_of_source_crawl_item_id: 'source_crawl_items',
    intelligence_job_id: '_smrt_jobs',
    opportunity_id: 'opportunities',
    source_crawl_id: 'source_crawls',
  },
  source_crawls: {
    actor_profile_id: 'profiles',
    agent_run_id: 'agent_runs',
    initiated_by_user_id: 'users',
    job_id: '_smrt_jobs',
    source_id: 'sources',
  },
  source_tags: { source_id: 'sources', tag_id: 'tags' },
  sources: { owner_profile_id: 'profiles' },
  tasks: {
    application_id: 'applications',
    assigned_to_profile_id: 'profiles',
    company_id: 'companies',
    created_by_profile_id: 'profiles',
    decision_id: 'decisions',
    opportunity_id: 'opportunities',
    organization_profile_id: 'profiles',
    source_id: 'sources',
  },
  users: { profile_id: 'profiles' },
});

const NATURAL_KEYS = Object.freeze({
  candidate_answers: [['profile_key', 'label_key']],
  candidate_profiles: [['profile_key']],
  companies: [['company_key']],
  employment_roles: [['role_slug']],
  experiences: [['experience_key']],
  projects: [['project_key']],
  resume_tailoring_configs: [['config_slug']],
  skill_categories: [['category_key']],
  skill_groups: [['group_key']],
});

const JUNCTION_KEYS = Object.freeze({
  achievement_attachments: ['achievement_id', 'attachment_id'],
  achievement_tags: ['achievement_id', 'tag_id', 'tag_role'],
  company_attachments: ['company_id', 'attachment_id'],
  company_tags: ['company_id', 'tag_id', 'tag_role'],
  decision_tags: ['decision_id', 'tag_id', 'tag_role'],
  duty_tags: ['duty_id', 'tag_id', 'tag_role'],
  education_tags: ['education_id', 'tag_id', 'tag_role'],
  employment_role_tags: ['role_id', 'tag_id', 'tag_role'],
  experience_companies: ['experience_id', 'company_id'],
  experience_roles: ['experience_id', 'role_id'],
  experience_tags: ['experience_id', 'tag_id', 'tag_role'],
  opportunity_places: ['opportunity_id', 'place_id'],
  opportunity_roles: ['opportunity_id', 'role_id'],
  opportunity_tags: ['opportunity_id', 'tag_id', 'tag_role'],
  project_attachments: ['project_id', 'attachment_id'],
  project_tags: ['project_id', 'tag_id', 'tag_role'],
  skill_category_members: ['category_id', 'tag_id'],
  skill_group_members: ['group_id', 'tag_id'],
  source_tags: ['source_id', 'tag_id', 'tag_role'],
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function selectorHash(runId, table, id) {
  return sha256(stableJson([runId, table, String(id)]));
}

function emptyCounts() {
  return {
    attempted: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    rejected: 0,
    repaired: 0,
  };
}

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
  return target;
}

function tableIndex(bundle) {
  return new Map(
    bundle.tables.map((table) => [
      table.name,
      new Map(table.rows.map((row) => [String(row.values.id), row])),
    ]),
  );
}

function contractIndex(contract) {
  return new Map(contract.map((table) => [table.name, table]));
}

export function migrationReferenceRules(table, availableTables) {
  const rules = new Map();
  for (const column of table.columns) {
    if (column.referencesTable) {
      rules.set(column.name, {
        column: column.name,
        parentColumn: 'id',
        parentTable: column.referencesTable,
        required: column.notNull === true,
      });
    }
  }
  const tenantColumn = table.columns.find(
    (column) => column.name === 'tenant_id',
  );
  if (table.name !== 'tenants' && tenantColumn && availableTables.has('tenants')) {
    rules.set('tenant_id', {
      column: 'tenant_id',
      parentColumn: 'id',
      parentTable: 'tenants',
      required: tenantColumn.notNull === true,
    });
  }
  for (const [column, target] of Object.entries(
    REFERENCE_OVERRIDES[table.name] || {},
  )) {
    const [parentTable, parentColumn = 'id'] = Array.isArray(target)
      ? target
      : [target, 'id'];
    if (!availableTables.has(parentTable)) continue;
    const definition = table.columns.find((candidate) => candidate.name === column);
    if (!definition) continue;
    rules.set(column, {
      column,
      parentColumn,
      parentTable,
      required: definition.notNull === true,
    });
  }
  return [...rules.values()].sort((left, right) =>
    left.column.localeCompare(right.column),
  );
}

function naturalKeys(table) {
  const columnNames = new Set(table.columns.map((column) => column.name));
  const keys = [...(table.uniqueKeys || [])];
  if (
    keys.length === 0 &&
    columnNames.has('slug') &&
    columnNames.has('context')
  ) {
    keys.push(['slug', 'context']);
  }
  for (const key of NATURAL_KEYS[table.name] || []) {
    if (key.every((column) => columnNames.has(column))) keys.push(key);
  }
  const junction = JUNCTION_KEYS[table.name];
  if (junction?.every((column) => columnNames.has(column))) keys.push(junction);
  return keys;
}

function quarantineEntry(runId, table, row, reasonCode, details = {}) {
  return {
    field: details.field || null,
    parentTable: details.parentTable || null,
    reasonCode,
    recordKeyHash: selectorHash(runId, table, row.sourceId),
    referenceKeyHash:
      details.reference == null
        ? null
        : selectorHash(
            runId,
            details.parentTable || table,
            details.reference,
          ),
    table,
  };
}

function repairEntry(runId, table, row, field, reasonCode) {
  return {
    field,
    reasonCode,
    recordKeyHash: selectorHash(runId, table, row.sourceId),
    table,
  };
}

function addQuarantine(state, entry) {
  const key = stableJson(entry);
  if (state.quarantineKeys.has(key)) return false;
  state.quarantineKeys.add(key);
  state.quarantine.push(entry);
  state.rejected.add(`${entry.table}:${entry.recordKeyHash}`);
  return true;
}

function rowRejected(state, runId, table, row) {
  return state.rejected.has(
    `${table}:${selectorHash(runId, table, row.sourceId)}`,
  );
}

function parentLookup(index, parentTable, parentColumn, value) {
  const parents = index.get(parentTable);
  if (!parents) return null;
  if (parentColumn === 'id') return parents.get(String(value)) || null;
  for (const row of parents.values()) {
    if (row.values[parentColumn] === value) return row;
  }
  return null;
}

function quarantineDuplicateKeys({ bundle, contracts, state }) {
  for (const tableBundle of bundle.tables) {
    const table = contracts.get(tableBundle.name);
    if (!table) continue;
    for (const keyColumns of naturalKeys(table)) {
      const groups = new Map();
      for (const row of tableBundle.rows) {
        const values = keyColumns.map((column) => row.values[column]);
        if (values.some((value) => value == null)) continue;
        const key = stableJson(values);
        const rows = groups.get(key) || [];
        rows.push(row);
        groups.set(key, rows);
      }
      for (const rows of groups.values()) {
        if (rows.length < 2) continue;
        const junctionKey =
          JUNCTION_KEYS[table.name] ||
          keyColumns.filter((column) => column.endsWith('_id')).length >= 2;
        const reasonCode = junctionKey
          ? RECONCILIATION_REASON_CODES.junctionCardinality
          : RECONCILIATION_REASON_CODES.duplicateNaturalKey;
        for (const row of rows) {
          addQuarantine(
            state,
            quarantineEntry(bundle.runId, table.name, row, reasonCode, {
              field: keyColumns.join(','),
            }),
          );
        }
      }
    }
  }
}

function quarantineCycles({ bundle, contracts, index, state }) {
  for (const tableBundle of bundle.tables) {
    const table = contracts.get(tableBundle.name);
    if (!table) continue;
    const selfRules = migrationReferenceRules(table, contracts).filter(
      (rule) => rule.parentTable === table.name && rule.parentColumn === 'id',
    );
    for (const rule of selfRules) {
      const visiting = new Set();
      const visited = new Set();
      const walk = (row, path) => {
        if (visited.has(row.sourceId) || rowRejected(state, bundle.runId, table.name, row))
          return;
        if (visiting.has(row.sourceId)) {
          const start = path.findIndex((candidate) => candidate.sourceId === row.sourceId);
          for (const member of path.slice(start)) {
            addQuarantine(
              state,
              quarantineEntry(
                bundle.runId,
                table.name,
                member,
                RECONCILIATION_REASON_CODES.referenceCycle,
                { field: rule.column },
              ),
            );
          }
          return;
        }
        visiting.add(row.sourceId);
        const parentId = row.values[rule.column];
        const parent =
          parentId == null || parentId === ''
            ? null
            : index.get(table.name)?.get(String(parentId));
        if (parent) walk(parent, [...path, row]);
        visiting.delete(row.sourceId);
        visited.add(row.sourceId);
      };
      for (const row of tableBundle.rows) walk(row, []);
    }
  }
}

/**
 * Build a deterministic, secret-safe gate for the logical import. Returned
 * accepted rows retain private values in memory; the serializable report never
 * includes ids, natural keys, field values, paths, URLs, or database details.
 */
export function reconcileMigrationRows({
  bundle,
  sourceContract,
  strictNativeTypes = true,
}) {
  bundle = structuredClone(bundle);
  const contracts = contractIndex(sourceContract);
  const index = tableIndex(bundle);
  const state = {
    quarantine: [],
    quarantineKeys: new Set(),
    rejected: new Set(),
    repairs: [],
  };

  for (const tableBundle of bundle.tables) {
    const table = contracts.get(tableBundle.name);
    if (!table) continue;
    const rules = migrationReferenceRules(table, contracts);
    for (const row of tableBundle.rows) {
      for (const column of table.columns) {
        const value = row.values[column.name];
        if (
          strictNativeTypes &&
          column.type === 'UUID' &&
          value != null &&
          value !== '' &&
          !UUID.test(String(value))
        ) {
          addQuarantine(
            state,
            quarantineEntry(
              bundle.runId,
              table.name,
              row,
              RECONCILIATION_REASON_CODES.malformedUuid,
              { field: column.name },
            ),
          );
        }
      }
      const hasStiDiscriminator = table.columns.some(
        (column) => column.name === '_meta_type',
      );
      if (
        hasStiDiscriminator &&
        !QUALIFIED_STI.test(String(row.values._meta_type ?? ''))
      ) {
        addQuarantine(
          state,
          quarantineEntry(
            bundle.runId,
            table.name,
            row,
            RECONCILIATION_REASON_CODES.invalidQualifiedType,
            { field: '_meta_type' },
          ),
        );
      }
      for (const rule of rules) {
        if (row.values[rule.column] === '' && !rule.required) {
          row.values[rule.column] = null;
          state.repairs.push(
            repairEntry(
              bundle.runId,
              table.name,
              row,
              rule.column,
              'EMPTY_REFERENCE_TO_NULL',
            ),
          );
        }
      }
    }
  }

  quarantineDuplicateKeys({ bundle, contracts, state });
  quarantineCycles({ bundle, contracts, index, state });

  let changed = true;
  while (changed) {
    changed = false;
    for (const tableBundle of bundle.tables) {
      const table = contracts.get(tableBundle.name);
      if (!table) continue;
      for (const row of tableBundle.rows) {
        if (rowRejected(state, bundle.runId, table.name, row)) continue;
        for (const rule of migrationReferenceRules(table, contracts)) {
          const value = row.values[rule.column];
          if (value == null || value === '') {
            if (rule.required) {
              changed =
                addQuarantine(
                  state,
                  quarantineEntry(
                    bundle.runId,
                    table.name,
                    row,
                    RECONCILIATION_REASON_CODES.missingParent,
                    { field: rule.column, parentTable: rule.parentTable },
                  ),
                ) || changed;
            }
            continue;
          }
          const parent = parentLookup(
            index,
            rule.parentTable,
            rule.parentColumn,
            value,
          );
          if (
            !parent ||
            rowRejected(state, bundle.runId, rule.parentTable, parent)
          ) {
            changed =
              addQuarantine(
                state,
                quarantineEntry(
                  bundle.runId,
                  table.name,
                  row,
                  RECONCILIATION_REASON_CODES.missingParent,
                  {
                    field: rule.column,
                    parentTable: rule.parentTable,
                    reference: value,
                  },
                ),
              ) || changed;
            continue;
          }
          const tenantId = row.values.tenant_id;
          const parentTenantId = parent.values.tenant_id;
          if (
            parentTenantId != null &&
            String(tenantId) !== String(parentTenantId)
          ) {
            changed =
              addQuarantine(
                state,
                quarantineEntry(
                  bundle.runId,
                  table.name,
                  row,
                  RECONCILIATION_REASON_CODES.tenantMismatch,
                  {
                    field: rule.column,
                    parentTable: rule.parentTable,
                    reference: value,
                  },
                ),
              ) || changed;
          }
        }
      }
    }
  }

  state.quarantine.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  state.repairs.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const acceptedTables = bundle.tables.map((table) => ({
    name: table.name,
    rows: table.rows.filter(
      (row) => !rowRejected(state, bundle.runId, table.name, row),
    ),
  }));
  const tableReports = bundle.tables
    .map((table) => {
      const counts = emptyCounts();
      counts.attempted = table.rows.length;
      counts.rejected = new Set(
        state.quarantine
          .filter((entry) => entry.table === table.name)
          .map((entry) => entry.recordKeyHash),
      ).size;
      counts.repaired = new Set(
        state.repairs
          .filter((entry) => entry.table === table.name)
          .map((entry) => entry.recordKeyHash),
      ).size;
      const accepted = acceptedTables.find((entry) => entry.name === table.name);
      return {
        counts,
        name: table.name,
        sourceChecksum: table.checksum,
        acceptedChecksum: sha256(
          stableJson(
            accepted.rows.map((row) => [
              row.sourceId,
              sha256(stableJson(row.values)),
            ]),
          ),
        ),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const totals = emptyCounts();
  for (const table of tableReports) addCounts(totals, table.counts);
  const reportCore = {
    schemaVersion: MIGRATION_RECONCILIATION_SCHEMA_VERSION,
    runId: bundle.runId,
    sourceFingerprint: bundle.sourceFingerprint,
    counts: totals,
    tables: tableReports,
    quarantine: state.quarantine,
    repairs: state.repairs,
    collisions: [],
    unresolvedReferences: state.quarantine.filter(
      (entry) => entry.reasonCode === RECONCILIATION_REASON_CODES.missingParent,
    ),
    assets: reconcileAssetInventory({
      runId: bundle.runId,
      assets: [],
      status: 'pending',
    }),
    exclusions: INTENTIONAL_MIGRATION_EXCLUSIONS,
    excludedTables: [...bundle.excludedTables].sort(),
    approvedOmissions: [],
    smrtUpgradeHazards: SMRT_UPGRADE_HAZARDS,
    secretValuesIncluded: false,
  };
  const reportDigest = sha256(stableJson(reportCore));
  const report = {
    ...reportCore,
    reportDigest,
    operatorSummary: `Migration reconciliation ${reportDigest.slice(0, 12)}: ${totals.attempted} attempted, ${totals.rejected} quarantined, ${totals.repaired} repaired.`,
  };
  return { acceptedTables, report };
}

export function reconcileAssetInventory({ runId, assets, status = 'complete' }) {
  const counts = { attempted: 0, verified: 0, rejected: 0 };
  const inventory = [];
  const quarantine = [];
  for (const asset of [...assets].sort((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  )) {
    counts.attempted += 1;
    const selector = selectorHash(runId, 'assets', asset.id);
    const sourceChecksum = canonicalAssetChecksum(asset.sourceChecksum);
    const targetChecksum = canonicalAssetChecksum(asset.targetChecksum);
    inventory.push({
      recordKeyHash: selector,
      sourceChecksum,
      targetChecksum,
    });
    if (!sourceChecksum || (asset.targetChecksum && !targetChecksum)) {
      counts.rejected += 1;
      quarantine.push({
        reasonCode: RECONCILIATION_REASON_CODES.assetInvalidChecksum,
        recordKeyHash: selector,
      });
    } else if (!asset.targetChecksum) {
      counts.rejected += 1;
      quarantine.push({
        reasonCode: RECONCILIATION_REASON_CODES.assetMissing,
        recordKeyHash: selector,
      });
    } else if (sourceChecksum !== targetChecksum) {
      counts.rejected += 1;
      quarantine.push({
        reasonCode: RECONCILIATION_REASON_CODES.assetChecksumMismatch,
        recordKeyHash: selector,
      });
    } else {
      counts.verified += 1;
    }
  }
  const effectiveStatus =
    status === 'complete' && counts.rejected > 0
      ? 'complete-with-rejections'
      : status;
  const core = {
    status: effectiveStatus,
    counts,
    inventory,
    quarantine,
    secretValuesIncluded: false,
  };
  return { ...core, digest: sha256(stableJson(core)) };
}

function canonicalAssetChecksum(value) {
  return /^[0-9a-f]{64}$/iu.test(String(value || ''))
    ? String(value).toLowerCase()
    : null;
}

export function recordStableIdCollision(report, { runId, table, sourceId }) {
  const entry = {
    reasonCode: RECONCILIATION_REASON_CODES.stableIdCollision,
    recordKeyHash: selectorHash(runId, table, sourceId),
    table,
  };
  if (!report.collisions.some((candidate) => stableJson(candidate) === stableJson(entry))) {
    report.collisions.push(entry);
    report.collisions.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  }
}

export function finalizeReconciliationReport(report, tableResults, assetReport) {
  const resultByName = new Map(tableResults.map((table) => [table.name, table]));
  const tables = report.tables.map((table) => {
    const result = resultByName.get(table.name) || {};
    const counts = {
      ...table.counts,
      imported: result.inserted || 0,
      skipped: result.skipped || 0,
      updated: result.updated || 0,
    };
    return {
      ...table,
      counts,
      retainedTargetRows: result.retainedTargetRows || 0,
      targetRowCount: result.targetRowCount ?? counts.imported + counts.updated + counts.skipped,
      targetChecksum: result.targetChecksum || table.acceptedChecksum,
    };
  });
  const counts = emptyCounts();
  for (const table of tables) addCounts(counts, table.counts);
  const core = {
    ...report,
    assets: assetReport || report.assets,
    counts,
    operatorSummary: undefined,
    reportDigest: undefined,
    tables,
  };
  delete core.operatorSummary;
  delete core.reportDigest;
  const reportDigest = sha256(stableJson(core));
  return {
    ...core,
    reportDigest,
    operatorSummary: `Migration reconciliation ${reportDigest.slice(0, 12)}: ${counts.attempted} attempted, ${counts.imported} imported, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.rejected} quarantined, ${counts.repaired} repaired; assets ${core.assets.status} (${core.assets.counts.verified} verified, ${core.assets.counts.rejected} quarantined).`,
  };
}
