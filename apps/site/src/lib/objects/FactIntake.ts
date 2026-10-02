import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'fact_intakes',
  // Raw candidate-provided text is private input and must never be exposed by
  // a generated data surface.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class FactIntake extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text' })
  ownerUserId = '';
  @field({ type: 'text' })
  candidateProfileId = '';
  @field({ type: 'text' })
  sourceKind = 'story';
  @field({ type: 'text' })
  targetEntityType = '';
  @field({ type: 'text' })
  targetEntityId = '';
  @field({ type: 'text' })
  status = 'draft';
  @field({ type: 'text' })
  rawText = '';
  @field({ type: 'text' })
  intakeContext = '';
  @field({ type: 'text' })
  extractedCandidatesJson = '[]';
  @field({ type: 'text' })
  createdByUserId = '';
  @field({ type: 'text' })
  createdByProfileId = '';
  @field({ type: 'datetime', nullable: true })
  extractedAt: Date | null = null;
  @field({ type: 'text' })
  notes = '';
}
