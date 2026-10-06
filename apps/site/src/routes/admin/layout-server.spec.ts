import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/admin/resources', () => ({ adminResources: [] }));
vi.mock('$lib/server/admin-assistant-config', () => ({
  isAdminAssistantEnabled: () => false,
}));
vi.mock('$lib/server/app-config', () => ({
  getAppConfig: () => ({ appMark: 'I', appName: 'Iolaus' }),
}));

import { load } from './+layout.server';

const subject = {
  tenantId: 'tenant-one',
  userId: 'user-one',
  profileId: 'profile-one',
};
async function read(locals: Record<string, unknown>) {
  return await (
    load as unknown as (event: {
      locals: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>
  )({ locals });
}
describe('admin activity scope disposal key', () => {
  it('is derived only from the hook-verified complete owned tuple', async () => {
    const data = await read({
      workspaceSubject: subject,
      tenantId: 'untrusted-other',
      profileId: 'untrusted-selector',
      user: { id: 'user-one', email: 'owner@example.com' },
    });
    expect(data.activityScopeKey).toBe(
      JSON.stringify(['tenant-one', 'user-one', 'profile-one']),
    );
    expect(data.assistantEnabled).toBe(false);
  });
  it('changes for each tenant, user, or selected profile switch', async () => {
    const original = (await read({ workspaceSubject: subject }))
      .activityScopeKey;
    for (const key of ['tenantId', 'userId', 'profileId']) {
      expect(
        (await read({ workspaceSubject: { ...subject, [key]: `${key}-two` } }))
          .activityScopeKey,
      ).not.toBe(original);
    }
  });
  it('does not invent a key from unverified selectors or a missing candidate profile', async () => {
    expect(
      (
        await read({
          tenantId: 'tenant-one',
          profileId: 'profile-one',
          user: { id: 'user-one' },
        })
      ).activityScopeKey,
    ).toBeNull();
    expect(
      (
        await read({
          workspaceSubject: { tenantId: 'tenant-one', userId: 'user-one' },
        })
      ).activityScopeKey,
    ).toBeNull();
  });
});
