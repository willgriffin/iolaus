/**
 * Search-only projection.  It intentionally copies only data approved for the
 * anonymous catalog, so its PostgreSQL GIN index and SQLite FTS5 table cannot
 * become an alternate path to raw descriptions or private overlays.
 */
type Database = {
  query(statement: string, ...values: unknown[]): Promise<unknown>;
};

export async function ensurePublicSearchSchema(
  db: Database,
  dialect: 'postgres' | 'sqlite',
): Promise<void> {
  if (dialect === 'sqlite') {
    await db.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS jobgeni_public_catalog_fts USING fts5(id UNINDEXED, search_document)`,
    );
    await db.query(
      `CREATE TABLE IF NOT EXISTS public_opportunity_search_documents (id TEXT PRIMARY KEY, search_document TEXT NOT NULL DEFAULT '')`,
    );
    await db.query(`CREATE TRIGGER IF NOT EXISTS public_search_opportunity_refresh AFTER INSERT ON opportunities BEGIN
      INSERT OR REPLACE INTO public_opportunity_search_documents (id, search_document) SELECT NEW.id, coalesce(NEW.title, '') || ' ' || coalesce(a.normalized_title, '') || ' ' || coalesce(a.summary_json, '') || ' ' || coalesce(a.skill_slugs_json, '') FROM opportunity_analyses a WHERE a.id = NEW.current_analysis_id;
      DELETE FROM jobgeni_public_catalog_fts WHERE id = NEW.id;
      INSERT INTO jobgeni_public_catalog_fts (id, search_document) SELECT id, search_document FROM public_opportunity_search_documents WHERE id = NEW.id;
    END`);
    return;
  }
  await db.query(`CREATE TABLE IF NOT EXISTS public_opportunity_search_documents (
    id TEXT PRIMARY KEY,
    search_document TEXT NOT NULL DEFAULT '',
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', search_document)) STORED
  )`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_public_opportunity_search_documents_vector ON public_opportunity_search_documents USING GIN (search_vector)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_public_opportunity_search_documents_id ON public_opportunity_search_documents (id)`,
  );
  await db.query(`CREATE OR REPLACE FUNCTION refresh_public_opportunity_search_document() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE opportunity_key text;
    BEGIN
      opportunity_key := COALESCE(NEW.id, OLD.id);
      INSERT INTO public_opportunity_search_documents (id, search_document)
      SELECT o.id, concat_ws(' ', o.title, c.name, a.normalized_title, a.summary_json, a.skill_slugs_json)
      FROM opportunities o JOIN sources s ON s.id = o.source_id LEFT JOIN companies c ON c.id = o.company_id JOIN opportunity_analyses a ON a.id = o.current_analysis_id
      WHERE o.id = opportunity_key AND o.status <> 'archived' AND s.public_listing = true AND s.is_active = true
      ON CONFLICT (id) DO UPDATE SET search_document = EXCLUDED.search_document;
      IF NOT FOUND THEN DELETE FROM public_opportunity_search_documents WHERE id = opportunity_key; END IF;
      RETURN COALESCE(NEW, OLD);
    END $$`);
  await db.query(
    `DROP TRIGGER IF EXISTS public_search_opportunity_refresh ON opportunities`,
  );
  await db.query(
    `CREATE TRIGGER public_search_opportunity_refresh AFTER INSERT OR UPDATE OF current_analysis_id, title, status, source_id, company_id ON opportunities FOR EACH ROW EXECUTE FUNCTION refresh_public_opportunity_search_document()`,
  );
}

/** Call from the catalog analysis writer after its atomic current-analysis switch. */
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
  const document = [input.title, input.company, input.summary, ...input.skills]
    .join(' ')
    .slice(0, 20_000);
  if (dialect === 'sqlite') {
    await db.query(
      'DELETE FROM jobgeni_public_catalog_fts WHERE id = $1',
      input.id,
    );
    await db.query(
      'INSERT INTO jobgeni_public_catalog_fts (id, search_document) VALUES ($1, $2)',
      input.id,
      document,
    );
    await db.query(
      'INSERT OR REPLACE INTO public_opportunity_search_documents (id, search_document) VALUES ($1, $2)',
      input.id,
      document,
    );
    return;
  }
  await db.query(
    `INSERT INTO public_opportunity_search_documents (id, search_document) VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET search_document = EXCLUDED.search_document`,
    input.id,
    document,
  );
}
