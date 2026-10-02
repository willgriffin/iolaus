import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * A machine-generated, candidate-private view of a global opportunity. This
 * model deliberately excludes generated/public data surfaces: callers obtain
 * it only through server-side workspace ownership checks.
 */
@smrt({
  tableName: 'opportunity_assessments',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class OpportunityAssessment extends SmrtObject {
  @field({ type: 'text' })
  tenantId = '';
  @field({ type: 'text' })
  ownerUserId = '';
  @field({ type: 'text' })
  candidateProfileId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  assessmentFingerprint = '';
  @field({ type: 'text' })
  candidateMaterialFingerprint = '';
  @field({ type: 'text' })
  sourceContentFingerprint = '';
  @field({ type: 'integer' })
  sourceContentVersion = 0;
  @field({ type: 'text' })
  contractVersion = '';
  @field({ type: 'text' })
  model = '';
  @field({ type: 'text' })
  provider = '';
  /** Full source-attributed output is private candidate context. */
  @field({ type: 'text', sensitive: true })
  assessmentJson = '{}';
  /** UI-safe projection has no raw resume or posting passages. */
  @field({ type: 'text' })
  projectionJson = '{}';
  @field({ type: 'text' })
  status = 'current';
  @field({ type: 'text' })
  agentRunId = '';
}
