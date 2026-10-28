import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'fact_intakes',
  // Raw candidate-provided text is private input and must never be exposed by
  // a generated data surface.
  // Candidate-owned record: the generic REST, CLI and MCP surfaces scope every
  // read and write to the verified workspace subject (scoped-resource-crud.ts)
  // and keep this class's guards; see docs/surface-parity.md.
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
@TenantScoped()
export class FactIntake extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
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
