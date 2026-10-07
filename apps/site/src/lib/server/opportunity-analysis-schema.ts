import { detectEngine, type resolveDatabase } from '@happyvertical/smrt-core';

type Database = Awaited<ReturnType<typeof resolveDatabase>>;

/** Supplemental indexes and the least-privilege public projection.
 * Tables and foreign keys are owned by the SMRT object migration. */
export async function ensureOpportunityAnalysisSchema(
  db: Database,
): Promise<void> {
  const sqlite = Boolean(db.url && detectEngine(db.url) === 'sqlite');
  const indexes = [
    'CREATE UNIQUE INDEX IF NOT EXISTS opportunity_analyses_current_key ON opportunity_analyses (opportunity_id, source_content_fingerprint, analysis_version)',
    'CREATE INDEX IF NOT EXISTS opportunity_analyses_opportunity_current ON opportunity_analyses (opportunity_id, updated_at DESC)',
    'CREATE UNIQUE INDEX IF NOT EXISTS opportunity_skills_analysis_key ON opportunity_skills (analysis_id, skill_slug, kind)',
    'CREATE INDEX IF NOT EXISTS opportunity_skills_facet ON opportunity_skills (skill_slug, kind, opportunity_id)',
  ];
  for (const statement of indexes) await db.query(statement);
  // Raw crawler writes bypass Opportunity.save. Keep the live pointer fenced in
  // the database so every writer invalidates it when material source identity
  // changes; publication rechecks this identity before selecting a new row.
  if (sqlite) {
    await db.query(
      'DROP TRIGGER IF EXISTS opportunity_analysis_invalidate_current',
    );
    await db.query(`CREATE TRIGGER opportunity_analysis_invalidate_current
      AFTER UPDATE OF source_content_fingerprint, source_content_version ON opportunities
      FOR EACH ROW WHEN NEW.source_content_fingerprint IS NOT OLD.source_content_fingerprint
        OR NEW.source_content_version IS NOT OLD.source_content_version
      BEGIN UPDATE opportunities SET current_analysis_id = NULL WHERE id = NEW.id; END`);
  } else {
    await db.query(`CREATE OR REPLACE FUNCTION public.invalidate_opportunity_analysis_current() RETURNS trigger AS $$
      BEGIN
        IF NEW.source_content_fingerprint IS DISTINCT FROM OLD.source_content_fingerprint
          OR NEW.source_content_version IS DISTINCT FROM OLD.source_content_version THEN
          NEW.current_analysis_id := NULL;
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await db.query(
      'DROP TRIGGER IF EXISTS opportunity_analysis_invalidate_current ON opportunities',
    );
    await db.query(`CREATE TRIGGER opportunity_analysis_invalidate_current BEFORE UPDATE OF source_content_fingerprint, source_content_version ON opportunities
      FOR EACH ROW EXECUTE FUNCTION public.invalidate_opportunity_analysis_current()`);
  }
  const view = `SELECT o.id, o.id AS opportunity_id, o.source_id, o.company_id, c.name AS company_name, o.posting_url, o.canonical_url, o.apply_url, o.title, o.locations, o.posted_at, o.expires_at, o.updated_at, o.status AS opportunity_status, o.freshness,
    o.salary_min AS compensation_min, o.salary_max AS compensation_max, o.currency AS compensation_currency,
    a.id AS analysis_id, a.source_content_fingerprint, a.source_content_version, a.analysis_version, a.status AS analysis_status, a.normalized_title, a.seniority, a.function, a.work_mode, a.employment_type,
    a.skills_json, a.eligibility_json, a.compensation_json, a.summary_json, a.countries_json, a.skill_slugs_json,
    LOWER(COALESCE(a.normalized_title, '') || ' ' || COALESCE(a.summary_json, '') || ' ' || COALESCE(a.skill_slugs_json, '') || ' ' || COALESCE(o.locations, '')) AS search_document
    FROM opportunities o JOIN sources s ON s.id = o.source_id LEFT JOIN companies c ON c.id = o.company_id JOIN opportunity_analyses a ON a.id = o.current_analysis_id AND a.opportunity_id = o.id AND a.source_content_fingerprint = o.source_content_fingerprint AND a.source_content_version = o.source_content_version AND a.analysis_version = 'opportunity-analysis/v1'
    WHERE s.public_listing = TRUE AND s.is_active = TRUE
      AND o.status NOT IN ('archived', 'rejected', 'deleted')
      AND (o.expires_at IS NULL OR o.expires_at > CURRENT_TIMESTAMP)
      AND a.status IN ('deterministic', 'enriched')`;
  if (sqlite) {
    await db.query('DROP VIEW IF EXISTS jobgeni_public_catalog_v1');
    await db.query(`CREATE VIEW jobgeni_public_catalog_v1 AS ${view}`);
  } else {
    await db.query(
      `CREATE OR REPLACE VIEW public.jobgeni_public_catalog_v1 AS ${view}`,
    );
  }
}
