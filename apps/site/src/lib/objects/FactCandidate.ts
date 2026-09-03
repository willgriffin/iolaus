import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'fact_candidates',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class FactCandidate extends SmrtObject {
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
