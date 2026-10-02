import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'fact_candidates',
  // Extracted statements and their review decisions are private candidate
  // context. The fact workflow owns their subject-scoped access.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class FactCandidate extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text' })
  ownerUserId = '';
  @field({ type: 'text' })
  candidateProfileId = '';
  @field({ type: 'text' })
  factIntakeId = '';
  @field({ type: 'text' })
  targetEntityType = '';
  @field({ type: 'text' })
  targetEntityId = '';
  @field({ type: 'text' })
  statement = '';
  @field({ type: 'text' })
  editedStatement = '';
  @field({ type: 'text' })
  factType = 'assertion';
  @field({ type: 'text' })
  sourceExcerpt = '';
  @field({ type: 'decimal', nullable: true })
  confidence: number | null = null;
  @field({ type: 'text' })
  reviewStatus = 'pending';
  @field({ type: 'text' })
  createdFactId = '';
  @field({ type: 'text' })
  reviewedByUserId = '';
  @field({ type: 'text' })
  reviewedByProfileId = '';
  @field({ type: 'datetime', nullable: true })
  reviewedAt: Date | null = null;
  @field({ type: 'text' })
  notes = '';
}
