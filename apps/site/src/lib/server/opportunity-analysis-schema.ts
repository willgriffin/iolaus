import { detectEngine, type resolveDatabase } from '@happyvertical/smrt-core';

type Database = Awaited<ReturnType<typeof resolveDatabase>>;

export { pruneExpiredOpportunityAnalyses } from './opportunity-analysis-maintenance.js';

/** Supplemental indexes and the least-privilege public projection.
 * Tables and foreign keys are owned by the SMRT object migration. */
export async function ensureOpportunityAnalysisSchema(
  db: Database,
): Promise<void> {
  const sqlite = Boolean(db.url && detectEngine(db.url) === 'sqlite');
  const indexes = [
    'CREATE UNIQUE INDEX IF NOT EXISTS skill_terms_skill_slug ON skill_terms (skill_slug)',
    'DROP INDEX IF EXISTS opportunity_analyses_current_key',
    'DROP INDEX IF EXISTS opportunity_analyses_identity_key',
    'CREATE UNIQUE INDEX IF NOT EXISTS opportunity_analyses_identity_key ON opportunity_analyses (opportunity_id, source_content_fingerprint, source_content_version, source_content_digest, analysis_version, model, prompt_version, output_schema_version)',
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
      AFTER UPDATE OF source_content_fingerprint, source_content_version, source_content_json ON opportunities
      FOR EACH ROW WHEN NEW.source_content_fingerprint IS NOT OLD.source_content_fingerprint
        OR NEW.source_content_version IS NOT OLD.source_content_version OR NEW.source_content_json IS NOT OLD.source_content_json
      BEGIN UPDATE opportunities SET current_analysis_id = NULL WHERE id = NEW.id; END`);
  } else {
    await db.query(`CREATE OR REPLACE FUNCTION public.invalidate_opportunity_analysis_current() RETURNS trigger AS $$
      BEGIN
        IF NEW.source_content_fingerprint IS DISTINCT FROM OLD.source_content_fingerprint
          OR NEW.source_content_version IS DISTINCT FROM OLD.source_content_version OR NEW.source_content_json IS DISTINCT FROM OLD.source_content_json THEN
          NEW.current_analysis_id := NULL;
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await db.query(
      'DROP TRIGGER IF EXISTS opportunity_analysis_invalidate_current ON opportunities',
    );
    await db.query(`CREATE TRIGGER opportunity_analysis_invalidate_current BEFORE UPDATE OF source_content_fingerprint, source_content_version, source_content_json ON opportunities
      FOR EACH ROW EXECUTE FUNCTION public.invalidate_opportunity_analysis_current()`);
  }
  await db.query(
    `UPDATE opportunities SET current_analysis_id = NULL WHERE current_analysis_id IN (SELECT id FROM opportunity_analyses WHERE source_content_digest = '' OR source_content_digest IS NULL)`,
  );
  const skills = sqlite
    ? `(SELECT COALESCE(json_group_array(json_object('slug', json_extract(value, '$.slug'), 'label', json_extract(value, '$.label'), 'kind', json_extract(value, '$.kind'), 'confidence', json_extract(value, '$.confidence'))), '[]') FROM json_each(a.skills_json))`
    : `(SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', value->>'slug', 'label', value->>'label', 'kind', value->>'kind', 'confidence', value->'confidence')), '[]'::jsonb)::text FROM jsonb_array_elements(a.skills_json::jsonb))`;
  const requirements = sqlite
    ? `(SELECT COALESCE(json_group_array(json_object('hash', json_extract(value, '$.hash'), 'text', json_extract(value, '$.text'), 'kind', json_extract(value, '$.kind'), 'category', json_extract(value, '$.category'), 'years', json_extract(value, '$.years'), 'skills', json(COALESCE(json_extract(value, '$.skills'), '[]')))), '[]') FROM json_each(a.requirements_json))`
    : `(SELECT COALESCE(jsonb_agg(jsonb_build_object('hash', value->>'hash', 'text', value->>'text', 'kind', value->>'kind', 'category', value->>'category', 'years', value->'years', 'skills', COALESCE(value->'skills', '[]'::jsonb))), '[]'::jsonb)::text FROM jsonb_array_elements(a.requirements_json::jsonb))`;
  const sourceText = (field: string) =>
    sqlite
      ? `CASE WHEN json_valid(o.source_content_json) THEN CASE WHEN json_type(o.source_content_json, '$.${field}') = 'text' THEN json_extract(o.source_content_json, '$.${field}') END END`
      : `CASE WHEN o.source_content_json IS JSON OBJECT THEN CASE WHEN jsonb_typeof(o.source_content_json::jsonb->'${field}') = 'string' THEN o.source_content_json::jsonb->>'${field}' END END`;
  const sourceLocation = sourceText('locationNotes');
  // Read enough extra text to redact a contact token crossing the public cap;
  // the response sanitizer applies the actual 30k/12k contract limits.
  const sourceExcerpt = (field: string, maximum: number) =>
    `substr(${sourceText(field)}, 1, ${maximum + 512})`;
  // Public catalog membership fails closed outside known live lifecycle stages.
  // `active` and `new` are retained for imported catalog records.
  const view = `SELECT o.id, o.id AS opportunity_id, o.source_id, o.company_id, c.name AS company_name, o.posting_url, o.canonical_url, o.apply_url, a.normalized_title AS title, COALESCE(NULLIF(TRIM(o.locations), ''), NULLIF(TRIM(${sourceLocation}), '')) AS locations, o.posted_at, o.expires_at, o.updated_at, o.status AS opportunity_status, o.freshness,
    CAST(NULL AS DOUBLE PRECISION) AS compensation_min, CAST(NULL AS DOUBLE PRECISION) AS compensation_max, '' AS compensation_currency,
    a.id AS analysis_id, a.source_content_fingerprint, a.source_content_version, a.analysis_version, a.status AS analysis_status, a.normalized_title, a.seniority, a.function, a.work_mode, a.employment_type,
    ${skills} AS skills_json, a.eligibility_json, a.compensation_json, a.summary_json, a.countries_json, a.skill_slugs_json,
    LOWER(COALESCE(a.normalized_title, '') || ' ' || COALESCE(c.name, '') || ' ' || COALESCE(a.summary_json, '') || ' ' || COALESCE(a.skill_slugs_json, '') || ' ' || COALESCE(a.countries_json, '')) AS search_document, ${requirements} AS requirements_json,
    ${sourceExcerpt('descriptionRaw', 30_000)} AS description_text, ${sourceExcerpt('qualifications', 12_000)} AS qualifications_text
    FROM opportunities o JOIN sources s ON s.id = o.source_id LEFT JOIN companies c ON CAST(c.id AS TEXT) = o.company_id JOIN opportunity_analyses a ON a.id = o.current_analysis_id AND a.opportunity_id = o.id AND a.source_content_fingerprint = o.source_content_fingerprint AND a.source_content_version = o.source_content_version AND a.analysis_version = 'opportunity-analysis/v1'
    WHERE s.public_listing = TRUE AND s.is_active = TRUE
      AND o.status IN ('found', 'recommended', 'apply', 'applied', 'interviewing', 'offer', 'maybe', 'needs_input', 'active', 'new')
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
