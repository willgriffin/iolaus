import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Operator override of one user's hosted-AI spend caps. A null cap inherits
 * the deployment default (`IOLAUS_AI_USER_*_CAP_MICROS`); zero removes the cap
 * for this user. Maintained only by the operator script.
 */
@smrt({
  tableName: 'ai_user_budgets',
  conflictColumns: ['tenant_id', 'owner_user_id'],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
export class AiUserBudget extends SmrtObject {
  @field({ type: 'text', required: true })
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'integer', nullable: true })
  lifetimeCapMicros: number | null = null;
  @field({ type: 'integer', nullable: true })
  monthlyCapMicros: number | null = null;
  @field({ type: 'text' })
  note = '';
}
