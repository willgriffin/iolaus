import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

@smrt({
  tableName: 'skill_category_members',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class SkillCategoryMember extends SmrtObject {
  @field({ type: 'text' })
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
