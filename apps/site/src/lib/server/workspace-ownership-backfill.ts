import { createHash } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';

/**
 * These tables hold candidate-owned data. Keep this manifest aligned with the
 * resource policy: a migration must prove every row has an explicit owner
 * before shared hosting can rely on the ownership predicates.
 */
export const workspaceOwnershipClasses = [
  'CandidateProfile',
  'CandidateAnswer',
  'CandidateProfileLink',
  'Application',
  'ApplicationMaterialComment',
  'ResumeAsset',
  'ResumeVariant',
  'ResumeProfile',
  'PreferenceRule',
  'Decision',
  'DecisionTag',
  'Task',
  'AgentRun',
  'Achievement',
  'AchievementAttachment',
  'AchievementTag',
  'Attachment',
  'Duty',
  'DutyTag',
  'Education',
  'EducationTag',
  'EmploymentRole',
  'EmploymentRoleTag',
  'Experience',
  'ExperienceCompany',
  'ExperienceRole',
  'ExperienceTag',
  'Project',
  'ProjectAttachment',
  'ProjectTag',
  'ResumeAchievement',
  'ResumeEducation',
  'ResumeLink',
  'ResumeOtherRole',
  'ResumePosition',
  'ResumeSkill',
  'ResumeSkillCategory',
  'ResumeSkillGroup',
  'ResumeTailoringConfig',
  'SkillCategory',
  'SkillCategoryMember',
  'SkillGroup',
  'SkillGroupMember',
  'FactCandidate',
  'FactIntake',
  'EvaluationScore',
  'OpportunityAssessment',
  'OpportunityIntelligenceRequest',
  'OpportunityIntelligenceResult',
] as const;

export type WorkspaceOwnershipClass =
  (typeof workspaceOwnershipClasses)[number];
export type WorkspaceOwnershipDialect = 'postgres' | 'sqlite';

export interface WorkspaceOwnershipBinding {
  candidateProfileId: string;
  ownerUserId: string;
  tenantId: string;
}

type QueryResult =
  | { rows?: Array<Record<string, unknown>> }
  | Array<Record<string, unknown>>;
export interface WorkspaceOwnershipDatabase {
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>;
  transaction?: <T>(
    work: (database: WorkspaceOwnershipDatabase) => Promise<T>,
  ) => Promise<T>;
}

interface ScopedRow {
  candidateProfileId?: unknown;
  id: string;
  ownerUserId: unknown;
  tenantId: unknown;
}

export interface WorkspaceOwnershipTablePlan {
  alreadyBound: number;
  conflicts: number;
  missingColumns: string[];
  rows: number;
  table: string;
  toBind: number;
}

export interface WorkspaceOwnershipBackfillPlan {
  /** SHA-256 pins the exact row IDs and ownership states without logging them. */
  digest: string;
  eligible: boolean;
  profileCardinalityValid: boolean;
  tables: WorkspaceOwnershipTablePlan[];
  /** Internal apply input; callers must not include this in operator output. */
  updates: ReadonlyMap<string, readonly string[]>;
}

export interface WorkspaceOwnershipBackfillOptions {
  binding: WorkspaceOwnershipBinding;
  dialect: WorkspaceOwnershipDialect;
  /** Test-only narrowing. Production always validates the complete manifest. */
  tables?: readonly string[];
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
}

// Most SMRT models use the normal pluralized table convention. These two
// legacy resume models deliberately override it; migration planning must use
// the registry-compatible physical names rather than inventing absent tables.
const workspaceOwnershipTableOverrides: Readonly<Record<string, string>> = {
  Education: 'education',
  ResumeEducation: 'resume_education',
};

export function workspaceOwnershipTableName(className: string): string {
  const override = workspaceOwnershipTableOverrides[className];
  if (override) return override;
  const singular = snakeCase(className);
  if (singular.endsWith('y')) return `${singular.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/u.test(singular)) return `${singular}es`;
  return `${singular}s`;
}

export const workspaceOwnershipTables = workspaceOwnershipClasses.map(
  workspaceOwnershipTableName,
);

/** Fail closed if the migration manifest drifts from SMRT's physical table map. */
export function assertWorkspaceOwnershipTableMappings(): void {
  for (const className of workspaceOwnershipClasses) {
    const expected = workspaceOwnershipTableName(className);
    const actual = ObjectRegistry.getTableName(className);
    if (!actual || actual !== expected) {
      throw new Error(
        `Workspace ownership table mapping mismatch for ${className}: expected ${expected}, registry ${actual ?? 'missing'}.`,
      );
    }
  }
}

/**
 * These tables contain both subject-bound assessment rows and immutable
 * operator/source accounting history. A legacy row with an entirely blank
 * tuple is ledger history, not evidence that it belongs to the one canonical
 * candidate, so the migration preserves it unmodified.
 */
export const workspaceOwnershipMixedLedgerTables = new Set([
  workspaceOwnershipTableName('OpportunityIntelligenceRequest'),
  workspaceOwnershipTableName('OpportunityIntelligenceResult'),
]);

function rows(result: QueryResult): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function requireIdentifier(value: unknown, label: string): string {
  const id = typeof value === 'string' ? value : '';
  const hasControlCharacter = [...id].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!id || id.length > 160 || hasControlCharacter) {
    throw new Error(`A valid canonical ${label} is required.`);
  }
  return id;
}

export function requireWorkspaceOwnershipBinding(
  input: WorkspaceOwnershipBinding,
): WorkspaceOwnershipBinding {
  return {
    candidateProfileId: requireIdentifier(
      input?.candidateProfileId,
      'candidate profile ID',
    ),
    ownerUserId: requireIdentifier(input?.ownerUserId, 'owner user ID'),
    tenantId: requireIdentifier(input?.tenantId, 'tenant ID'),
  };
}

function quotedIdentifier(value: string): string {
  // The table manifest is application-owned. Keep this check anyway so this
  // module cannot become an identifier-injection primitive when reused.
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error('Workspace ownership table name is invalid.');
  }
  return `"${value}"`;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function isExpectedOrEmpty(value: unknown, expected: string): boolean {
  return isEmpty(value) || value === expected;
}

/**
 * A partially written owner tuple is not legacy-unbound data. It may be a
 * failed earlier migration or another owner's record, so require every field
 * to be either empty together or the verified canonical value together.
 */
function isUnboundOrFullyExpected(
  values: readonly unknown[],
  expected: readonly string[],
): boolean {
  return (
    values.every(isEmpty) ||
    values.every((value, index) => value === expected[index])
  );
}

async function tableColumns(
  database: WorkspaceOwnershipDatabase,
  dialect: WorkspaceOwnershipDialect,
  table: string,
): Promise<Set<string>> {
  if (dialect === 'sqlite') {
    const result = await database.query(
      `PRAGMA table_info(${quotedIdentifier(table)})`,
    );
    return new Set(rows(result).map((row) => String(row.name ?? '')));
  }
  const result = await database.query(
    `SELECT a.attname AS column_name
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass(?)
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    [table],
  );
  return new Set(rows(result).map((row) => String(row.column_name ?? '')));
}

function requiredColumns(table: string): string[] {
  return table === 'candidate_profiles'
    ? ['id', 'tenant_id', 'owner_user_id']
    : ['id', 'tenant_id', 'owner_user_id', 'candidate_profile_id'];
}

async function inspectTable(
  database: WorkspaceOwnershipDatabase,
  dialect: WorkspaceOwnershipDialect,
  table: string,
  binding: WorkspaceOwnershipBinding,
): Promise<{
  plan: WorkspaceOwnershipTablePlan;
  updateIds: string[];
  digestRows: unknown[];
  profileRows: string[];
}> {
  const columns = await tableColumns(database, dialect, table);
  const missingColumns = requiredColumns(table).filter(
    (column) => !columns.has(column),
  );
  if (missingColumns.length > 0) {
    return {
      digestRows: [{ missingColumns, table }],
      plan: {
        alreadyBound: 0,
        conflicts: 0,
        missingColumns,
        rows: 0,
        table,
        toBind: 0,
      },
      profileRows: [],
      updateIds: [],
    };
  }
  const selectedColumns =
    table === 'candidate_profiles'
      ? 'CAST(id AS TEXT) AS "id", tenant_id AS "tenantId", owner_user_id AS "ownerUserId"'
      : 'CAST(id AS TEXT) AS "id", tenant_id AS "tenantId", owner_user_id AS "ownerUserId", candidate_profile_id AS "candidateProfileId"';
  const result = await database.query(
    `SELECT ${selectedColumns} FROM ${quotedIdentifier(table)} ORDER BY CAST(id AS TEXT) ASC`,
  );
  const found = rows(result) as unknown as ScopedRow[];
  let alreadyBound = 0;
  let conflicts = 0;
  const updateIds: string[] = [];
  const digestRows: unknown[] = [];
  for (const row of found) {
    const id = String(row.id ?? '');
    const profileMatches =
      table === 'candidate_profiles'
        ? id === binding.candidateProfileId
        : isExpectedOrEmpty(row.candidateProfileId, binding.candidateProfileId);
    const ownershipValues =
      table === 'candidate_profiles'
        ? [row.tenantId, row.ownerUserId]
        : [row.tenantId, row.ownerUserId, row.candidateProfileId];
    const expectedOwnershipValues =
      table === 'candidate_profiles'
        ? [binding.tenantId, binding.ownerUserId]
        : [binding.tenantId, binding.ownerUserId, binding.candidateProfileId];
    const compatible =
      Boolean(id) &&
      profileMatches &&
      isUnboundOrFullyExpected(ownershipValues, expectedOwnershipValues);
    const complete =
      compatible &&
      row.tenantId === binding.tenantId &&
      row.ownerUserId === binding.ownerUserId &&
      (table === 'candidate_profiles' ||
        row.candidateProfileId === binding.candidateProfileId);
    digestRows.push({
      candidateProfileId:
        table === 'candidate_profiles' ? undefined : row.candidateProfileId,
      id,
      ownerUserId: row.ownerUserId,
      table,
      tenantId: row.tenantId,
    });
    const blankMixedLedgerRow =
      workspaceOwnershipMixedLedgerTables.has(table) &&
      ownershipValues.every(isEmpty);
    if (blankMixedLedgerRow) {
      alreadyBound += 1;
      continue;
    }
    if (!compatible) {
      conflicts += 1;
    } else if (complete) {
      alreadyBound += 1;
    } else {
      updateIds.push(id);
    }
  }
  return {
    digestRows,
    plan: {
      alreadyBound,
      conflicts,
      missingColumns: [],
      rows: found.length,
      table,
      toBind: updateIds.length,
    },
    profileRows:
      table === 'candidate_profiles'
        ? found.map((row) => String(row.id ?? ''))
        : [],
    updateIds,
  };
}

/**
 * Inspect a legacy private installation before enabling shared ownership.
 * Historical foreign keys are intentionally never read or rewritten here: the
 * migration only binds a verified owner tuple to records it can prove belong
 * to that one owner.
 */
export async function planWorkspaceOwnershipBackfill(
  database: WorkspaceOwnershipDatabase,
  options: WorkspaceOwnershipBackfillOptions,
): Promise<WorkspaceOwnershipBackfillPlan> {
  assertWorkspaceOwnershipTableMappings();
  const binding = requireWorkspaceOwnershipBinding(options.binding);
  const tables = options.tables ?? workspaceOwnershipTables;
  const inspected = await Promise.all(
    tables.map((table) =>
      inspectTable(database, options.dialect, table, binding),
    ),
  );
  const profileRows =
    inspected[tables.indexOf('candidate_profiles')]?.profileRows ?? [];
  const profileCardinalityValid =
    profileRows.length === 1 && profileRows[0] === binding.candidateProfileId;
  const tablePlans = inspected.map((result) => result.plan);
  const eligible =
    profileCardinalityValid &&
    tablePlans.every(
      (table) => table.conflicts === 0 && table.missingColumns.length === 0,
    );
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        binding,
        profileCardinalityValid,
        rows: inspected.flatMap((result) => result.digestRows),
      }),
    )
    .digest('hex');
  return {
    digest,
    eligible,
    profileCardinalityValid,
    tables: tablePlans,
    updates: new Map(
      tablePlans.map((table, index) => [
        table.table,
        inspected[index]?.updateIds ?? [],
      ]),
    ),
  };
}

/** Apply only a previously reviewed plan, and re-plan inside one transaction. */
export async function applyWorkspaceOwnershipBackfill(
  database: WorkspaceOwnershipDatabase,
  options: WorkspaceOwnershipBackfillOptions & { expectedDigest: string },
): Promise<WorkspaceOwnershipBackfillPlan> {
  if (!database.transaction) {
    throw new Error(
      'Workspace ownership backfill requires transactional storage.',
    );
  }
  if (!options.expectedDigest) {
    throw new Error('A reviewed workspace ownership plan digest is required.');
  }
  return await database.transaction(async (transaction) => {
    const plan = await planWorkspaceOwnershipBackfill(transaction, options);
    if (!plan.eligible) {
      throw new Error(
        'Workspace ownership plan has schema gaps, conflicts, or ambiguous profiles.',
      );
    }
    if (plan.digest !== options.expectedDigest) {
      throw new Error('Workspace ownership plan changed; run a new dry run.');
    }
    const binding = requireWorkspaceOwnershipBinding(options.binding);
    for (const [table, ids] of plan.updates) {
      const profile = table !== 'candidate_profiles';
      const assignments = profile
        ? 'tenant_id = ?, owner_user_id = ?, candidate_profile_id = ?'
        : 'tenant_id = ?, owner_user_id = ?';
      const values = profile
        ? [binding.tenantId, binding.ownerUserId, binding.candidateProfileId]
        : [binding.tenantId, binding.ownerUserId];
      for (const id of ids) {
        // Keep the primary-key lookup native: PostgreSQL infers a UUID or text
        // parameter from the column and can use its PK index. Planning still
        // casts IDs to text only when constructing its canonical digest.
        const result = await transaction.query(
          `UPDATE ${quotedIdentifier(table)}
              SET ${assignments}
            WHERE id = ?
              AND (tenant_id IS NULL OR tenant_id = '' OR tenant_id = ?)
              AND (owner_user_id IS NULL OR owner_user_id = '' OR owner_user_id = ?)
              ${profile ? "AND (candidate_profile_id IS NULL OR candidate_profile_id = '' OR candidate_profile_id = ?)" : ''}
          RETURNING id`,
          profile
            ? [
                ...values,
                id,
                binding.tenantId,
                binding.ownerUserId,
                binding.candidateProfileId,
              ]
            : [...values, id, binding.tenantId, binding.ownerUserId],
        );
        if (rows(result).length !== 1) {
          throw new Error(
            'Workspace ownership compare-and-set failed; no partial backfill was retained.',
          );
        }
      }
    }
    return plan;
  });
}
