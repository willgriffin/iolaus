import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'preference_rules',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class PreferenceRule extends SmrtObject {
  @field({ type: 'text' })
  category = 'scoring';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  description = '';
  @field({ type: 'decimal' })
  weight = 0;
  @field({ type: 'boolean' })
  isHardFilter = false;
  @field({ type: 'text' })
  ruleJson = '{}';
  @field({ type: 'boolean' })
  active = true;
}
