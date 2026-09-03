import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'fact_intakes',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class FactIntake extends SmrtObject {
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
