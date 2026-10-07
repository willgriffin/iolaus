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
  const view = `SELECT o.id AS opportunity_id, o.company_id, o.posting_url, o.apply_url, o.title, o.locations, o.posted_at, o.expires_at, o.status AS opportunity_status, o.freshness,
    o.salary_min AS compensation_min, o.salary_max AS compensation_max, o.currency AS compensation_currency,
    a.id AS analysis_id, a.source_content_fingerprint, a.source_content_version, a.analysis_version, a.status AS analysis_status, a.normalized_title, a.seniority, a.function, a.work_mode, a.employment_type,
    a.skills_json, a.eligibility_json, a.compensation_json, a.summary_json, a.countries_json, a.skill_slugs_json,
    LOWER(COALESCE(a.normalized_title, '') || ' ' || COALESCE(a.summary_json, '') || ' ' || COALESCE(a.skill_slugs_json, '') || ' ' || COALESCE(o.locations, '')) AS search_document
    FROM opportunities o JOIN sources s ON s.id = o.source_id JOIN opportunity_analyses a ON a.id = o.current_analysis_id AND a.opportunity_id = o.id AND a.source_content_fingerprint = o.source_content_fingerprint AND a.source_content_version = o.source_content_version AND a.analysis_version = 'opportunity-analysis/v1'
    WHERE s.public_listing = TRUE AND s.is_active = TRUE AND a.status IN ('deterministic', 'enriched')`;
  if (sqlite) {
    await db.query('DROP VIEW IF EXISTS jobgeni_public_catalog_v1');
    await db.query(`CREATE VIEW jobgeni_public_catalog_v1 AS ${view}`);
  } else {
    await db.query(
      `CREATE OR REPLACE VIEW public.jobgeni_public_catalog_v1 AS ${view}`,
    );
  }
}
