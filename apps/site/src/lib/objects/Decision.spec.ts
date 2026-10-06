import { getTenantScopedConfig } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { Decision } from './Decision.js';
import { DecisionTag } from './DecisionTag.js';

describe('private human decision models', () => {
  it.each([
    ['Decision', Decision],
    ['DecisionTag', DecisionTag],
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

  it('keeps a personal rating on the decision record', () => {
    expect(new Decision().humanRating).toBeNull();
  });
});
