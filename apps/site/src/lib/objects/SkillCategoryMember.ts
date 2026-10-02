import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'skill_category_members',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class SkillCategoryMember extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text', required: true })
  categoryId = '';
  @crossPackageRef('@happyvertical/smrt-tags:Tag', {
    idType: 'text',
    required: true,
    validate: true,
  })
  tagId = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'boolean' })
  useOnResume = true;
  @field({ type: 'decimal' })
  sortOrder = 0;
}
