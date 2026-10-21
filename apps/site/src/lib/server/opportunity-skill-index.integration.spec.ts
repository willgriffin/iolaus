import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicOpportunityAnalysis } from './opportunity-analysis-source.js';
import {
  type AnalysisDatabase,
  publishOpportunityAnalysis,
} from './opportunity-analysis-store.js';
import {
  reindexOpportunitySkills,
  skillIndexCoverageHealthy,
} from './opportunity-skill-index.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const postgres = process.env.ANALYSIS_TEST_POSTGRES_URL;
for (const dialect of ['sqlite', ...(postgres ? ['postgres'] : [])] as const) {
  describe(`opportunity skill reindex ${dialect}`, () => {
    let db: AnalysisDatabase;
    let directory = '';
    let schema = '';
    const ids: string[] = [];
    const sourceFor = (id: string, valid = true) => {
      const source = {
        title: 'Senior TypeScript Engineer',
        descriptionRaw:
          'TypeScript is required. At least 5 years of experience required.',
        requiredSkills: 'TypeScript',
      };
      return {
        id,
        sourceContentJson: JSON.stringify(source),
        sourceContentFingerprint: valid
          ? fingerprintOpportunitySourceContent(source)
          : 'invalid',
        sourceContentVersion: 1,
      };
    };
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'skill-index-'));
      const config =
        dialect === 'sqlite'
          ? {
              type: 'sqlite' as const,
              url: `file:${join(directory, 'test.db')}`,
              cache: false,
            }
          : { type: 'postgres' as const, url: postgres ?? '', cache: false };
      db = await getDatabase(config);
      if (dialect === 'postgres') {
        schema = `skill_index_${randomUUID().replaceAll('-', '')}`;
        await db.query(`CREATE SCHEMA ${schema}`);
        await db.query(`SET search_path TO ${schema}`);
      }
      const id = dialect === 'postgres' ? 'UUID' : 'TEXT';
      await db.query(
        `CREATE TABLE sources(id TEXT PRIMARY KEY, public_listing BOOLEAN, is_active BOOLEAN)`,
      );
      await db.query(`CREATE TABLE opportunities(
        id ${id} PRIMARY KEY, source_id TEXT, source_content_json TEXT,
        source_content_fingerprint TEXT, source_content_version INTEGER,
        current_analysis_id ${id}, status TEXT, expires_at ${dialect === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT'})`);
      await db.query(`CREATE TABLE opportunity_analyses(
        id ${id} PRIMARY KEY, opportunity_id ${id}, source_content_fingerprint TEXT,
        source_content_version INTEGER, source_content_digest TEXT, analysis_version TEXT,
        status TEXT, normalized_title TEXT, seniority TEXT, function TEXT, work_mode TEXT,
        employment_type TEXT, skills_json TEXT, requirements_json TEXT, eligibility_json TEXT,
        compensation_json TEXT, summary_json TEXT, countries_json TEXT, skill_slugs_json TEXT,
        model TEXT, prompt_version TEXT, output_schema_version TEXT, request_id TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cost_micros INTEGER, error_code TEXT,
        slug TEXT, context TEXT, created_at TEXT, updated_at TEXT)`);
      await db.query(`CREATE TABLE opportunity_skills(
        id ${id} PRIMARY KEY, slug TEXT, context TEXT, created_at TEXT, updated_at TEXT,
        opportunity_id ${id}, analysis_id ${id}, skill_slug TEXT, kind TEXT, confidence REAL,
        UNIQUE(analysis_id,skill_slug,kind))`);
      await db.query('INSERT INTO sources VALUES (?,?,?)', [
        'public',
        true,
        true,
      ]);
      ids.splice(0, ids.length, ...[randomUUID(), randomUUID()].sort());
      for (const idValue of ids) {
        const identity = sourceFor(idValue);
        await db.query('INSERT INTO opportunities VALUES (?,?,?,?,?,?,?,?)', [
          idValue,
          'public',
          identity.sourceContentJson,
          identity.sourceContentFingerprint,
          1,
          null,
          'active',
          null,
        ]);
      }
    });
    afterEach(async () => {
      if (dialect === 'postgres' && schema) {
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
      }
      await db.close?.();
      await rm(directory, { recursive: true, force: true });
    });
    it('dry-runs without writes, applies atomically, and then becomes idempotent', async () => {
      const dry = await reindexOpportunitySkills(db, { max: 300 });
      expect(dry).toMatchObject({
        mode: 'dry-run',
        scanned: 2,
        missingSkillsets: 2,
        emptyIndexes: 2,
        applied: 0,
      });
      expect(skillIndexCoverageHealthy(dry)).toBe(false);
      expect(
        (await db.query('SELECT * FROM opportunity_analyses')).rows,
      ).toHaveLength(0);
      const applied = await reindexOpportunitySkills(db, {
        max: 300,
        apply: true,
      });
      expect(applied).toMatchObject({ applied: 2, failed: 0 });
      expect(
        (await db.query('SELECT * FROM opportunity_skills')).rows,
      ).toHaveLength(2);
      const repeat = await reindexOpportunitySkills(db, {
        max: 300,
        apply: true,
      });
      expect(repeat).toMatchObject({
        missingSkillsets: 0,
        unchanged: 2,
        applied: 0,
      });
      expect(skillIndexCoverageHealthy(repeat)).toBe(true);
    });
    it('uses an opaque keyset cursor and preserves compatible enriched analysis', async () => {
      const first = await reindexOpportunitySkills(db, { max: 1, apply: true });
      expect(first).toMatchObject({ scanned: 1, truncated: true });
      expect(first.nextCursor).toBeTruthy();
      const second = await reindexOpportunitySkills(db, {
        max: 1,
        cursor: first.nextCursor ?? undefined,
        apply: true,
      });
      expect(second).toMatchObject({
        scanned: 1,
        truncated: false,
        nextCursor: null,
      });
      const firstSource = sourceFor(ids[0]);
      await publishOpportunityAnalysis(
        db,
        firstSource,
        {
          ...deterministicOpportunityAnalysis(firstSource),
          status: 'enriched',
        },
        {
          model: 'test',
          promptVersion: 'test',
          outputSchemaVersion: 'test',
          requestId: '',
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
        },
      );
      const result = await reindexOpportunitySkills(db, {
        max: 300,
        apply: true,
      });
      expect(result.compatibleEnriched).toBe(1);
      await expect(reindexOpportunitySkills(db, { max: 0 })).rejects.toThrow(
        '1..300',
      );
      await expect(
        reindexOpportunitySkills(db, { max: 1, cursor: '?' }),
      ).rejects.toThrow('cursor');
    });
    it('reports a failure with a resumable opaque retry cursor', async () => {
      const bad = sourceFor(ids[0], false);
      await db.query(
        'UPDATE opportunities SET source_content_fingerprint=? WHERE id=?',
        [bad.sourceContentFingerprint, ids[0]],
      );
      const result = await reindexOpportunitySkills(db, {
        max: 300,
        apply: true,
      });
      expect(result).toMatchObject({
        scanned: 1,
        failed: 1,
        truncated: true,
        retryCursor: null,
        nextCursor: null,
      });
      expect(skillIndexCoverageHealthy(result)).toBe(false);
    });
  });
}
