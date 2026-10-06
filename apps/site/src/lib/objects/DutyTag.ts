import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'duty_tags',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class DutyTag extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text', required: true })
  dutyId = '';
  @crossPackageRef('@happyvertical/smrt-tags:Tag', {
    idType: 'text',
    required: true,
    validate: true,
  })
  tagId = '';
  @field({ type: 'text', required: true })
  tagRole = 'skill';
}
