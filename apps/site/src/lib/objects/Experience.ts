import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'experiences',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class Experience extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  experienceKey = '';
  @field({ type: 'text' })
  url = '';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'datetime', nullable: true })
  startDate: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  endDate: Date | null = null;
  @field({ type: 'text' })
  startPrecision = 'year';
  @field({ type: 'text' })
  endPrecision = 'year';
  @field({ type: 'decimal' })
  weight = 0;
  @field({ type: 'decimal' })
  sortOrder = 0;
}
