import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'fact_candidates',
  // Extracted statements and their review decisions are private candidate
  // context. The fact workflow owns their subject-scoped access.
  // Candidate-owned record: the generic REST, CLI and MCP surfaces scope every
  // read and write to the verified workspace subject (scoped-resource-crud.ts)
  // and keep this class's guards; see docs/surface-parity.md.
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
@TenantScoped()
export class FactCandidate extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
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
