import { describe, expect, it, vi } from 'vitest';
import { getAiUsageSummary } from '$lib/server/ai-usage-guard';

vi.mock('$lib/admin/resources', () => ({ adminResources: [] }));
vi.mock('$lib/server/admin-assistant-config', () => ({
  isAdminAssistantEnabled: () => false,
}));
vi.mock('$lib/server/ai-usage-guard', () => ({
  getAiUsageSummary: vi.fn(async () => null),
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

describe('hosted AI budget indicator', () => {
  const summary = (overrides: Record<string, unknown>) =>
    ({
      capped: true,
      disabled: false,
      lifetimeCapMicros: 0,
      lifetimeSpentMicros: 0,
      monthlyCapMicros: 0,
      monthlySpentMicros: 0,
      remainingLabel: '$1.250 AI budget left',
      remainingMicros: 1_250_000,
      ...overrides,
    }) as never;

  it('shows the remaining budget for the verified user only', async () => {
    vi.mocked(getAiUsageSummary).mockResolvedValueOnce(summary({}));
    const data = await read({ workspaceSubject: subject });
    expect(data.aiBudget).toMatchObject({ label: '$1.250 AI budget left' });
    expect(getAiUsageSummary).toHaveBeenLastCalledWith(subject);
    vi.mocked(getAiUsageSummary).mockClear();
    expect((await read({ tenantId: 'untrusted' })).aiBudget).toBeNull();
    expect(getAiUsageSummary).not.toHaveBeenCalled();
  });

  it('says so when the budget is used up or AI is paused', async () => {
    vi.mocked(getAiUsageSummary).mockResolvedValueOnce(
      summary({ remainingLabel: '$0.000 AI budget left', remainingMicros: 0 }),
    );
    expect((await read({ workspaceSubject: subject })).aiBudget).toMatchObject({
      exhausted: true,
      label: 'AI budget used up',
    });
    vi.mocked(getAiUsageSummary).mockResolvedValueOnce(
      summary({ capped: false, disabled: true, remainingMicros: null }),
    );
    expect((await read({ workspaceSubject: subject })).aiBudget).toMatchObject({
      disabled: true,
      label: 'AI paused',
    });
  });

  it('never breaks the shell when the ledger is unavailable', async () => {
    vi.mocked(getAiUsageSummary).mockRejectedValueOnce(new Error('db down'));
    expect((await read({ workspaceSubject: subject })).aiBudget).toBeNull();
  });
});
