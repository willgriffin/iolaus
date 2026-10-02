import { getTenantScopedConfig } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { Achievement } from './Achievement.js';
import { AgentRun } from './AgentRun.js';
import { Experience } from './Experience.js';

describe('private evidence graph model scope', () => {
  it.each([
    ['Achievement', Achievement],
    ['AgentRun', AgentRun],
    ['Experience', Experience],
  ])('%s materializes the full private workspace key', (className, RecordClass) => {
    const record = new RecordClass();

    expect(record).toMatchObject({
      candidateProfileId: '',
      ownerUserId: '',
      tenantId: '',
    });
    expect(getTenantScopedConfig(className)).toMatchObject({
      autoFilter: true,
      autoPopulate: true,
      field: 'tenantId',
      mode: 'required',
    });
  });
});
