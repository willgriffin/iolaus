import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';

/** Empty isolated raw schema for matching tests. Call the same schema
 * installer used by db:migrate after seeding pre-migration records. */
export async function createMatchingProjectionFixture(
  dialect: 'sqlite' | 'postgres',
  postgresUrl?: string,
): Promise<{ database: DatabaseInterface; close: () => Promise<void> }> {
  let control: DatabaseInterface | undefined;
  let database: DatabaseInterface | undefined;
  const schema = `matching_revision_test_${randomUUID().replaceAll('-', '')}`;
  let createdSchema = false;
  const close = async () => {
    await database?.close?.();
    if (control) {
      if (createdSchema) await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.close?.();
    }
  };
  try {
    if (dialect === 'postgres') {
      if (!postgresUrl) throw new Error('Supply a local PostgreSQL test URL.');
      const url = new URL(postgresUrl);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error(
          'Matching revision tests require a local PostgreSQL test URL.',
        );
      }
      control = await getDatabase({
        type: 'postgres',
        url: url.toString(),
        cache: false,
      });
      await control.query(`CREATE SCHEMA ${schema}`);
      createdSchema = true;
      // No fallback to shared schema: fixture writes can only use synthetic tables.
      url.searchParams.set('options', `-c search_path=${schema}`);
      database = await getDatabase({
        type: 'postgres',
        url: url.toString(),
        cache: false,
      });
    } else {
      database = await getDatabase({
        type: 'sqlite',
        url: ':memory:',
        cache: false,
      });
    }
    const id = dialect === 'postgres' ? 'UUID' : 'TEXT';
    const timestamp = dialect === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT';
    const owner =
      'tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT';
    for (const [name, columns] of Object.entries({
      opportunities: `id ${id} PRIMARY KEY, title TEXT, description_raw TEXT,
        locations TEXT, location_notes TEXT, work_mode TEXT, source_id TEXT, status TEXT, expires_at ${timestamp},
        source_content_json TEXT, source_content_version INTEGER, source_content_fingerprint TEXT, updated_at TEXT`,
      sources: 'id TEXT PRIMARY KEY, public_listing BOOLEAN, is_active BOOLEAN',
      candidate_profiles: `id ${id} PRIMARY KEY, active BOOLEAN, tenant_id TEXT, owner_user_id TEXT,
        preferences_json TEXT, facts_json TEXT, target_work_country_json TEXT`,
      resume_skills: `id TEXT PRIMARY KEY, ${owner}, label TEXT`,
      resume_positions: `id TEXT PRIMARY KEY, ${owner}, position_id TEXT, role TEXT, company TEXT, blurb TEXT, start TEXT, end_label TEXT`,
      resume_achievements: `id TEXT PRIMARY KEY, ${owner}, position_id TEXT, title TEXT, body TEXT, metric TEXT`,
      experiences: `id TEXT PRIMARY KEY, ${owner}, summary TEXT, use_on_resume BOOLEAN`,
      projects: `id TEXT PRIMARY KEY, ${owner}, experience_id TEXT, name TEXT, summary TEXT, use_on_resume BOOLEAN`,
      achievements: `id TEXT PRIMARY KEY, ${owner}, experience_id TEXT, project_id TEXT, title TEXT, body TEXT, metric TEXT, use_on_resume BOOLEAN`,
      duties: `id TEXT PRIMARY KEY, ${owner}, experience_id TEXT, project_id TEXT, title TEXT, body TEXT, use_on_resume BOOLEAN`,
      preference_rules: `id TEXT PRIMARY KEY, ${owner}, category TEXT, active BOOLEAN,
        name TEXT, description TEXT, is_hard_filter BOOLEAN, rule_json TEXT, updated_at TEXT`,
      memberships: 'tenant_id TEXT, user_id TEXT, status TEXT, role_id TEXT',
      users: 'id TEXT PRIMARY KEY, status TEXT',
      tenants: 'id TEXT PRIMARY KEY, status TEXT',
      skill_terms:
        'skill_slug TEXT PRIMARY KEY, label TEXT, aliases_json TEXT, parent_slug TEXT, related_json TEXT, status TEXT, occurrence_count INTEGER',
    }))
      await database.query(`CREATE TABLE ${name} (${columns})`);
    return { database, close };
  } catch (cause) {
    await close();
    throw cause;
  }
}
