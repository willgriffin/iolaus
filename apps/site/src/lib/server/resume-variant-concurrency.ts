import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';

type ResumeVariantRecord = Record<string, unknown>;

const resumeVariantColumnByField = {
  applicationId: 'application_id',
  candidateProfileId: 'candidate_profile_id',
  companyId: 'company_id',
  emphasizeTags: 'emphasize_tags',
  excludePositionIds: 'exclude_position_ids',
  excludeTags: 'exclude_tags',
  generatedAt: 'generated_at',
  generatedPath: 'generated_path',
  htmlPath: 'html_path',
  includePositionIds: 'include_position_ids',
  markdownPath: 'markdown_path',
  name: 'name',
  notes: 'notes',
  opportunityId: 'opportunity_id',
  outputSlug: 'output_slug',
  pdfPath: 'pdf_path',
  resumeAssetId: 'resume_asset_id',
  sourceVariantId: 'source_variant_id',
  status: 'status',
  summaryOverride: 'summary_override',
  tailoringConfigId: 'tailoring_config_id',
  tailoringConfigPath: 'tailoring_config_path',
  textPath: 'text_path',
  titleOverride: 'title_override',
} as const;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function valuesAreEquivalent(left: unknown, right: unknown): boolean {
  const leftDate = dateValue(left);
  const rightDate = dateValue(right);
  if (leftDate && rightDate) {
    return leftDate.getTime() === rightDate.getTime();
  }
  return left === right;
}

/**
 * Persists a generated resume variant only if the record observed before
 * rendering has not changed. Generation takes enough time that a normal
 * admin edit must win over a stale worker rather than be overwritten.
 */
export async function commitResumeVariantIfCurrent(
  persistedState: ResumeVariantRecord,
  variant: ResumeVariantRecord,
  databaseOverride?: Awaited<ReturnType<typeof resolveDatabase>>,
): Promise<boolean> {
  const id = stringValue(persistedState.id);
  const expectedUpdatedAt = dateValue(persistedState.updated_at);
  if (!id || !expectedUpdatedAt || stringValue(variant.id) !== id) {
    return false;
  }

  const databaseUpdates = Object.fromEntries(
    Object.entries(resumeVariantColumnByField)
      .filter(([field]) => {
        const value = variant[field];
        return (
          value !== undefined &&
          !valuesAreEquivalent(persistedState[field], value)
        );
      })
      .map(([field, column]) => [column, variant[field]]),
  );
  if (Object.keys(databaseUpdates).length === 0) return true;
  const database = databaseOverride ?? (await resolveDatabase(getDbConfig()));
  const result = await database.update(
    'resume_variants',
    {
      id,
      updated_at: expectedUpdatedAt,
    },
    {
      ...databaseUpdates,
      updated_at: new Date(),
    },
  );
  return result.affected > 0;
}
