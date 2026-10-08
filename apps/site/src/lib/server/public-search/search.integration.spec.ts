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

import { ensureOpportunityAnalysisSchema } from '../opportunity-analysis-schema.js';
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
    Object.assign(db, { url: ':memory:' });
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
      'id TEXT PRIMARY KEY,opportunity_id TEXT,source_content_fingerprint TEXT,source_content_version INTEGER,analysis_version TEXT,status TEXT,normalized_title TEXT,seniority TEXT,function TEXT,work_mode TEXT,employment_type TEXT,skills_json TEXT,eligibility_json TEXT,compensation_json TEXT,summary_json TEXT,countries_json TEXT,skill_slugs_json TEXT,requirements_json TEXT,source_content_digest TEXT,model TEXT,prompt_version TEXT,output_schema_version TEXT,updated_at TEXT',
    opportunity_skills:
      'id TEXT,analysis_id TEXT,skill_slug TEXT,kind TEXT,opportunity_id TEXT',
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
        `INSERT INTO opportunity_analyses(id,opportunity_id,source_content_fingerprint,source_content_version,analysis_version,status,normalized_title,seniority,function,work_mode,employment_type,skills_json,eligibility_json,compensation_json,summary_json,countries_json,skill_slugs_json,requirements_json,updated_at) VALUES($1,$2,'fp',1,'opportunity-analysis/v1','deterministic','PostgreSQL Engineer','senior','engineering','remote','full-time',$3,'{"remote":true,"countries":["CA"]}','{"source":"posted","currency":"CAD","min":100000,"max":150000,"period":"year"}','{"bullets":["Build reliable services"]}','["CA"]','["postgresql"]','[{"hash":"requirement-1","text":"Use PostgreSQL","kind":"must","category":"skill","skills":["postgresql"],"evidence":[{"quote":"PRIVATE_SENTINEL_NEVER_PUBLIC"}]}]','2026-10-07T00:00:00Z')`,
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
      it('FTS, filters, facets, cursors, live visibility, private golden isolation, role ACL and benchmark', async () => {
        const { db, seed, reader } = await fixture(dialect);
        await seed(55);
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
        await db.query(
          `UPDATE opportunity_analyses SET normalized_title='Rust Developer',skill_slugs_json='["rust"]',summary_json='{}' WHERE opportunity_id='${jobId(0, dialect)}'`,
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
