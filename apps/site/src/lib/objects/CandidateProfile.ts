import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'candidate_profiles',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class CandidateProfile extends SmrtObject {
  @field({ type: 'text' })
  profileKey = 'default';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  firstName = '';
  @field({ type: 'text' })
  lastName = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  email = '';
  // Contact and identity facts reused to seed ATS application forms. These
  // stay private: never include them in WebMCP or other broad read surfaces.
  @field({ type: 'text' })
  phone = '';
  @field({ type: 'text' })
  location = '';
  @field({ type: 'text' })
  linkedinUrl = '';
  @field({ type: 'text' })
  githubUrl = '';
  @field({ type: 'text' })
  workAuthorization = '';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'boolean' })
  active = true;
  @field({ type: 'boolean' })
  isDefault = false;
}
