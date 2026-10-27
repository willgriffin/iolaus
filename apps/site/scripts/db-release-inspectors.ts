import { matchesGlob } from 'node:path';
import {
  normalizeOperationPermissionAction,
  PermissionCatalogService,
} from '@happyvertical/smrt-users';
import type {
  DeploymentReconciliation,
  DeploymentStepTransaction,
} from '@happyvertical/smrt-core/migrations';
import { iolausRolePermissionMatrix } from '../src/lib/server/role-permissions.js';
import {
  SKILL_VOCABULARY_SEED_TERMS,
  canonicalSkillSlug,
} from '../src/lib/server/skill-vocabulary.js';
import { OPPORTUNITY_INTELLIGENCE_CONTROL_KEY } from '../src/lib/server/opportunity-intelligence-governance.js';
import { getCollection } from '../src/lib/server/smrt.js';
import {
  buildSourceSchedule,
  SOURCE_JOB_OBJECT_TYPE,
  SOURCE_CRAWL_TIMEOUT_MS,
} from '../src/lib/server/source-schedules.js';
import { smrtNativeBackfillVersion } from './db-common.js';

const outcome = (
  ready: boolean,
  reason?: string,
): DeploymentReconciliation => ({
  outcome: ready ? 'complete' : 'safe-to-resume',
  ...(reason && !ready ? { checkpoint: { reason } } : {}),
});

/** Import verified historical completion, or refuse ambiguous legacy effects. */
export async function inspectLegacyNativeBackfill(
  connection: DeploymentStepTransaction,
): Promise<DeploymentReconciliation> {
  const marker = await connection.query(
    'SELECT 1 FROM _smrt_migrations WHERE version = ?',
    smrtNativeBackfillVersion,
  );
  if (marker.rows.length) return { outcome: 'complete' };
  for (const table of [
    'companies',
    'people',
    'opportunities',
    'sources',
    'tasks',
    'decisions',
  ]) {
    const rows = await connection.query(`SELECT 1 FROM "${table}" LIMIT 1`);
    if (rows.rows.length)
      return {
        outcome: 'needs-repair',
        checkpoint: { reason: 'legacy-native-effects-ambiguous', table },
      };
  }
  // No input rows means there were no reachable import effects. Never call
  // backfillSmrtNative or enable the permanently disabled personal imports.
  return { outcome: 'complete', checkpoint: { reason: 'empty-legacy-input' } };
}

/** Inspect canonical records independently of the pooled seeder's return.
 * The released seeder is additive (prune:false). Operator-added grants remain
 * intentional; readiness requires the complete expected subset, never revokes.
 */
export function requiredRoleGrants(
  catalogSlugs: readonly string[],
  patterns: readonly string[],
): Set<string> {
  const normalized = patterns.map((pattern) => {
    const parts = pattern.trim().split('.');
    return parts.length === 2
      ? `${parts[0]}.${normalizeOperationPermissionAction(parts[1])}`
      : pattern.trim();
  });
  return new Set(
    catalogSlugs.filter(
      (slug) =>
        normalized.some((pattern) => matchesGlob(slug, pattern)) ||
        [
          'fields.policy.personalize',
          'overviews.personalize',
          'shell.personalize',
        ].includes(slug),
    ),
  );
}

export function containsRequiredRoleGrants(
  actual: readonly string[],
  expected: ReadonlySet<string>,
): boolean {
  const granted = new Set(actual);
  return [...expected].every((slug) => granted.has(slug));
}

export async function inspectCanonicalSeeds(
  connection: DeploymentStepTransaction,
): Promise<DeploymentReconciliation> {
  const catalog = PermissionCatalogService.create({}).getCatalog();
  const permissions = await connection.query('SELECT slug FROM permissions');
  const presentPermissions = new Set(permissions.rows.map((row) => row.slug));
  if (
    catalog.permissions.some(
      (permission) => !presentPermissions.has(permission.slug),
    )
  )
    return outcome(false, 'canonical-permission-catalog');
  for (const [slug, patterns] of Object.entries(iolausRolePermissionMatrix)) {
    const roles = await connection.query(
      'SELECT id FROM roles WHERE slug = ? AND tenant_id IS NULL AND is_system = TRUE',
      slug,
    );
    if (roles.rows.length > 1)
      return {
        outcome: 'needs-repair',
        checkpoint: { reason: 'duplicate-system-role', slug },
      };
    if (!roles.rows.length) return outcome(false, `system-role:${slug}`);
    const grants = await connection.query(
      'SELECT p.slug FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?',
      roles.rows[0].id,
    );
    const expected = requiredRoleGrants(
      catalog.permissions.map((permission) => permission.slug),
      patterns,
    );
    if (
      !containsRequiredRoleGrants(
        grants.rows.map((row) => String(row.slug)),
        expected,
      )
    )
      return outcome(false, `role-grants:${slug}`);
  }
  for (const [table, slugs] of [
    ['profile_types', ['person', 'organization', 'agent']],
    [
      'profile_relationship_types',
      [
        'works_at',
        'founder_of',
        'recruiter_for',
        'hiring_manager_at',
        'contact_for',
      ],
    ],
    ['place_types', ['country', 'region', 'city', 'metro', 'remote_region']],
  ] as const) {
    const rows = await connection.query(
      `SELECT slug FROM ${table} WHERE context = ''`,
    );
    const present = new Set(rows.rows.map((row) => row.slug));
    if (slugs.some((slug) => !present.has(slug)))
      return outcome(false, `canonical-types:${table}`);
  }
  const tags = await connection.query('SELECT slug, context FROM tags');
  if (
    [
      'skill',
      'domain',
      'role',
      'industry',
      'decision_reason',
      'preference',
      'source',
      'credential',
    ].some(
      (context) =>
        !tags.rows.some(
          (row) => row.slug === context && row.context === context,
        ),
    )
  )
    return outcome(false, 'tag-contexts');
  const skills = await connection.query(
    'SELECT skill_slug, status FROM skill_terms',
  );
  const skillSlugs = new Set(skills.rows.map((row) => String(row.skill_slug)));
  if (
    SKILL_VOCABULARY_SEED_TERMS.some((seed) => !skillSlugs.has(seed.slug)) ||
    skills.rows.some(
      (row) =>
        row.status === 'seed' &&
        canonicalSkillSlug(String(row.skill_slug)) !== row.skill_slug &&
        skillSlugs.has(canonicalSkillSlug(String(row.skill_slug))),
    )
  )
    return outcome(false, 'skill-vocabulary');
  const control = await connection.query(
    'SELECT 1 FROM opportunity_intelligence_controls WHERE control_key = ?',
    OPPORTUNITY_INTELLIGENCE_CONTROL_KEY,
  );
  return outcome(control.rows.length === 1, 'intelligence-control');
}

/** Compare actual persisted schedules to deterministic source requirements. */
export async function inspectSourceSchedules(
  connection: DeploymentStepTransaction,
): Promise<DeploymentReconciliation> {
  const collection = await getCollection('Source');
  const sources: Parameters<typeof buildSourceSchedule>[0][] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await collection.list({ limit: 500, offset });
    sources.push(
      ...(page as unknown as Parameters<typeof buildSourceSchedule>[0][]),
    );
    if (page.length < 500) break;
  }
  const actual = await connection.query(
    'SELECT slug, agent_id, method, cron, enabled, status, max_concurrent, timeout, timezone FROM _smrt_agent_schedules WHERE agent_type = ?',
    SOURCE_JOB_OBJECT_TYPE,
  );
  const sourceIds = new Set(sources.map((source) => String(source.id)));
  if (actual.rows.some((row) => !sourceIds.has(String(row.agent_id))))
    return outcome(false);
  for (const source of sources) {
    const desired = buildSourceSchedule(source);
    if (!desired) continue;
    const found = actual.rows.find(
      (row) =>
        row.slug === desired.id && String(row.agent_id) === desired.agentId,
    );
    if (
      !found ||
      found.method !== desired.method ||
      found.cron !== (desired.cron ?? '* * * * *') ||
      found.enabled !== desired.enabled ||
      found.status !== (desired.enabled ? 'active' : 'disabled') ||
      Number(found.max_concurrent) !== 1 ||
      Number(found.timeout) !== SOURCE_CRAWL_TIMEOUT_MS ||
      found.timezone !== 'UTC'
    )
      return outcome(false);
  }
  return outcome(true);
}
