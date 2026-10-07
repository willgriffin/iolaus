import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
@smrt({
  tableName: 'skill_terms',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class SkillTerm extends SmrtObject {
  // `SmrtObject.slug` is framework-owned; canonical vocabulary uses a
  // separate natural key rather than overriding that accessor.
  @field({ type: 'text' }) skillSlug = '';
  @field({ type: 'text' }) label = '';
  @field({ type: 'text' }) aliasesJson = '[]';
  @field({ type: 'text' }) category = '';
  @field({ type: 'text' }) parentSlug = '';
  @field({ type: 'text' }) relatedJson = '[]';
  @field({ type: 'text' }) status = 'seed';
  @field({ type: 'integer' }) occurrenceCount = 0;
}
