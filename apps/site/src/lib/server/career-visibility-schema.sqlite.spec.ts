import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../objects/index.js';

const tables = [
  'achievements',
  'candidate_profile_links',
  'candidate_profiles',
  'duties',
  'education',
  'experiences',
  'projects',
  'resume_other_roles',
  'skill_categories',
  'skill_groups',
];

describe('career visibility native SQLite schema', () => {
  let directory = '';
  let database: DatabaseInterface;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-career-visibility-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'career.sqlite'),
    });
    const ddl = getDDLStrategy('sqlite');
    const definitions = ObjectRegistry.getAllSchemasAsDefinitions();
    for (const tableName of tables) {
      const definition = Object.values(definitions).find(
        (item) => item.tableName === tableName,
      );
      if (!definition) throw new Error(`Missing ${tableName} schema.`);
      await database.query(ddl.generateCreateTable(definition));
    }
  });

  afterEach(async () => {
    await database?.close?.();
    await rm(directory, { force: true, recursive: true });
  });

  it('creates native visibility columns for every career card source', async () => {
    for (const tableName of tables) {
      const result = await database.query(`PRAGMA table_info(${tableName})`);
      const visibility = result.rows.find(
        (column) => column.name === 'use_on_resume',
      );
      expect(visibility, tableName).toBeDefined();
    }
  });

  it('persists a profile visibility change without rewriting the source fields', async () => {
    await database.query(
      "INSERT INTO candidate_profiles (id, slug, tenant_id, owner_user_id, name, summary, use_on_resume) VALUES ('visibility-profile', 'visibility-profile', 'tenant', 'owner', 'Fictional Candidate', 'Fictional summary', true)",
    );
    await database.query(
      "UPDATE candidate_profiles SET use_on_resume = false WHERE id = 'visibility-profile'",
    );
    const result = await database.query(
      "SELECT name, summary, use_on_resume FROM candidate_profiles WHERE id = 'visibility-profile'",
    );
    expect(result.rows).toEqual([
      {
        name: 'Fictional Candidate',
        summary: 'Fictional summary',
        use_on_resume: 0,
      },
    ]);
  });
});
