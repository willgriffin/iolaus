import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'agent_runs',
  // Agent runs are system-authored audit records. Workflow services create and
  // advance them internally; public data surfaces can only inspect them.
  // Candidate-owned record: the generic REST, CLI and MCP surfaces scope every
  // read and write to the verified workspace subject (scoped-resource-crud.ts)
  // and keep this class's guards; see docs/surface-parity.md.
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
@TenantScoped()
export class AgentRun extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  runType = 'other';
  @field({ type: 'text' })
  status = 'queued';
  @field({ type: 'text' })
  actorProfileId = '';
  @field({ type: 'text' })
  initiatedByUserId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  applicationId = '';
  @field({ type: 'text' })
  taskId = '';
  @field({ type: 'text' })
  organizationProfileId = '';
  @field({ type: 'text' })
  sourceId = '';
  @field({ type: 'text' })
  externalActionType = '';
  @field({ type: 'text' })
  approvalSnapshotJson = '{}';
  @field({ type: 'text' })
  inputJson = '{}';
  @field({ type: 'text' })
  outputJson = '{}';
  @field({ type: 'text' })
  error = '';
  @field({ type: 'integer' })
  intelligenceCallLimit = 0;
  @field({ type: 'integer' })
  intelligenceInputTokenLimit = 0;
  @field({ type: 'integer' })
  intelligenceSpendLimitMicros = 0;
  @field({ type: 'integer' })
  intelligenceReservedCalls = 0;
  @field({ type: 'integer' })
  intelligenceReservedInputTokens = 0;
  @field({ type: 'integer' })
  intelligenceReservedSpendMicros = 0;
  @field({ type: 'integer' })
  intelligenceActualCalls = 0;
  @field({ type: 'integer' })
  intelligenceActualInputTokens = 0;
  @field({ type: 'integer' })
  intelligenceActualOutputTokens = 0;
  @field({ type: 'integer' })
  intelligenceActualSpendMicros = 0;
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  finishedAt: Date | null = null;
}
