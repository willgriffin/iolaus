import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSchemaDiff,
  getSQLFromDiff,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './smrt.js';

describe('opportunity recommendation rank native schema', () => {
  let database: DatabaseInterface;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-rank-native-schema-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'recommendation-ranks.sqlite'),
    });
  });

  afterEach(async () => {
    await database.close?.();
    await rm(directory, { force: true, recursive: true });
  });

  it('renders one private tuple row with lookup and ordering indexes for SQLite and PostgreSQL', async () => {
    const schema = Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions(),
    ).find(
      (candidate) => candidate.tableName === 'opportunity_recommendation_ranks',
    );
    if (!schema)
      throw new Error('OpportunityRecommendationRank was not registered.');

    const sqlite = getDDLStrategy('sqlite');
    const postgres = getDDLStrategy('postgres');
    const sqliteStatements = [
      sqlite.generateCreateTable(schema),
      ...sqlite.generateIndexes(schema),
      ...sqlite.generateTriggers(schema),
    ];
    const postgresStatements = [
      postgres.generateCreateTable(schema),
      ...postgres.generateIndexes(schema),
      ...postgres.generateTriggers(schema),
    ];
    expect(sqliteStatements.join('\n')).toContain(
      'opportunity_recommendation_ranks_current_lookup',
    );
    expect(postgresStatements.join('\n')).toContain(
      'opportunity_recommendation_ranks_recommendation_order',
    );
    for (const statement of sqliteStatements) await database.query(statement);

    const table = await database.getTableSchema?.(
      'opportunity_recommendation_ranks',
    );
    expect(Object.keys(table?.columns ?? {})).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'owner_user_id',
        'candidate_profile_id',
        'required_skills_snapshot',
        'preferred_skills_snapshot',
        'opportunity_id',
        'recommendation_percent',
        'evidence_coverage_percent',
        'proof_finished_at',
      ]),
    );
    const indexes = await database.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
      ['opportunity_recommendation_ranks'],
    );
    expect(indexes.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'opportunity_recommendation_ranks_current_lookup',
        'opportunity_recommendation_ranks_recommendation_order',
      ]),
    );
  });

  it('adds v2 raw-skill snapshots to a populated v1 row without replacing it', async () => {
    const schema = Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions(),
    ).find(
      (candidate) => candidate.tableName === 'opportunity_recommendation_ranks',
    );
    if (!schema)
      throw new Error('OpportunityRecommendationRank was not registered.');
    const ddl = getDDLStrategy('sqlite');
    const v1Create = ddl
      .generateCreateTable(schema)
      .split('\n')
      .filter(
        (line) =>
          !line.includes('required_skills_snapshot') &&
          !line.includes('preferred_skills_snapshot'),
      )
      .join('\n');
    await database.query(v1Create);
    await database.query(
      `INSERT INTO opportunity_recommendation_ranks (
        id, slug, context, tenant_id, owner_user_id, candidate_profile_id,
        opportunity_id, must_have_conflict_count, assessment_completeness,
        source_content_fingerprint, source_content_version,
        candidate_material_fingerprint, question_set_fingerprint,
        contract_version, model, projection_version, assessment_id,
        intelligence_request_id, intelligence_result_id, agent_run_id,
        assessment_fingerprint, proof_finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        '11111111-1111-4111-8111-111111111111',
        'rank',
        '',
        'tenant',
        'user',
        'profile',
        'opportunity',
        0,
        'full',
        'source',
        1,
        'candidate',
        'questions',
        'opportunity-question-screening/v8-named-capability-evidence',
        'jev-1.13.0',
        'opportunity-recommendation-rank/v1',
        'assessment',
        'request',
        'result',
        'run',
        'fingerprint',
        '2026-10-05T10:00:00.000Z',
      ],
    );
    const diff = await generateSchemaDiff(database, {
      [schema.tableName]: schema,
    });
    const statements = getSQLFromDiff(diff);
    expect(statements.join('\n')).toContain('required_skills_snapshot');
    expect(statements.join('\n')).toContain('preferred_skills_snapshot');
    for (const statement of statements) await database.query(statement);
    const row = await database.query(
      'SELECT projection_version, required_skills_snapshot, preferred_skills_snapshot FROM opportunity_recommendation_ranks WHERE id = ?',
      ['11111111-1111-4111-8111-111111111111'],
    );
    expect(row.rows).toEqual([
      expect.objectContaining({
        projection_version: 'opportunity-recommendation-rank/v1',
        required_skills_snapshot: '',
        preferred_skills_snapshot: '',
      }),
    ]);
  });
});
