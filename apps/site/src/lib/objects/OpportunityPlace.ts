import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'opportunity_places',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class OpportunityPlace extends SmrtObject {
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  placeId = '';
  @field({ type: 'text' })
  placeRole = 'job_location';
}
