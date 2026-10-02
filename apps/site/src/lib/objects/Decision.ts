import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'decisions',
  // A human decision contains a candidate's private preferences and should
  // only be reached through a verified workspace workflow.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class Decision extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  applicationId = '';
  @field({ type: 'text' })
  taskId = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  evaluationScoreId = '';
  @field({ type: 'text' })
  agentRunId = '';
  @field({ type: 'text' })
  deciderProfileId = '';
  @field({ type: 'text' })
  deciderUserId = '';
  @field({ type: 'text' })
  decisionBy = 'owner';
  @field({ type: 'text' })
  decision = 'defer';
  @field({ type: 'text' })
  reason = '';
  /** Optional personal priority rating recorded with the human decision. */
  @field({ type: 'integer', nullable: true })
  humanRating: number | null = null;
  @field({ type: 'text' })
  previousStatus = '';
  @field({ type: 'text' })
  newStatus = '';
  @field({ type: 'text' })
  decisionTags = '';
}
