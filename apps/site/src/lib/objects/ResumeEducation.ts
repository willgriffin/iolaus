import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_education',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeEducation extends SmrtObject {
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  institution = '';
  @field({ type: 'text' })
  detail = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
