import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'education',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class Education extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  profileKey = 'default';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  institution = '';
  @field({ type: 'text' })
  detail = '';
  @field({ type: 'datetime', nullable: true })
  startDate: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  endDate: Date | null = null;
  /** ISO input precision is retained so imported YYYY/MM dates are never presented as exact days. */
  @field({ type: 'text' })
  startPrecision = 'year';
  @field({ type: 'text' })
  endPrecision = 'year';
  @field({ type: 'decimal' })
  sortOrder = 0;
  @field({ type: 'boolean' })
  useOnResume = true;
}
