import { randomUUID } from 'node:crypto';
import { getFilesystem } from '@happyvertical/files';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDatabaseUrl } from '../src/lib/server/db.js';
import {
  getResumeFilesConfig,
  PUBLISHED_RESUME_PDF_PATH,
} from '../src/lib/server/resume-files.js';
import '../src/lib/server/smrt.js';
import { parseFlagArgs, redactDatabaseUrl } from './db-snapshot.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type CheckLevel = 'fail' | 'warn';

interface DoctorIssue {
  level: CheckLevel;
  message: string;
}

interface UniqueColumnCheck {
  column: string;
  label: string;
  table: string;
}

interface RelationshipCheck {
  childColumn: string;
  childTable: string;
  label: string;
  parentColumn?: string;
  parentTable: string;
}

interface TagIdentityCheck {
  childTable: string;
  label: string;
}

const expectedTables = [
  'candidate_profiles',
  'candidate_profile_links',
  'companies',
  'company_tags',
  'employment_roles',
  'employment_role_tags',
  'experiences',
  'experience_companies',
  'experience_roles',
  'experience_tags',
  'projects',
  'project_tags',
  'duties',
  'duty_tags',
  'achievements',
  'achievement_tags',
  'education',
  'education_tags',
  'attachments',
  'company_attachments',
  'project_attachments',
  'achievement_attachments',
  'resume_assets',
  'resume_tailoring_configs',
  'skill_categories',
  'skill_category_members',
  'skill_groups',
  'skill_group_members',
] as const;

const uniqueColumnChecks: UniqueColumnCheck[] = [
  {
    table: 'candidate_profiles',
    column: 'profile_key',
    label: 'candidate profile key',
  },
  { table: 'companies', column: 'company_key', label: 'company key' },
  { table: 'employment_roles', column: 'role_slug', label: 'role slug' },
  { table: 'experiences', column: 'experience_key', label: 'experience key' },
  { table: 'projects', column: 'project_key', label: 'project key' },
  {
    table: 'skill_categories',
    column: 'category_key',
    label: 'skill category key',
  },
  { table: 'skill_groups', column: 'group_key', label: 'skill group key' },
  {
    table: 'resume_tailoring_configs',
    column: 'config_slug',
    label: 'tailoring config slug',
  },
];

const relationshipChecks: RelationshipCheck[] = [
  {
    childTable: 'candidate_profile_links',
    childColumn: 'profile_key',
    parentTable: 'candidate_profiles',
    parentColumn: 'profile_key',
    label: 'profile links point at candidate profiles',
  },
  {
    childTable: 'experience_companies',
    childColumn: 'experience_id',
    parentTable: 'experiences',
    label: 'experience company joins point at experiences',
  },
  {
    childTable: 'experience_companies',
    childColumn: 'company_id',
    parentTable: 'companies',
    label: 'experience company joins point at companies',
  },
  {
    childTable: 'experience_roles',
    childColumn: 'experience_id',
    parentTable: 'experiences',
    label: 'experience role joins point at experiences',
  },
  {
    childTable: 'experience_roles',
    childColumn: 'role_id',
    parentTable: 'employment_roles',
    label: 'experience role joins point at roles',
  },
  {
    childTable: 'opportunity_roles',
    childColumn: 'role_id',
    parentTable: 'employment_roles',
    label: 'opportunity role joins point at roles',
  },
  {
    childTable: 'projects',
    childColumn: 'experience_id',
    parentTable: 'experiences',
    label: 'projects point at experiences',
  },
  {
    childTable: 'duties',
    childColumn: 'experience_id',
    parentTable: 'experiences',
    label: 'duties point at experiences',
  },
  {
    childTable: 'duties',
    childColumn: 'project_id',
    parentTable: 'projects',
    label: 'project duties point at projects',
  },
  {
    childTable: 'achievements',
    childColumn: 'experience_id',
    parentTable: 'experiences',
    label: 'achievements point at experiences',
  },
  {
    childTable: 'achievements',
    childColumn: 'project_id',
    parentTable: 'projects',
    label: 'project achievements point at projects',
  },
  {
    childTable: 'education',
    childColumn: 'profile_key',
    parentTable: 'candidate_profiles',
    parentColumn: 'profile_key',
    label: 'education points at candidate profiles',
  },
  {
    childTable: 'company_attachments',
    childColumn: 'company_id',
    parentTable: 'companies',
    label: 'company attachment joins point at companies',
  },
  {
    childTable: 'company_attachments',
    childColumn: 'attachment_id',
    parentTable: 'attachments',
    label: 'company attachment joins point at attachments',
  },
  {
    childTable: 'project_attachments',
    childColumn: 'project_id',
    parentTable: 'projects',
    label: 'project attachment joins point at projects',
  },
  {
    childTable: 'project_attachments',
    childColumn: 'attachment_id',
    parentTable: 'attachments',
    label: 'project attachment joins point at attachments',
  },
  {
    childTable: 'achievement_attachments',
    childColumn: 'achievement_id',
    parentTable: 'achievements',
    label: 'achievement attachment joins point at achievements',
  },
  {
    childTable: 'achievement_attachments',
    childColumn: 'attachment_id',
    parentTable: 'attachments',
    label: 'achievement attachment joins point at attachments',
  },
  {
    childTable: 'skill_category_members',
    childColumn: 'category_id',
    parentTable: 'skill_categories',
    label: 'skill category members point at categories',
  },
  {
    childTable: 'skill_group_members',
    childColumn: 'group_id',
    parentTable: 'skill_groups',
    label: 'skill group members point at groups',
  },
];

const tagRelationshipChecks: RelationshipCheck[] = [
  [
    'company_tags',
    'company_id',
    'companies',
    'company tag joins point at companies',
  ],
  [
    'employment_role_tags',
    'role_id',
    'employment_roles',
    'role tag joins point at roles',
  ],
  [
    'experience_tags',
    'experience_id',
    'experiences',
    'experience tag joins point at experiences',
  ],
  [
    'project_tags',
    'project_id',
    'projects',
    'project tag joins point at projects',
  ],
  ['duty_tags', 'duty_id', 'duties', 'duty tag joins point at duties'],
  [
    'achievement_tags',
    'achievement_id',
    'achievements',
    'achievement tag joins point at achievements',
  ],
  [
    'education_tags',
    'education_id',
    'education',
    'education tag joins point at education',
  ],
  [
    'opportunity_tags',
    'opportunity_id',
    'opportunities',
    'opportunity tag joins point at opportunities',
  ],
  [
    'decision_tags',
    'decision_id',
    'decisions',
    'decision tag joins point at decisions',
  ],
  ['source_tags', 'source_id', 'sources', 'source tag joins point at sources'],
].map(([childTable, childColumn, parentTable, label]) => ({
  childColumn,
  childTable,
  label,
  parentTable,
}));

const tagIdentityChecks: TagIdentityCheck[] = [
  { childTable: 'skill_category_members', label: 'skill category members' },
  { childTable: 'skill_group_members', label: 'skill group members' },
  { childTable: 'company_tags', label: 'company tags' },
  { childTable: 'employment_role_tags', label: 'role tags' },
  { childTable: 'experience_tags', label: 'experience tags' },
  { childTable: 'project_tags', label: 'project tags' },
  { childTable: 'duty_tags', label: 'duty tags' },
  { childTable: 'achievement_tags', label: 'achievement tags' },
  { childTable: 'education_tags', label: 'education tags' },
  { childTable: 'opportunity_tags', label: 'opportunity tags' },
  { childTable: 'decision_tags', label: 'decision tags' },
  { childTable: 'source_tags', label: 'source tags' },
];

const { flags } = parseFlagArgs(process.argv.slice(2));
const databaseUrl =
  typeof flags.databaseUrl === 'string' ? flags.databaseUrl : getDatabaseUrl();
const jsonOutput = Boolean(flags.json);

const db = await resolveDatabase(
  { type: 'postgres', url: databaseUrl },
  { dbid: `doctor-${randomUUID()}` },
);
const tables = await listPublicTables(db);
const issues: DoctorIssue[] = [];

for (const table of expectedTables) {
  if (!tables.has(table)) {
    issues.push({
      level: 'warn',
      message: `Missing expected source table: ${table}`,
    });
  }
}

await checkDefaultProfile(db, tables, issues);
for (const check of uniqueColumnChecks)
  await checkUniqueColumn(db, tables, check, issues);
for (const check of [...relationshipChecks, ...tagRelationshipChecks]) {
  await checkRelationship(db, tables, check, issues);
}
for (const check of tagIdentityChecks)
  await checkTagIdentity(db, tables, check, issues);
await checkTailoringJson(db, tables, issues);
await checkResumePublication(db, tables, issues);
await checkAttachmentFiles(db, tables, issues);

const failures = issues.filter((issue) => issue.level === 'fail');
const warnings = issues.filter((issue) => issue.level === 'warn');

if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        database: redactDatabaseUrl(databaseUrl),
        failures: failures.length,
        issues,
        warnings: warnings.length,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Database doctor: ${redactDatabaseUrl(databaseUrl)}`);
  if (issues.length === 0) {
    console.log('No data integrity issues found.');
  } else {
    for (const issue of issues) {
      console.log(`[${issue.level.toUpperCase()}] ${issue.message}`);
    }
  }
  console.log(
    `Summary: ${failures.length} failures, ${warnings.length} warnings`,
  );
}

if (failures.length > 0) {
  process.exitCode = 1;
}

async function listPublicTables(db: SmrtDatabase): Promise<Set<string>> {
  const result = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return new Set(result.rows.map((row) => String(row.tablename ?? '')));
}

async function checkDefaultProfile(
  db: SmrtDatabase,
  tables: Set<string>,
  issues: DoctorIssue[],
): Promise<void> {
  if (!tables.has('candidate_profiles')) return;

  const result = await db.query(
    'SELECT count(*)::int AS count FROM candidate_profiles WHERE is_default = true',
  );
  const defaultCount = Number(result.rows[0]?.count ?? 0);
  if (defaultCount === 0) {
    issues.push({
      level: 'warn',
      message: 'No default candidate profile is selected.',
    });
  } else if (defaultCount > 1) {
    issues.push({
      level: 'fail',
      message: `Expected one default candidate profile, found ${defaultCount}.`,
    });
  }
}

async function checkUniqueColumn(
  db: SmrtDatabase,
  tables: Set<string>,
  check: UniqueColumnCheck,
  issues: DoctorIssue[],
): Promise<void> {
  if (!tables.has(check.table)) return;

  const result = await db.query(`
    SELECT ${quoteIdentifier(check.column)} AS value, count(*)::int AS count
    FROM ${quoteIdentifier(check.table)}
    WHERE NULLIF(trim(${quoteIdentifier(check.column)}::text), '') IS NOT NULL
    GROUP BY ${quoteIdentifier(check.column)}
    HAVING count(*) > 1
    ORDER BY count DESC, ${quoteIdentifier(check.column)}
  `);

  for (const row of result.rows) {
    issues.push({
      level: 'fail',
      message: `Duplicate ${check.label} "${String(row.value)}" in ${check.table} (${Number(
        row.count ?? 0,
      )} rows).`,
    });
  }
}

async function checkRelationship(
  db: SmrtDatabase,
  tables: Set<string>,
  check: RelationshipCheck,
  issues: DoctorIssue[],
): Promise<void> {
  if (!tables.has(check.childTable) || !tables.has(check.parentTable)) return;

  const parentColumn = check.parentColumn ?? 'id';
  const result = await db.query(`
    SELECT count(*)::int AS count
    FROM ${quoteIdentifier(check.childTable)} child
    LEFT JOIN ${quoteIdentifier(check.parentTable)} parent
      -- Cast both sides to text: framework PKs are native uuid post-relationships-v2,
      -- while consumer FK columns may be text (slugs or uuid-as-text). Comparing as
      -- text keeps orphan detection working across the uuid/text boundary.
      ON parent.${quoteIdentifier(parentColumn)}::text = child.${quoteIdentifier(check.childColumn)}::text
    WHERE NULLIF(trim(child.${quoteIdentifier(check.childColumn)}::text), '') IS NOT NULL
      AND parent.${quoteIdentifier(parentColumn)} IS NULL
  `);
  const orphanCount = Number(result.rows[0]?.count ?? 0);
  if (orphanCount > 0) {
    issues.push({
      level: 'fail',
      message: `${check.label}: ${orphanCount} orphaned row${orphanCount === 1 ? '' : 's'}.`,
    });
  }
}

async function checkTagIdentity(
  db: SmrtDatabase,
  tables: Set<string>,
  check: TagIdentityCheck,
  issues: DoctorIssue[],
): Promise<void> {
  if (!tables.has(check.childTable) || !tables.has('tags')) return;

  const missing = await db.query(`
    SELECT count(*)::int AS count
    FROM ${quoteIdentifier(check.childTable)} child
    LEFT JOIN tags tag
      -- tags.id is native uuid (relationships-v2); child.tag_id is text (slug or
      -- uuid-as-text), so compare the id branch as text to avoid uuid = text errors.
      ON tag.id::text = child.tag_id OR tag.slug = child.tag_id
    WHERE NULLIF(trim(child.tag_id::text), '') IS NOT NULL
      AND tag.id IS NULL
  `);
  const missingCount = Number(missing.rows[0]?.count ?? 0);
  if (missingCount > 0) {
    issues.push({
      level: 'fail',
      message: `${check.label} point at missing SMRT tags: ${missingCount} row${
        missingCount === 1 ? '' : 's'
      }.`,
    });
  }

  const slugBacked = await db.query(`
    SELECT count(*)::int AS count
    FROM ${quoteIdentifier(check.childTable)} child
    JOIN tags tag ON tag.slug = child.tag_id
    LEFT JOIN tags id_tag ON id_tag.id::text = child.tag_id
    WHERE NULLIF(trim(child.tag_id::text), '') IS NOT NULL
      AND id_tag.id IS NULL
  `);
  const slugBackedCount = Number(slugBacked.rows[0]?.count ?? 0);
  if (slugBackedCount > 0) {
    issues.push({
      level: 'warn',
      message: `${check.label} still use tag slugs instead of canonical SMRT tag IDs: ${slugBackedCount} row${
        slugBackedCount === 1 ? '' : 's'
      }.`,
    });
  }
}

async function checkTailoringJson(
  db: SmrtDatabase,
  tables: Set<string>,
  issues: DoctorIssue[],
): Promise<void> {
  if (!tables.has('resume_tailoring_configs')) return;

  const result = await db.query(
    'SELECT id, config_slug, config_json FROM resume_tailoring_configs ORDER BY config_slug',
  );
  for (const row of result.rows) {
    try {
      JSON.parse(String(row.config_json ?? '{}'));
    } catch (error) {
      issues.push({
        level: 'fail',
        message: `Tailoring config ${String(row.config_slug || row.id)} has invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
}

async function checkResumePublication(
  db: SmrtDatabase,
  tables: Set<string>,
  issues: DoctorIssue[],
): Promise<void> {
  if (!tables.has('resume_assets')) return;

  const result = await db.query(
    'SELECT id, pdf_path FROM resume_assets WHERE is_published = true ORDER BY published_at DESC NULLS LAST',
  );
  if (result.rows.length === 0) {
    issues.push({
      level: 'warn',
      message: 'No resume asset is currently published.',
    });
    return;
  }
  if (result.rows.length > 1) {
    issues.push({
      level: 'fail',
      message: `Expected one published resume asset, found ${result.rows.length}.`,
    });
  }

  const filesystem = await getFilesystem(getResumeFilesConfig());
  const publishedPdfPath = String(result.rows[0]?.pdf_path ?? '');
  if (publishedPdfPath && !(await filesystem.exists(publishedPdfPath))) {
    issues.push({
      level: 'fail',
      message: `Published resume asset PDF is missing from file storage: ${publishedPdfPath}`,
    });
  }
  if (!(await filesystem.exists(PUBLISHED_RESUME_PDF_PATH))) {
    issues.push({
      level: 'fail',
      message: `Published resume alias is missing from file storage: ${PUBLISHED_RESUME_PDF_PATH}`,
    });
  }
}

async function checkAttachmentFiles(
  db: SmrtDatabase,
  tables: Set<string>,
  issues: DoctorIssue[],
): Promise<void> {
  if (!tables.has('attachments')) return;

  const result = await db.query(
    "SELECT id, file_path FROM attachments WHERE NULLIF(trim(file_path), '') IS NOT NULL ORDER BY sort_order, id LIMIT 1000",
  );
  if (result.rows.length === 0) return;

  const filesystem = await getFilesystem(getResumeFilesConfig());
  for (const row of result.rows) {
    const filePath = String(row.file_path ?? '');
    if (!(await filesystem.exists(filePath))) {
      issues.push({
        level: 'fail',
        message: `Attachment ${String(row.id)} is missing from file storage: ${filePath}`,
      });
    }
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}
