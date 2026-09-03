import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_profiles',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeProfile extends SmrtObject {
  @field({ type: 'text' })
  profileKey = 'default';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  email = '';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'boolean' })
  active = true;
}
