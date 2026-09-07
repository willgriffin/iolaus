import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

@smrt({
  tableName: 'duty_tags',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class DutyTag extends SmrtObject {
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
