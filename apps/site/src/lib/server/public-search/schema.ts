/** Only the current, sanitized public view can supply index content. */
type Database = {
  query(statement: string, ...values: unknown[]): Promise<unknown>;
};
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
      ? `CREATE TABLE IF NOT EXISTS public_opportunity_search_documents (id TEXT PRIMARY KEY, search_document TEXT NOT NULL, search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english',search_document)) STORED)`
      : `CREATE TABLE IF NOT EXISTS public_opportunity_search_documents (id TEXT PRIMARY KEY, search_document TEXT NOT NULL)`,
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
        await db.query(`CREATE TRIGGER public_search_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
      DELETE FROM public_opportunity_search_documents WHERE id IN (${ids});
      INSERT INTO public_opportunity_search_documents(id,search_document) SELECT id,search_document FROM jobgeni_public_catalog_v1 WHERE id IN (${ids});
      UPDATE public_search_generation SET generation=generation+1 WHERE id=1;
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
   DECLARE keys text[]; k text; entity text;
   BEGIN
    entity:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_TABLE_NAME='opportunities' THEN keys:=ARRAY[entity];
    ELSIF TG_TABLE_NAME='sources' THEN SELECT array_agg(id) INTO keys FROM opportunities WHERE source_id=entity;
    ELSIF TG_TABLE_NAME='companies' THEN SELECT array_agg(id) INTO keys FROM opportunities WHERE company_id=entity;
    ELSE SELECT array_agg(id) INTO keys FROM opportunities WHERE current_analysis_id=CAST(entity AS UUID); END IF;
    FOREACH k IN ARRAY coalesce(keys,ARRAY[]::text[]) LOOP
     DELETE FROM public_opportunity_search_documents WHERE CAST(id AS TEXT)=k;
     INSERT INTO public_opportunity_search_documents(id,search_document) SELECT id,search_document FROM jobgeni_public_catalog_v1 WHERE id=CAST(k AS UUID);
    END LOOP;
    UPDATE public_search_generation SET generation=generation+1 WHERE id=1;
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
      `CREATE OR REPLACE VIEW public.jobgeni_public_search_v1 WITH (security_barrier=true) AS SELECT c.*,d.search_vector,g.generation FROM public.jobgeni_public_catalog_v1 c JOIN public.public_opportunity_search_documents d ON d.id=CAST(c.id AS TEXT) CROSS JOIN public.public_search_generation g WHERE g.id=1`,
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
  await db.query(`DELETE FROM public_opportunity_search_documents`);
  await db.query(
    `INSERT INTO public_opportunity_search_documents(id,search_document) SELECT id,search_document FROM jobgeni_public_catalog_v1`,
  );
  await db.query(
    `UPDATE public_search_generation SET generation=generation+1 WHERE id=1`,
  );
}
/** Legacy writer hook intentionally refreshes from the approved view, never caller text. */
export async function refreshPublicOpportunitySearchDocument(
  db: Database,
  _dialect: 'postgres' | 'sqlite',
  input: {
    id: string;
    title: string;
    company: string;
    summary: string;
    skills: string[];
  },
): Promise<void> {
  await db.query(
    `DELETE FROM public_opportunity_search_documents WHERE id=$1`,
    input.id,
  );
  await db.query(
    `INSERT INTO public_opportunity_search_documents(id,search_document) SELECT id,search_document FROM jobgeni_public_catalog_v1 WHERE id=$1`,
    input.id,
  );
}
