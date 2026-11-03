/** Only the current, sanitized public view can supply index content. */
type Database = {
  query(statement: string, ...values: unknown[]): Promise<unknown>;
};
// Keep this list in the original catalog-view order. PostgreSQL's CREATE OR
// REPLACE VIEW can append columns but cannot insert them ahead of an existing
// dependent view column (search_vector or generation on deployed databases).
const searchCatalogColumns = [
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
/**
 * Every public catalog column a reader can filter, facet, sort or display,
 * except `updated_at`: crawls re-stamp it on every sighting, it is display-only,
 * and hashing it would rewrite the index on every crawl (#286).
 */
const hashedCatalogColumns = [
  ...searchCatalogColumns.filter((column) => column !== 'c.updated_at'),
  'c.description_text',
  'c.qualifications_text',
];
/** Content hash of one catalog row `c`; it decides whether a document is rewritten. */
function contentHash(dialect: 'postgres' | 'sqlite'): string {
  const columns = hashedCatalogColumns.join(',');
  return dialect === 'postgres'
    ? `md5(json_build_array(${columns})::text)`
    : `json_array(${columns})`;
}
export async function ensurePublicSearchSchema(
  db: Database,
  dialect: 'postgres' | 'sqlite',
): Promise<void> {
  for (const column of ['source_id', 'company_id', 'current_analysis_id'])
    await db.query(
      `CREATE INDEX IF NOT EXISTS public_search_opportunity_${column} ON opportunities(${column})`,
    );
  await db.query(
    `CREATE TABLE IF NOT EXISTS public_search_generation (id INTEGER PRIMARY KEY, generation BIGINT NOT NULL DEFAULT 0)`,
  );
  await db.query(
    `INSERT INTO public_search_generation (id,generation) VALUES (1,0) ON CONFLICT (id) DO NOTHING`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS public_search_quotas (bucket TEXT PRIMARY KEY, window_start BIGINT NOT NULL, spent INTEGER NOT NULL)`,
  );
  await db.query(
    dialect === 'postgres'
      ? `CREATE TABLE IF NOT EXISTS public_opportunity_search_documents (id TEXT PRIMARY KEY, search_document TEXT NOT NULL, search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english',search_document)) STORED, content_hash TEXT)`
      : `CREATE TABLE IF NOT EXISTS public_opportunity_search_documents (id TEXT PRIMARY KEY, search_document TEXT NOT NULL, content_hash TEXT)`,
  );
  // Existing indexes predate the hash; a NULL hash is rewritten once, then
  // diffed. Probe first: ALTER TABLE takes an exclusive lock even when the
  // column already exists, and this runs on every migrate.
  const hashColumn = await db.query(
    dialect === 'postgres'
      ? "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='public_opportunity_search_documents' AND column_name='content_hash'"
      : "SELECT 1 FROM pragma_table_info('public_opportunity_search_documents') WHERE name='content_hash'",
  );
  if (returnedRows(hashColumn) === 0)
    await db.query(
      'ALTER TABLE public_opportunity_search_documents ADD COLUMN content_hash TEXT',
    );
  if (dialect === 'sqlite') {
    await db.query('DROP TRIGGER IF EXISTS public_search_opportunity_refresh');
    await db.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS jobgeni_public_catalog_fts USING fts5(id UNINDEXED, search_document)`,
    );
    for (const [event, body] of Object.entries({
      INSERT: `INSERT INTO jobgeni_public_catalog_fts(id,search_document) VALUES(NEW.id,NEW.search_document);`,
      UPDATE: `DELETE FROM jobgeni_public_catalog_fts WHERE id=OLD.id; INSERT INTO jobgeni_public_catalog_fts(id,search_document) VALUES(NEW.id,NEW.search_document);`,
      DELETE: `DELETE FROM jobgeni_public_catalog_fts WHERE id=OLD.id;`,
    })) {
      await db.query(
        `CREATE TRIGGER IF NOT EXISTS public_search_docs_${event.toLowerCase()} AFTER ${event} ON public_opportunity_search_documents BEGIN ${body} END`,
      );
    }
    for (const [table, where] of [
      ['opportunities', 'id = NEW.id'],
      ['sources', 'source_id = NEW.id'],
      ['companies', 'company_id = NEW.id'],
      ['opportunity_analyses', 'current_analysis_id = NEW.id'],
    ] as const) {
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const condition = where.replaceAll(
          'NEW.',
          event === 'DELETE' ? 'OLD.' : 'NEW.',
        );
        const ids =
          table === 'opportunities'
            ? `SELECT ${event === 'DELETE' ? 'OLD' : 'NEW'}.id`
            : `SELECT id FROM opportunities WHERE ${condition}`;
        await db.query(
          `DROP TRIGGER IF EXISTS public_search_${table}_${event.toLowerCase()}`,
        );
        // Diff, never rebuild: bump the generation only when a document's
        // content hash will change, then write changed rows, drop departed ones.
        await db.query(`CREATE TRIGGER public_search_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
      UPDATE public_search_generation SET generation=generation+1 WHERE id=1 AND (
        EXISTS (SELECT 1 FROM jobgeni_public_catalog_v1 c LEFT JOIN public_opportunity_search_documents d ON d.id=c.id WHERE c.id IN (${ids}) AND d.content_hash IS NOT ${contentHash('sqlite')})
        OR EXISTS (SELECT 1 FROM public_opportunity_search_documents d WHERE d.id IN (${ids}) AND d.id NOT IN (SELECT id FROM jobgeni_public_catalog_v1 WHERE id IN (${ids}))));
      INSERT INTO public_opportunity_search_documents(id,search_document,content_hash) SELECT c.id,c.search_document,${contentHash('sqlite')} FROM jobgeni_public_catalog_v1 c WHERE c.id IN (${ids})
        ON CONFLICT(id) DO UPDATE SET search_document=excluded.search_document,content_hash=excluded.content_hash WHERE public_opportunity_search_documents.content_hash IS NOT excluded.content_hash;
      DELETE FROM public_opportunity_search_documents WHERE id IN (${ids}) AND id NOT IN (SELECT id FROM jobgeni_public_catalog_v1 WHERE id IN (${ids}));
    END`);
      }
    }
    await db.query(`DROP VIEW IF EXISTS jobgeni_public_search_v1`);
    await db.query(
      `CREATE VIEW jobgeni_public_search_v1 AS SELECT c.*,g.generation FROM jobgeni_public_catalog_v1 c CROSS JOIN public_search_generation g WHERE g.id=1`,
    );
  } else {
    await db.query(
      'DROP TRIGGER IF EXISTS public_search_opportunity_refresh ON opportunities',
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_public_opportunity_search_vector ON public_opportunity_search_documents USING GIN(search_vector) WITH (fastupdate=off)`,
    );
    await db.query(
      'ALTER INDEX idx_public_opportunity_search_vector SET (fastupdate=off)',
    );
    await db.query(
      "SELECT gin_clean_pending_list('idx_public_opportunity_search_vector')",
    );
    await db.query(`CREATE OR REPLACE FUNCTION refresh_public_opportunity_search_document() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
   DECLARE keys text[]; k text; entity text; doc text; hash text; n integer; changed integer:=0;
   BEGIN
    entity:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_TABLE_NAME='opportunities' THEN keys:=ARRAY[entity];
    ELSIF TG_TABLE_NAME='sources' THEN SELECT array_agg(id) INTO keys FROM opportunities WHERE source_id=entity;
    ELSIF TG_TABLE_NAME='companies' THEN SELECT array_agg(id) INTO keys FROM opportunities WHERE company_id=entity;
    ELSE SELECT array_agg(id) INTO keys FROM opportunities WHERE current_analysis_id=CAST(entity AS UUID); END IF;
    -- Diff, never rebuild: a document whose content hash is unchanged is not
    -- touched at all (probe first: a no-op ON CONFLICT still locks and logs the
    -- row), and the generation only moves when some document actually changed.
    FOREACH k IN ARRAY coalesce(keys,ARRAY[]::text[]) LOOP
     n:=0;
     SELECT c.search_document,${contentHash('postgres')} INTO doc,hash FROM jobgeni_public_catalog_v1 c WHERE c.id=CAST(k AS UUID);
     IF FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public_opportunity_search_documents WHERE id=k AND content_hash IS NOT DISTINCT FROM hash) THEN
       INSERT INTO public_opportunity_search_documents(id,search_document,content_hash) VALUES(k,doc,hash)
        ON CONFLICT (id) DO UPDATE SET search_document=EXCLUDED.search_document,content_hash=EXCLUDED.content_hash
        WHERE public_opportunity_search_documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash;
       GET DIAGNOSTICS n = ROW_COUNT;
      END IF;
     ELSE
      DELETE FROM public_opportunity_search_documents WHERE id=k;
      GET DIAGNOSTICS n = ROW_COUNT;
     END IF;
     changed:=changed+n;
    END LOOP;
    IF changed>0 THEN UPDATE public_search_generation SET generation=generation+1 WHERE id=1; END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
   END $$`);
    for (const table of [
      'opportunities',
      'sources',
      'companies',
      'opportunity_analyses',
    ]) {
      await db.query(
        `DROP TRIGGER IF EXISTS public_search_${table}_refresh ON ${table}`,
      );
      await db.query(
        `CREATE TRIGGER public_search_${table}_refresh AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION refresh_public_opportunity_search_document()`,
      );
    }
    // The security barrier enforces current source/analysis visibility before public filters.
    await db.query(
      `CREATE OR REPLACE VIEW public.jobgeni_public_search_v1 WITH (security_barrier=true) AS SELECT ${searchCatalogColumns.join(',')},d.search_vector,g.generation,c.description_text,c.qualifications_text FROM public.jobgeni_public_catalog_v1 c JOIN public.public_opportunity_search_documents d ON d.id=CAST(c.id AS TEXT) CROSS JOIN public.public_search_generation g WHERE g.id=1`,
    );
    await db.query(`CREATE OR REPLACE FUNCTION public.consume_public_search_quota(cost integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
   DECLARE spent_now integer; epoch bigint:=floor(extract(epoch from clock_timestamp())/60);
   BEGIN
    IF cost<1 OR cost>20 THEN RAISE EXCEPTION 'invalid quota cost'; END IF;
    INSERT INTO public.public_search_quotas(bucket,window_start,spent) VALUES('anonymous-global',epoch,cost)
    ON CONFLICT(bucket) DO UPDATE SET window_start=epoch,spent=CASE WHEN public_search_quotas.window_start=epoch THEN public_search_quotas.spent+cost ELSE cost END
    RETURNING spent INTO spent_now;
    RETURN greatest(0,601-spent_now);
   END $$`);
    await db.query(
      `REVOKE ALL ON FUNCTION public.consume_public_search_quota(integer) FROM PUBLIC`,
    );
  }
  if (dialect === 'postgres') {
    await db.query(
      `DO $$ BEGIN IF to_regprocedure('public.search_public_catalog(tsquery)') IS NOT NULL AND pg_get_function_result(to_regprocedure('public.search_public_catalog(tsquery)')) <> 'TABLE(id text)' THEN DROP FUNCTION public.search_public_catalog(tsquery); END IF; END $$`,
    );
    await db.query(`CREATE OR REPLACE FUNCTION public.search_public_catalog(search_query tsquery) RETURNS TABLE(id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      SELECT d.id FROM public.public_opportunity_search_documents d
      WHERE d.search_vector @@ search_query AND EXISTS(SELECT 1 FROM public.jobgeni_public_catalog_v1 c WHERE c.id=CAST(d.id AS UUID))
    $$`);
    await db.query(
      `REVOKE ALL ON FUNCTION public.search_public_catalog(tsquery) FROM PUBLIC`,
    );
  }
  await reconcilePublicSearchDocuments(db, dialect);
}

function returnedRows(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Upsert the catalog rows matching `where` whose content hash differs from the
 * indexed one. Unchanged rows are filtered out before the upsert, because in
 * PostgreSQL even a no-op `ON CONFLICT DO UPDATE ... WHERE` locks, and so
 * WAL-logs, every conflicting row; the conflict guard stays for races.
 */
function upsertChangedDocuments(
  dialect: 'postgres' | 'sqlite',
  where: string,
): string {
  const id = dialect === 'postgres' ? 'CAST(c.id AS TEXT)' : 'c.id';
  const distinct = dialect === 'postgres' ? 'IS DISTINCT FROM' : 'IS NOT';
  return `INSERT INTO public_opportunity_search_documents(id,search_document,content_hash)
     SELECT x.id,x.search_document,x.content_hash FROM (SELECT ${id} AS id,c.search_document,${contentHash(dialect)} AS content_hash FROM jobgeni_public_catalog_v1 c WHERE ${where}) x
     LEFT JOIN public_opportunity_search_documents d ON d.id=x.id
     WHERE d.id IS NULL OR d.content_hash ${distinct} x.content_hash
     ON CONFLICT(id) DO UPDATE SET search_document=excluded.search_document,content_hash=excluded.content_hash
     WHERE public_opportunity_search_documents.content_hash ${distinct} excluded.content_hash`;
}

/**
 * Converge the search index on the approved catalog view by diff.
 *
 * Every deploy, and every migrate that guards a scheduled job, runs this, so it
 * must be write-free when nothing changed: it upserts only documents whose
 * content hash differs, deletes only rows that left the catalog, and bumps the
 * generation only when one of those wrote. A delete-all and reinsert here
 * rewrote the whole index on each run, and a concurrent trigger insert could
 * fail the reinsert after the delete had already emptied the index (#286).
 *
 * @returns The number of documents inserted, updated or deleted.
 */
export async function reconcilePublicSearchDocuments(
  db: Database,
  dialect: 'postgres' | 'sqlite',
): Promise<number> {
  const upserted = await db.query(
    `${upsertChangedDocuments(dialect, 'true')} RETURNING id`,
  );
  const id = dialect === 'postgres' ? 'CAST(c.id AS TEXT)' : 'c.id';
  const deleted = await db.query(
    `DELETE FROM public_opportunity_search_documents
     WHERE NOT EXISTS (SELECT 1 FROM jobgeni_public_catalog_v1 c WHERE ${id}=public_opportunity_search_documents.id)
     RETURNING id`,
  );
  const changed = returnedRows(upserted) + returnedRows(deleted);
  if (changed > 0)
    await db.query(
      `UPDATE public_search_generation SET generation=generation+1 WHERE id=1`,
    );
  return changed;
}

/** Legacy writer hook intentionally refreshes from the approved view, never caller text. */
export async function refreshPublicOpportunitySearchDocument(
  db: Database,
  dialect: 'postgres' | 'sqlite',
  input: {
    id: string;
    title: string;
    company: string;
    summary: string;
    skills: string[];
  },
): Promise<void> {
  const id = dialect === 'postgres' ? 'CAST(c.id AS TEXT)' : 'c.id';
  await db.query(upsertChangedDocuments(dialect, `${id}=$1`), input.id);
  await db.query(
    `DELETE FROM public_opportunity_search_documents
     WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM jobgeni_public_catalog_v1 c WHERE ${id}=$1)`,
    input.id,
  );
}
