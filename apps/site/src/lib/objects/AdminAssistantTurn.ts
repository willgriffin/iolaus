import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export type AdminAssistantTurnStatus =
  | 'reserved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked';

/**
 * Durable, private accounting and idempotency state for one administrative
 * assistant turn. ChatMessage remains the transcript; this row is the sole
 * authority for retrying a client request without re-running a paid turn.
 */
@smrt({
  tableName: 'admin_assistant_turns',
  conflictColumns: [
    'tenant_id',
    'owner_user_id',
    'candidate_profile_id',
    'thread_id',
    'client_request_id',
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
@TenantScoped()
export class AdminAssistantTurn extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text', required: true })
  threadId = '';
  @field({ type: 'text', required: true, sensitive: true })
  clientRequestId = '';
  @field({ type: 'text', required: true, sensitive: true })
  contentHash = '';
  @field({ type: 'text', required: true })
  agentSessionId = '';
  @field({ type: 'text' })
  status: AdminAssistantTurnStatus = 'reserved';
  @field({ type: 'text', nullable: true, sensitive: true })
  userMessageId: string | null = null;
  @field({ type: 'text', nullable: true, sensitive: true })
  assistantMessageId: string | null = null;
  @field({ type: 'text', sensitive: true })
  requestId = '';
  @field({ type: 'text', nullable: true, sensitive: true })
  providerRequestId: string | null = null;
  @field({ type: 'text' })
  profile = '';
  @field({ type: 'text' })
  model = '';
  @field({ type: 'text' })
  provider = 'bifrost';
  @field({ type: 'integer' })
  estimatedInputTokens = 0;
  @field({ type: 'integer' })
  maxOutputTokens = 0;
  @field({ type: 'integer' })
  reservedSpendMicros = 0;
  @field({ type: 'integer' })
  actualInputTokens = 0;
  @field({ type: 'integer' })
  actualOutputTokens = 0;
  @field({ type: 'integer' })
  actualTotalTokens = 0;
  @field({ type: 'integer' })
  actualSpendMicros = 0;
  @field({ type: 'text' })
  accountingBasis = '';
  @field({ type: 'text', sensitive: true })
  errorCode = '';
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  finishedAt: Date | null = null;
}
