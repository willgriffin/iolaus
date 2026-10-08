import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureOpportunityAnalysisSchema } from './opportunity-analysis-schema.js';
import { deterministicOpportunityAnalysis } from './opportunity-analysis-source.js';
import {
  type AnalysisDatabase,
  publishOpportunityAnalysis,
  readCurrentAnalysis,
} from './opportunity-analysis-store.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const pg = process.env.ANALYSIS_TEST_POSTGRES_URL;
for (const dialect of ['sqlite', ...(pg ? ['postgres'] : [])] as const) {
  describe(`atomic analysis ${dialect}`, () => {
    let db: AnalysisDatabase,
      other: AnalysisDatabase,
      directory = '';
    const source = {
      title: 'Senior TypeScript Engineer',
      descriptionRaw:
        'TypeScript is required. At least 5 years of experience required.',
      requiredSkills: 'TypeScript',
      currency: 'USD',
      salaryMin: 100000,
    };
    let identity: {
      id: string;
      sourceContentJson: string;
      sourceContentFingerprint: string;
      sourceContentVersion: number;
    };
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'analysis-store-'));
      const config =
        dialect === 'sqlite'
          ? {
              type: 'sqlite' as const,
              url: `file:${join(directory, 'test.db')}`,
              cache: false,
            }
          : { type: 'postgres' as const, url: pg ?? '', cache: false };
      db = await getDatabase(config);
      other = await getDatabase(config);
      for (const table of [
        'opportunity_skills',
        'opportunity_analyses',
        'opportunities',
        'sources',
        'companies',
        'skill_terms',
      ])
        await db.query(
          `DROP TABLE IF EXISTS ${table}${dialect === 'postgres' ? ' CASCADE' : ''}`,
        );
      const id = dialect === 'postgres' ? 'UUID' : 'TEXT';
      await db.query(
        `CREATE TABLE opportunities(id ${id} PRIMARY KEY, source_content_json TEXT, source_content_fingerprint TEXT,source_content_version INTEGER,current_analysis_id ${id}, source_id TEXT DEFAULT 'source', company_id TEXT DEFAULT '', posting_url TEXT DEFAULT 'https://example.com/job', canonical_url TEXT DEFAULT '', apply_url TEXT DEFAULT '', title TEXT DEFAULT 'PRIVATE OVERLAY', locations TEXT DEFAULT 'PRIVATE LOCATION', posted_at ${dialect === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT'}, expires_at ${dialect === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT'}, updated_at TEXT, status TEXT DEFAULT 'active', freshness TEXT DEFAULT 'fresh')`,
      );
      const textCols = [
        'slug',
        'context',
        'created_at',
        'updated_at',
        'source_content_fingerprint',
        'source_content_digest',
        'analysis_version',
        'status',
        'normalized_title',
        'seniority',
        'function',
        'work_mode',
        'employment_type',
        'skills_json',
        'requirements_json',
        'eligibility_json',
        'compensation_json',
        'summary_json',
        'countries_json',
        'skill_slugs_json',
        'model',
        'prompt_version',
        'output_schema_version',
        'request_id',
        'error_code',
      ];
      await db.query(
        `CREATE TABLE opportunity_analyses(id ${id} PRIMARY KEY,opportunity_id ${id} REFERENCES opportunities(id),${textCols.map((x) => `${x} TEXT`).join(',')},source_content_version INTEGER,input_tokens INTEGER,output_tokens INTEGER,cost_micros INTEGER)`,
      );
      await db.query(
        `CREATE TABLE opportunity_skills(id ${id} PRIMARY KEY,slug TEXT,context TEXT,created_at TEXT,updated_at TEXT,opportunity_id ${id},analysis_id ${id} REFERENCES opportunity_analyses(id),skill_slug TEXT CHECK(skill_slug != 'invalid'),kind TEXT,confidence REAL,UNIQUE(analysis_id,skill_slug,kind))`,
      );
      await db.query(
        'CREATE TABLE sources(id TEXT PRIMARY KEY, public_listing BOOLEAN, is_active BOOLEAN)',
      );
      await db.query('INSERT INTO sources VALUES(?,?,?)', [
        'source',
        true,
        true,
      ]);
      await db.query(`CREATE TABLE companies(id ${id} PRIMARY KEY, name TEXT)`);
      await db.query(
        'CREATE TABLE skill_terms(id TEXT PRIMARY KEY,skill_slug TEXT)',
      );
      await ensureOpportunityAnalysisSchema(db);
      identity = {
        id: randomUUID(),
        sourceContentJson: JSON.stringify(source),
        sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
        sourceContentVersion: 1,
      };
      await db.query(
        'INSERT INTO opportunities(id,source_content_json,source_content_fingerprint,source_content_version) VALUES(?,?,?,?)',
        [
          identity.id,
          identity.sourceContentJson,
          identity.sourceContentFingerprint,
          1,
        ],
      );
    });
    afterEach(async () => {
      await db.close?.();
      await other.close?.();
      await rm(directory, { recursive: true, force: true });
    });
    it('publishes coherent artifact and junctions, and retries without duplication', async () => {
      const snapshot = deterministicOpportunityAnalysis(identity);
      const first = await publishOpportunityAnalysis(db, identity, snapshot);
      expect(
        (await publishOpportunityAnalysis(other, identity, snapshot)).id,
      ).toBe(first.id);
      expect((await readCurrentAnalysis(db, identity.id))?.id).toBe(first.id);
      expect(
        (await db.query('SELECT * FROM opportunity_skills')).rows,
      ).toHaveLength(1);
    });
    it('rolls back artifact, junctions and pointer on partial skill failure', async () => {
      const snapshot = deterministicOpportunityAnalysis(identity);
      snapshot.skills.push({ ...snapshot.skills[0], slug: 'invalid' });
      await expect(
        publishOpportunityAnalysis(db, identity, snapshot),
      ).rejects.toThrow();
      expect(
        (await db.query('SELECT * FROM opportunity_analyses')).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('SELECT * FROM opportunity_skills')).rows,
      ).toHaveLength(0);
      expect(await readCurrentAnalysis(db, identity.id)).toBeNull();
    });
    it('refuses obsolete workers and version-mismatched current pointers', async () => {
      const old = await publishOpportunityAnalysis(
        db,
        identity,
        deterministicOpportunityAnalysis(identity),
      );
      await db.query(
        'UPDATE opportunities SET source_content_version=2 WHERE id=?',
        [identity.id],
      );
      expect(await readCurrentAnalysis(db, identity.id)).toBeNull();
      await expect(
        publishOpportunityAnalysis(other, identity, {
          ...old,
          status: 'enriched',
        }),
      ).rejects.toThrow('Stale');
      const latest = { ...identity, sourceContentVersion: 2 };
      expect(
        (
          await publishOpportunityAnalysis(
            db,
            latest,
            deterministicOpportunityAnalysis(latest),
          )
        ).id,
      ).not.toBe(old.id);
    });
    it('invalidates exact raw-source changes and projects no human overlay or evidence spans', async () => {
      await publishOpportunityAnalysis(
        db,
        identity,
        deterministicOpportunityAnalysis(identity),
      );
      const projected = (
        await db.query('SELECT * FROM jobgeni_public_catalog_v1')
      ).rows[0];
      expect(projected.title).toBe(source.title);
      expect(projected.locations).toBe('');
      expect(JSON.stringify(projected)).not.toContain('PRIVATE');
      expect(String(projected.requirements_json)).not.toContain('evidence');
      expect(String(projected.skills_json)).not.toContain('evidence');
      const edited = {
        ...source,
        descriptionRaw: `  ${source.descriptionRaw}`,
      };
      await db.query(
        'UPDATE opportunities SET source_content_json=? WHERE id=?',
        [JSON.stringify(edited), identity.id],
      );
      expect(await readCurrentAnalysis(db, identity.id)).toBeNull();
      expect(
        (await db.query('SELECT * FROM jobgeni_public_catalog_v1')).rows,
      ).toHaveLength(0);
      const next = { ...identity, sourceContentJson: JSON.stringify(edited) };
      const published = await publishOpportunityAnalysis(
        db,
        next,
        deterministicOpportunityAnalysis(next),
      );
      expect(published.skills[0].evidence[0].start).toBe(2);
    });
    it('does not downgrade an enriched current artifact during a deterministic retry', async () => {
      const snapshot = deterministicOpportunityAnalysis(identity);
      const enriched = await publishOpportunityAnalysis(
        db,
        identity,
        { ...snapshot, status: 'enriched' },
        {
          model: 'openai/gpt-6-luna',
          promptVersion: 'v1',
          outputSchemaVersion: 'v1',
          requestId: 'r',
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 1,
        },
      );
      expect(
        (await publishOpportunityAnalysis(other, identity, snapshot)).id,
      ).toBe(enriched.id);
    });
    it('serializes concurrent workers from separate database connections', async () => {
      const snapshot = deterministicOpportunityAnalysis(identity);
      const results = await Promise.all([
        publishOpportunityAnalysis(db, identity, snapshot),
        publishOpportunityAnalysis(other, identity, snapshot),
      ]);
      expect(results[0].id).toBe(results[1].id);
      expect(
        (await db.query('SELECT * FROM opportunity_analyses')).rows,
      ).toHaveLength(1);
    });
  });
}
