import { createHmac } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../application-runtime.js', () => ({
  applicationRuntime: { profile: 'local' },
  hostedDatabasePoolMax: () => 5,
}));
vi.mock('../db.js', () => ({
  getDbConfig: () => ({ type: 'sqlite', url: ':memory:' }),
}));

import { publicJobPosting } from '../../public-job-posting.js';
import { ensureOpportunityAnalysisSchema } from '../opportunity-analysis-schema.js';
import { deterministicOpportunityAnalysis } from '../opportunity-analysis-source.js';
import { publishOpportunityAnalysis } from '../opportunity-analysis-store.js';
import { fingerprintOpportunitySourceContent } from '../opportunity-source-content.js';
import { createPublicSearchReader, type PublicDatabase } from './index.js';
import { ensurePublicSearchSchema } from './schema.js';

const jobId = (n: number, dialect: string) =>
  dialect === 'postgres'
    ? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    : `job${String(n).padStart(5, '0')}`;
const secret = 'test-secret-stable-at-least-thirty-two-characters';
const pgUrl = process.env.PUBLIC_SEARCH_TEST_DATABASE_URL;
async function fixture(dialect: 'sqlite' | 'postgres') {
  let db: PublicDatabase;
  if (dialect === 'sqlite') {
    const sqlite = new DatabaseSync(':memory:');
    db = {
      query: async (sql, ...values) => {
        const stmt = sqlite.prepare(sql);
        if (!values.length) return stmt.all();
        const bindings = Object.fromEntries(
          values.map((v, i) => [`$${i + 1}`, v]),
        );
        return stmt.all(bindings as never);
      },
    };
    Object.assign(db, {
      url: ':memory:',
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        sqlite.exec('BEGIN');
        try {
          const result = await callback({
            query: async (sql: string, values: unknown[] = []) => ({
              rows: sqlite.prepare(sql).all(...(values as never[])),
            }),
          });
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    });
  } else
    db = (await resolveDatabase({
      type: 'postgres',
      url: pgUrl!,
      max: 1,
    })) as unknown as PublicDatabase;
  if (dialect === 'postgres') {
    const target = new URL(pgUrl!);
    if (
      !['localhost', '127.0.0.1'].includes(target.hostname) ||
      target.pathname !== '/public_search'
    )
      throw new Error('Dedicated local public_search test database required');
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');
  }
  const tables = {
    skill_terms: 'id TEXT PRIMARY KEY,skill_slug TEXT',
    sources: 'id TEXT PRIMARY KEY,public_listing BOOLEAN,is_active BOOLEAN',
    companies: 'id TEXT PRIMARY KEY,name TEXT',
    opportunities:
      'id TEXT PRIMARY KEY,source_id TEXT,company_id TEXT,title TEXT,locations TEXT,posting_url TEXT,canonical_url TEXT,apply_url TEXT,posted_at TEXT,expires_at TEXT,updated_at TEXT,status TEXT,freshness TEXT,salary_min REAL,salary_max REAL,currency TEXT,current_analysis_id TEXT,source_content_fingerprint TEXT,source_content_version INTEGER,human_notes TEXT,source_content_json TEXT',
    opportunity_analyses:
      'id TEXT PRIMARY KEY,opportunity_id TEXT,source_content_fingerprint TEXT,source_content_version INTEGER,analysis_version TEXT,status TEXT,normalized_title TEXT,seniority TEXT,function TEXT,work_mode TEXT,employment_type TEXT,skills_json TEXT,eligibility_json TEXT,compensation_json TEXT,summary_json TEXT,countries_json TEXT,skill_slugs_json TEXT,requirements_json TEXT,source_content_digest TEXT,model TEXT,prompt_version TEXT,output_schema_version TEXT,updated_at TEXT,slug TEXT,context TEXT,created_at TEXT,request_id TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_micros INTEGER,error_code TEXT',
    opportunity_skills:
      'id TEXT,analysis_id TEXT,skill_slug TEXT,kind TEXT,opportunity_id TEXT,slug TEXT,context TEXT,created_at TEXT,updated_at TEXT,confidence REAL',
    users: 'id TEXT PRIMARY KEY, email TEXT',
    opportunity_recommendation_ranks:
      'id TEXT,user_id TEXT,tenant_id TEXT,opportunity_id TEXT,score INTEGER',
    decisions:
      'id TEXT,user_id TEXT,tenant_id TEXT,opportunity_id TEXT,decision TEXT',
    opportunity_assessments:
      'id TEXT,user_id TEXT,tenant_id TEXT,opportunity_id TEXT,assessment TEXT',
    private_workspace_test:
      'user_id TEXT,rank TEXT,decision TEXT,assessment TEXT',
  };
  for (const [name, originalColumns] of Object.entries(tables)) {
    const columns =
      dialect === 'postgres' &&
      ['opportunities', 'opportunity_analyses', 'companies'].includes(name)
        ? originalColumns
            .replace('id TEXT PRIMARY KEY', 'id UUID PRIMARY KEY')
            .replace('opportunity_id TEXT', 'opportunity_id UUID')
            .replace('current_analysis_id TEXT', 'current_analysis_id UUID')
        : originalColumns;
    await db.query(
      `CREATE TABLE ${name}(${dialect === 'postgres' ? columns.replaceAll('expires_at TEXT', 'expires_at TIMESTAMPTZ').replaceAll('posted_at TEXT', 'posted_at TIMESTAMPTZ').replaceAll('updated_at TEXT', 'updated_at TIMESTAMPTZ') : columns})`,
    );
  }
  await ensureOpportunityAnalysisSchema(
    Object.assign(db, {
      url: dialect === 'sqlite' ? 'sqlite::memory:' : pgUrl,
    }) as never,
  );
  await ensurePublicSearchSchema(db, dialect);
  await db.query(`INSERT INTO sources VALUES('source',TRUE,TRUE)`);
  await db.query(
    `INSERT INTO companies VALUES($1,'Acme')`,
    dialect === 'postgres' ? '99999999-0000-4000-8000-000000000000' : 'company',
  );
  async function seed(n: number, start = 0) {
    for (let i = start; i < n; i++) {
      const id = jobId(i, dialect);
      const analysisId =
        dialect === 'postgres'
          ? id.replace('00000000-', '00000001-')
          : `analysis${id}`;
      const skills = JSON.stringify([
        { slug: 'postgresql', label: 'PostgreSQL', kind: 'required' },
      ]);
      await db.query(
        `INSERT INTO opportunity_analyses(id,opportunity_id,source_content_fingerprint,source_content_version,analysis_version,status,normalized_title,seniority,function,work_mode,employment_type,skills_json,eligibility_json,compensation_json,summary_json,countries_json,skill_slugs_json,requirements_json,updated_at) VALUES($1,$2,'fp',1,'opportunity-analysis/v1','deterministic','PostgreSQL Engineer','senior','engineering','remote','full-time',$3,'{"remote":true,"countries":["CA"]}','{"source":"posted","currency":"CAD","min":100000,"max":150000,"period":"year"}','["Build reliable services"]','["CA"]','["postgresql"]','[{"hash":"requirement-1","text":"Use PostgreSQL","kind":"must","category":"skill","skills":["postgresql"],"evidence":[{"quote":"PRIVATE_SENTINEL_NEVER_PUBLIC"}]}]','2026-10-07T00:00:00Z')`,
        analysisId,
        id,
        skills,
      );
      await db.query(
        `INSERT INTO opportunities(id,source_id,company_id,title,locations,posting_url,posted_at,updated_at,status,current_analysis_id,source_content_fingerprint,source_content_version,human_notes) VALUES($1,'source',${dialect === 'postgres' ? "'99999999-0000-4000-8000-000000000000'" : "'company'"},'PostgreSQL Engineer','Canada','https://example.com/jobs','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','active',$2,'fp',1,'PRIVATE_SENTINEL_NEVER_PUBLIC')`,
        id,
        analysisId,
      );
    }
  }
  return { db, seed, reader: createPublicSearchReader(db, dialect, secret) };
}
for (const dialect of ['sqlite', 'postgres'] as const)
  describe.runIf(dialect === 'sqlite' || Boolean(pgUrl))(
    `public native search ${dialect}`,
    () => {
      it('keeps skill filters ORed while ranking distinct canonical skill matches before text relevance', async () => {
        const { db, seed, reader } = await fixture(dialect);
        await seed(7);
        const setSkills = async (
          index: number,
          skills: Array<{ slug: string; label: string; kind: string }>,
        ) => {
          await db.query(
            `UPDATE opportunity_analyses SET skills_json=$1,skill_slugs_json=$2,normalized_title='Engineer',updated_at='2026-10-07T00:00:00Z' WHERE opportunity_id=$3`,
            JSON.stringify(skills),
            JSON.stringify(skills.map((skill) => skill.slug)),
            jobId(index, dialect),
          );
        };
        await setSkills(0, [
          { slug: 'postgresql', label: 'PostgreSQL', kind: 'required' },
          { slug: 'typescript', label: 'TypeScript', kind: 'preferred' },
          { slug: 'svelte', label: 'Svelte', kind: 'mentioned' },
        ]);
        await setSkills(1, [
          { slug: 'typescript', label: 'TypeScript', kind: 'required' },
        ]);
        await setSkills(2, [{ slug: 'rust', label: 'Rust', kind: 'required' }]);
        await setSkills(3, [
          { slug: 'typescript', label: 'TypeScript', kind: 'required' },
        ]);
        await setSkills(4, [
          { slug: 'typescript', label: 'TypeScript', kind: 'required' },
        ]);
        await setSkills(5, [
          { slug: 'postgresql', label: 'PostgreSQL', kind: 'required' },
        ]);
        await setSkills(6, [
          { slug: 'typescript', label: 'TypeScript', kind: 'required' },
        ]);

        const filtered = await reader.search({
          skills: ['typescript', 'rust'],
          limit: 10,
        });
        expect(filtered.items.map((item) => item.id)).toEqual([
          jobId(6, dialect),
          jobId(4, dialect),
          jobId(3, dialect),
          jobId(2, dialect),
          jobId(1, dialect),
          jobId(0, dialect),
        ]);

        const ranked = await reader.search({
          q: 'postgres',
          skills: ['postgres', 'postgresql', 'ts', 'typescript'],
          limit: 10,
        });
        expect(ranked.items.map((item) => item.id).slice(0, 2)).toEqual([
          jobId(0, dialect),
          jobId(5, dialect),
        ]);
        expect(ranked.items[0]?.skills.mentioned).toEqual([
          { slug: 'svelte', label: 'Svelte' },
        ]);

        const tied = await reader.search({ skills: ['typescript'], limit: 2 });
        const next = await reader.search({
          skills: ['typescript'],
          limit: 2,
          cursor: tied.next_cursor ?? undefined,
        });
        const last = await reader.search({
          skills: ['typescript'],
          limit: 2,
          cursor: next.next_cursor ?? undefined,
        });
        const ids = [...tied.items, ...next.items, ...last.items].map(
          (item) => item.id,
        );
        expect(ids).toHaveLength(5);
        expect(new Set(ids).size).toBe(5);
        expect(ids).toEqual([
          jobId(6, dialect),
          jobId(4, dialect),
          jobId(3, dialect),
          jobId(1, dialect),
          jobId(0, dialect),
        ]);
      });
      it('exposes only bounded sanitized canonical posting text on detail and falls back to canonical location notes', async () => {
        const { db, seed, reader } = await fixture(dialect);
        await seed(1);
        const id = jobId(0, dialect);
        const analysisId =
          dialect === 'postgres'
            ? id.replace('00000000-', '00000001-')
            : `analysis${id}`;
        const source = JSON.stringify({
          descriptionRaw:
            '<p>Build public services.</p><script>PRIVATE_SCRIPT_SENTINEL</script> Contact jobs@example.invalid or +1 403 555 0100.',
          qualifications: `<p>${'Q'.repeat(12_100)}</p>`,
          locationNotes: 'Remote in Canada',
          privateNotes: 'PRIVATE_NOTE_SENTINEL',
          candidateEmail: 'candidate@example.invalid',
        });
        await db.query(
          "UPDATE opportunities SET locations='',source_content_json=$1 WHERE id=$2",
          source,
          id,
        );
        await db.query(
          'UPDATE opportunities SET current_analysis_id=$1 WHERE id=$2',
          analysisId,
          id,
        );

        const detail = await reader.get(id);
        expect(detail?.description_text).toBe(
          'Build public services.\nContact [contact removed] or [contact removed].',
        );
        expect(detail?.qualifications_text).toHaveLength(12_000);
        expect(detail?.location.text).toBe('Remote in Canada');
        expect(
          (await reader.search({ location: 'canada', limit: 10 })).items.map(
            (item) => item.id,
          ),
        ).toEqual([id]);
        expect(
          JSON.stringify(
            await db.query('SELECT * FROM jobgeni_public_catalog_v1'),
          ),
        ).not.toMatch(
          /source_content_json|PRIVATE_NOTE_SENTINEL|candidate@example/i,
        );
        expect(
          JSON.stringify(await reader.search({ limit: 10 })),
        ).not.toContain('description_text');

        await db.query(
          'UPDATE opportunities SET source_content_json=$1 WHERE id=$2',
          'not valid json',
          id,
        );
        await db.query(
          'UPDATE opportunities SET current_analysis_id=$1 WHERE id=$2',
          analysisId,
          id,
        );
        const malformed = await reader.get(id);
        expect(malformed?.description_text).toBeUndefined();
        expect(malformed?.qualifications_text).toBeUndefined();
      });
      it('upgrades an existing PostgreSQL search view without reordering dependent columns', async () => {
        if (dialect !== 'postgres') return;
        const { db } = await fixture(dialect);
        const oldColumns = [
          'id',
          'opportunity_id',
          'source_id',
          'company_id',
          'company_name',
          'posting_url',
          'canonical_url',
          'apply_url',
          'title',
          'locations',
          'posted_at',
          'expires_at',
          'updated_at',
          'opportunity_status',
          'freshness',
          'compensation_min',
          'compensation_max',
          'compensation_currency',
          'analysis_id',
          'source_content_fingerprint',
          'source_content_version',
          'analysis_version',
          'analysis_status',
          'normalized_title',
          'seniority',
          'function',
          'work_mode',
          'employment_type',
          'skills_json',
          'eligibility_json',
          'compensation_json',
          'summary_json',
          'countries_json',
          'skill_slugs_json',
          'search_document',
          'requirements_json',
        ].map((column) => `c.${column}`);
        await db.query(
          'DROP FUNCTION IF EXISTS public.search_public_catalog(tsquery)',
        );
        await db.query('DROP VIEW public.jobgeni_public_search_v1');
        await db.query(
          `CREATE VIEW public.jobgeni_public_search_v1 AS SELECT ${oldColumns.join(',')},d.search_vector,g.generation FROM public.jobgeni_public_catalog_v1 c JOIN public.public_opportunity_search_documents d ON d.id=CAST(c.id AS TEXT) CROSS JOIN public.public_search_generation g WHERE g.id=1`,
        );
        await db.query(
          'CREATE VIEW public.public_search_upgrade_dependency AS SELECT search_vector,generation FROM public.jobgeni_public_search_v1',
        );
        await db.query(
          'GRANT SELECT ON public.jobgeni_public_search_v1 TO PUBLIC',
        );
        const aclBefore = await db.query(
          "SELECT relacl::text AS acl FROM pg_class WHERE oid='public.jobgeni_public_search_v1'::regclass",
        );
        const aclBeforeRows = Array.isArray(aclBefore)
          ? aclBefore
          : (aclBefore.rows ?? []);

        await ensurePublicSearchSchema(db, dialect);
        await ensurePublicSearchSchema(db, dialect);

        const upgraded = await db.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='jobgeni_public_search_v1' ORDER BY ordinal_position",
        );
        const columnRows = Array.isArray(upgraded)
          ? upgraded
          : (upgraded.rows ?? []);
        expect(columnRows.slice(-2).map((row) => row.column_name)).toEqual([
          'description_text',
          'qualifications_text',
        ]);
        expect(
          await db.query(
            'SELECT * FROM public.public_search_upgrade_dependency',
          ),
        ).toBeDefined();
        const aclAfter = await db.query(
          "SELECT relacl::text AS acl FROM pg_class WHERE oid='public.jobgeni_public_search_v1'::regclass",
        );
        const aclAfterRows = Array.isArray(aclAfter)
          ? aclAfter
          : (aclAfter.rows ?? []);
        expect(aclAfterRows[0]?.acl).toBe(aclBeforeRows[0]?.acl);
      });
      it('FTS, filters, facets, cursors, live visibility, private golden isolation, role ACL and benchmark', async () => {
        const { db, seed, reader } = await fixture(dialect);
        await seed(55);
        const batch = await reader.getMany([
          jobId(0, dialect),
          jobId(1, dialect),
          jobId(0, dialect),
        ]);
        expect(batch).toHaveLength(2);
        expect(JSON.stringify(batch)).not.toContain(
          'PRIVATE_SENTINEL_NEVER_PUBLIC',
        );
        expect(await reader.getMany([])).toEqual([]);
        await expect(reader.getMany(['invalid/id'])).rejects.toThrow(
          'Invalid opportunity selection',
        );
        await expect(
          reader.getMany(
            Array.from({ length: 501 }, (_, i) => jobId(i, dialect)),
          ),
        ).rejects.toThrow('Invalid opportunity selection');
        const first = await reader.search({ q: 'postgres', limit: 20 });
        expect(first.items).toHaveLength(20);
        expect(first.total_estimate).toBe(55);
        expect(first.facets.skills).toEqual([
          { value: 'postgresql', label: 'postgresql', count: 55 },
        ]);
        expect(first.next_cursor).toBeTruthy();
        for (const patch of [{ expires: 0 }, { depth: 21 }]) {
          const decoded = JSON.parse(
            Buffer.from(
              first.next_cursor!.split('.')[0],
              'base64url',
            ).toString(),
          );
          const body = Buffer.from(
            JSON.stringify({ ...decoded, ...patch }),
          ).toString('base64url');
          const expired = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
          await expect(
            reader.search({ q: 'postgres', limit: 20, cursor: expired }),
          ).rejects.toThrow();
        }
        await expect(reader.search({ tenant_id: 'user-a' })).rejects.toThrow();
        expect(
          (await reader.search({ q: 'postgres nonexistentzzzz' })).items,
        ).toHaveLength(0);
        const second = await reader.search({
          q: 'postgres',
          limit: 20,
          cursor: first.next_cursor,
        });
        expect(second.items[0].id).not.toBe(first.items[0].id);
        await expect(
          reader.search({ q: 'python', cursor: first.next_cursor }),
        ).rejects.toThrow();
        await expect(
          reader.search({ q: 'postgres', cursor: `${first.next_cursor}x` }),
        ).rejects.toThrow();
        await expect(
          reader.search({ q: 'one two three four five six seven eight nine' }),
        ).rejects.toThrow();
        expect(
          (
            await reader.search({
              skills: ['postgres'],
              country: ['CA'],
              remote_ok: true,
            })
          ).total_estimate,
        ).toBe(55);
        expect((await reader.search({ country: ['US'] })).items).toHaveLength(
          0,
        );
        await db.query(
          `UPDATE opportunities SET locations='MONTREAL 100%_\\ district' WHERE id=$1`,
          jobId(0, dialect),
        );
        expect(
          (await reader.search({ location: 'montreal 100%_\\' })).items.map(
            (item) => item.id,
          ),
        ).toEqual([jobId(0, dialect)]);
        expect(
          (await reader.search({ location: 'montreal 100' })).items,
        ).toHaveLength(1);
        expect((await reader.search({ location: '%' })).items).toHaveLength(1);
        await expect(reader.search({ salary_min: 1 })).rejects.toThrow();
        expect(
          (
            await reader.search({
              sort: 'salary',
              salary_currency: 'CAD',
              salary_period: 'year',
            })
          ).items,
        ).toHaveLength(20);
        const snapshot = JSON.stringify({
          search: first,
          detail: await reader.get(jobId(0, dialect)),
          facets: await reader.facets({}),
          match: await reader.match({ skills: ['Postgres'] }),
        });
        await db.query(
          `INSERT INTO private_workspace_test VALUES('user-a','PRIVATE_A','apply','PRIVATE_SENTINEL_NEVER_PUBLIC'),('user-b','PRIVATE_B','reject','PRIVATE_SENTINEL_NEVER_PUBLIC')`,
        );
        await db.query(
          `INSERT INTO users VALUES('user-a','PRIVATE_A@example.invalid'),('user-b','PRIVATE_B@example.invalid')`,
        );
        for (const user of ['user-a', 'user-b']) {
          await db.query(
            `INSERT INTO opportunity_recommendation_ranks VALUES($1,$1,$1,'${jobId(0, dialect)}',99)`,
            user,
          );
          await db.query(
            `INSERT INTO decisions VALUES($1,$1,$1,'${jobId(0, dialect)}','PRIVATE_SENTINEL_NEVER_PUBLIC')`,
            user,
          );
          await db.query(
            `INSERT INTO opportunity_assessments VALUES($1,$1,$1,'${jobId(0, dialect)}','PRIVATE_SENTINEL_NEVER_PUBLIC')`,
            user,
          );
        }
        expect(
          JSON.stringify({
            search: await reader.search({ q: 'postgres', limit: 20 }),
            detail: await reader.get(jobId(0, dialect)),
            facets: await reader.facets({}),
            match: await reader.match({ skills: ['Postgres'] }),
          }).replace(/"next_cursor":"[^"]+"/g, '"next_cursor":"CURSOR"'),
        ).toBe(
          snapshot.replace(/"next_cursor":"[^"]+"/g, '"next_cursor":"CURSOR"'),
        );
        expect(
          (await reader.search({ q: 'PRIVATE_SENTINEL_NEVER_PUBLIC' })).items,
        ).toHaveLength(0);
        expect(
          JSON.stringify(
            await db.query(
              'SELECT search_document FROM public_opportunity_search_documents',
            ),
          ),
        ).not.toContain('PRIVATE_SENTINEL');
        await db.query('BEGIN');
        await db.query(
          `UPDATE sources SET public_listing=FALSE WHERE id='source'`,
        );
        expect((await reader.search({ q: 'postgres' })).total_estimate).toBe(0);
        await db.query('ROLLBACK');
        expect((await reader.search({ q: 'postgres' })).total_estimate).toBe(
          55,
        );
        await db.query(
          `UPDATE sources SET public_listing=FALSE WHERE id='source'`,
        );
        expect((await reader.search({ q: 'postgres' })).items).toHaveLength(0);
        expect(await reader.get(jobId(0, dialect))).toBeNull();
        expect((await reader.facets({})).skills).toEqual([]);
        expect((await reader.match({ skills: ['postgres'] })).items).toEqual(
          [],
        );
        expect(await reader.sitemap()).toEqual([]);
        await expect(
          reader.search({
            q: 'postgres',
            limit: 20,
            cursor: first.next_cursor,
          }),
        ).rejects.toThrow();
        expect(
          JSON.stringify(
            await db.query('SELECT * FROM public_opportunity_search_documents'),
          ),
        ).not.toContain('PostgreSQL');
        await db.query(
          `UPDATE sources SET public_listing=TRUE WHERE id='source'`,
        );
        expect((await reader.search({ q: 'postgres' })).total_estimate).toBe(
          55,
        );
        // Terminal status changes must invalidate every shared public surface, even without expires_at.
        for (const status of [
          'closed',
          'expired',
          'archived',
          'reject',
          'rejected',
          'deleted',
          'unrecognized',
          null,
        ]) {
          await db.query(
            'UPDATE opportunities SET status=$1,expires_at=NULL',
            status,
          );
          expect((await reader.search({ q: 'postgres' })).items).toHaveLength(
            0,
          );
          expect(await reader.get(jobId(0, dialect))).toBeNull();
          expect((await reader.facets({})).skills).toEqual([]);
          expect((await reader.match({ skills: ['postgres'] })).items).toEqual(
            [],
          );
          expect(await reader.sitemap()).toEqual([]);
          await db.query("UPDATE opportunities SET status='found'");
          expect((await reader.search({ q: 'postgres' })).total_estimate).toBe(
            55,
          );
        }
        for (const status of [
          'found',
          'recommended',
          'apply',
          'applied',
          'interviewing',
          'offer',
          'maybe',
          'needs_input',
          'active',
          'new',
        ]) {
          await db.query('UPDATE opportunities SET status=$1', status);
          expect((await reader.search({ q: 'postgres' })).total_estimate).toBe(
            55,
          );
        }
        // Use the production CAS writer: summaries persist as arrays, not fixture-only objects.
        const sourceContent = {
          title: 'PostgreSQL Engineer',
          descriptionRaw: 'PostgreSQL is required.',
          requiredSkills: 'PostgreSQL',
        };
        const identity = {
          id: jobId(0, dialect),
          sourceContentJson: JSON.stringify(sourceContent),
          sourceContentFingerprint:
            fingerprintOpportunitySourceContent(sourceContent),
          sourceContentVersion: 2,
        };
        await db.query(
          'UPDATE opportunities SET source_content_json=$1,source_content_fingerprint=$2,source_content_version=2 WHERE id=$3',
          identity.sourceContentJson,
          identity.sourceContentFingerprint,
          identity.id,
        );
        const published = await publishOpportunityAnalysis(
          db as never,
          identity,
          {
            ...deterministicOpportunityAnalysis(identity),
            status: 'enriched',
            summaryBullets: [
              'Build reliable services',
              'Maintain PostgreSQL systems',
            ],
          },
        );
        expect(published.summaryBullets).toEqual([
          'Build reliable services',
          'Maintain PostgreSQL systems',
        ]);
        const detail = await reader.get(identity.id);
        expect(detail?.summary_bullets).toEqual(published.summaryBullets);
        expect(
          publicJobPosting(detail!, 'https://example.test').description,
        ).toBe('Build reliable services\nMaintain PostgreSQL systems');
        await db.query(
          `UPDATE opportunity_analyses SET normalized_title='Rust Developer',skill_slugs_json='["rust"]',summary_json='[]' WHERE opportunity_id='${jobId(0, dialect)}'`,
        );
        expect((await reader.search({ q: 'rust' })).items[0]?.id).toBe(
          jobId(0, dialect),
        );
        let benchmarkDb = db;
        if (dialect === 'postgres') {
          await db.query(
            `DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='search_test_public') THEN CREATE ROLE search_test_public LOGIN; END IF; END $$`,
          );
          await db.query('GRANT USAGE ON SCHEMA public TO search_test_public');
          await db.query(
            'GRANT SELECT ON jobgeni_public_catalog_v1,jobgeni_public_search_v1 TO search_test_public',
          );
          await db.query(
            'GRANT EXECUTE ON FUNCTION consume_public_search_quota(integer),search_public_catalog(tsquery) TO search_test_public',
          );
          await db.query('ALTER ROLE search_test_public LOGIN');
          await db.query(
            "ALTER ROLE search_test_public SET statement_timeout='500ms'",
          );
          const roleUrl = new URL(pgUrl!);
          roleUrl.username = 'search_test_public';
          roleUrl.password = '';
          roleUrl.searchParams.set('statement_timeout', '500');
          const restricted = (await resolveDatabase({
            type: 'postgres',
            url: roleUrl.href,
            max: 1,
          })) as unknown as PublicDatabase;
          expect(
            JSON.stringify(await restricted.query('SHOW statement_timeout')),
          ).toContain('500ms');
          benchmarkDb = restricted;
          const restrictedReader = createPublicSearchReader(
            restricted,
            'postgres',
            secret,
          );
          expect(
            (await restrictedReader.search({ q: 'postgres' })).items.length,
          ).toBeGreaterThan(0);
          await expect(
            restricted.query('SELECT * FROM private_workspace_test'),
          ).rejects.toThrow();
          await expect(
            restricted.query('SELECT * FROM opportunities'),
          ).rejects.toThrow();
          await expect(
            restricted.query('DELETE FROM jobgeni_public_search_v1'),
          ).rejects.toThrow();
          for (const table of [
            'users',
            'opportunity_recommendation_ranks',
            'decisions',
            'opportunity_assessments',
          ])
            await expect(
              restricted.query(`SELECT * FROM ${table}`),
            ).rejects.toThrow();
          const quota = await Promise.all(
            Array.from({ length: 61 }, () =>
              restricted.query(
                'SELECT consume_public_search_quota(10) AS remaining',
              ),
            ),
          );
          const remaining = quota.map((result) =>
            Number(
              (Array.isArray(result) ? result[0] : result.rows?.[0])?.remaining,
            ),
          );
          expect(remaining.at(-1)).toBe(0);
          expect(remaining[59]).toBe(1);
        }
        if (process.env.PUBLIC_SEARCH_BENCHMARK === '1') {
          await db.query('BEGIN');
          await seed(10000, 55);
          await db.query('COMMIT');
          if (dialect === 'postgres') await db.query('ANALYZE');
          console.log(`seeded10000 ${dialect}`);
          if (dialect === 'postgres') {
            const plan = await db.query(
              "EXPLAIN SELECT d.id FROM public_opportunity_search_documents d WHERE d.search_vector @@ plainto_tsquery('english','rust') AND EXISTS(SELECT 1 FROM jobgeni_public_catalog_v1 c WHERE c.id=CAST(d.id AS UUID))",
            );
            expect(JSON.stringify(plan)).toContain(
              'idx_public_opportunity_search_vector',
            );
            if (process.env.PUBLIC_SEARCH_EVIDENCE_DIR)
              writeFileSync(
                join(
                  process.env.PUBLIC_SEARCH_EVIDENCE_DIR,
                  'pg-gin-plan.json',
                ),
                JSON.stringify(plan),
              );
          }
          const statementMs: number[] = [];
          const benchmarkReader = createPublicSearchReader(
            {
              query: async (sql, ...values) => {
                const started = performance.now();
                try {
                  return await benchmarkDb.query(sql, ...values);
                } finally {
                  statementMs.push(performance.now() - started);
                }
              },
            },
            dialect,
            secret,
          );
          const timings = [];
          for (let i = 0; i < 25; i++) {
            const start = performance.now();
            await benchmarkReader.search({ q: 'postgres', limit: 20 });
            timings.push(performance.now() - start);
          }
          const cold = timings[0];
          timings.sort((a, b) => a - b);
          const p95 = timings[Math.floor(timings.length * 0.95)];
          console.log(
            JSON.stringify({
              benchmark: 'public-search-10000',
              dialect,
              samples: timings.length,
              p95_ms: p95,
            }),
          );
          if (process.env.PUBLIC_SEARCH_EVIDENCE_DIR) {
            mkdirSync(process.env.PUBLIC_SEARCH_EVIDENCE_DIR, {
              recursive: true,
            });
            writeFileSync(
              join(
                process.env.PUBLIC_SEARCH_EVIDENCE_DIR,
                `benchmark-${dialect}.json`,
              ),
              JSON.stringify({
                dialect,
                count: 10000,
                samples: 25,
                cold_ms: cold,
                max_statement_ms: Math.max(...statementMs),
                p95_ms: p95,
              }),
            );
          }
          expect(p95).toBeLessThan(100);
        }
      }, 120000);
    },
  );
it('public modules do not import private services or raw private objects', () => {
  const root = join(process.cwd(), 'src/lib/server/public-search');
  for (const name of readdirSync(root).filter(
    (n) => n.endsWith('.ts') && !n.includes('.spec.'),
  )) {
    const source = readFileSync(join(root, name), 'utf8');
    expect(source).not.toMatch(
      /from\s+['"][^'"]*(private-workspace|opportunity-assessment-store|opportunity-recommendation-|resume-data|objects\/)/,
    );
  }
});
