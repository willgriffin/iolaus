import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_tailoring_configs',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeTailoringConfig extends SmrtObject {
  @field({ type: 'text' })
  configSlug = '';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  company = '';
  @field({ type: 'text' })
  configJson = '{}';
  @field({ type: 'boolean' })
  active = true;
}
