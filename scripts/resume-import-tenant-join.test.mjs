import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {test} from 'node:test';

// Optional PostgreSQL WASM runtime for native UUID/text regressions; no service.
let PGlite;
try {
  const require=createRequire(import.meta.url);
  ({PGlite}=await import(process.env.PGLITE_MODULE || require.resolve('@electric-sql/pglite')));
} catch(error) {if(process.env.PGLITE_MODULE) throw error;}
const source=await readFile(new URL('../apps/site/src/lib/server/resume-import-runtime.ts',import.meta.url),'utf8');
const queries=[...source.matchAll(/`(SELECT[^`]+JOIN candidate_profiles AS profile[^`]+)`/g)].map(match=>match[1]);
const tenant='11111111-1111-4111-8111-111111111111';
const otherTenant='22222222-2222-4222-8222-222222222222';
const profile='33333333-3333-4333-8333-333333333333';
const item='44444444-4444-4444-8444-444444444444';
const foreign='55555555-5555-4555-8555-555555555555';
const parameterize=sql=>{let index=0;return sql.replaceAll('?',()=>`$${++index}`);};

test('all resume candidate joins handle native UUID intake tenants and legacy text ownership',{skip:!PGlite},async()=>{
  assert.equal(queries.length,3,'worker subject, recovery and account export must use the same exact scope');
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE candidate_profiles(id uuid PRIMARY KEY,tenant_id text,owner_user_id text);
      CREATE TABLE intake_items(id uuid PRIMARY KEY,tenant_id uuid,confidential_scope_id text,data jsonb,
      visibility text DEFAULT 'active',expires_at timestamptz,receipt_state text,processing_state text,analysis_revision integer,created_at timestamptz DEFAULT now());`);
    await db.query('INSERT INTO candidate_profiles VALUES ($1,$2,$3)',[profile,tenant,'owner']);
    await db.query('INSERT INTO intake_items(id,tenant_id,confidential_scope_id,data) VALUES ($1,$2,$3,$4)',[item,tenant,profile,JSON.stringify({principalUserId:'owner'})]);
    await db.query('INSERT INTO intake_items(id,tenant_id,confidential_scope_id,data) VALUES ($1,$2,$3,$4)',[foreign,otherTenant,profile,JSON.stringify({principalUserId:'owner'})]);
    const [receipt,recovery,accountExport]=queries.map(parameterize);
    assert.equal((await db.query(receipt,[item])).rows.length,1);
    assert.equal((await db.query(receipt,[foreign])).rows.length,0);
    assert.equal((await db.query(recovery)).rows.length,1);
    assert.equal((await db.query(accountExport,[tenant,'owner'])).rows.length,1);
    assert.equal((await db.query(accountExport,[otherTenant,'owner'])).rows.length,0);
    assert.equal((await db.query(accountExport,[tenant,'other-owner'])).rows.length,0);
    await db.query('UPDATE intake_items SET confidential_scope_id=$1 WHERE id=$2',['another-profile',item]);
    assert.equal((await db.query(receipt,[item])).rows.length,0);
  } finally {await db.close();}
});
