import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'candidate_profile_links',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class CandidateProfileLink extends SmrtObject {
  @field({ type: 'text' })
  profileKey = 'default';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'text' })
  href = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
