import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  build: vi.fn(async (..._args: unknown[]) => ({
    format: 'iolaus-account-export',
    ok: true,
  })),
}));

vi.mock('$lib/server/account-export', () => ({
  accountExportFilename: () => 'iolaus-export-2026-10-06.json',
  buildAccountExport: state.build,
}));
vi.mock('$lib/server/app-config', () => ({
  getAppConfig: () => ({ workspaceMode: 'shared' }),
  getConfiguredPublicOrigin: () => 'https://app.example',
}));
vi.mock('$lib/server/resume-files', () => ({
  getResumeFilesystem: async () => ({ exists: async () => true }),
}));

import { GET } from './+server';

const locals = {
  membership: {
    roleId: 'role',
    status: 'active',
    tenantId: 'tenant-a',
    userId: 'user-a',
  },
  tenantId: 'tenant-a',
  user: { email: 'alice@example.invalid', id: 'user-a' },
  workspaceSubject: {
    profileId: 'profile-a',
    tenantId: 'tenant-a',
    userId: 'user-a',
  },
};
const call = async (overrides: Record<string, unknown> = {}) =>
  await (GET as unknown as (e: unknown) => Promise<Response>)({
    locals,
    url: new URL(
      'https://app.example/api/account/export?userId=user-b&tenantId=tenant-b',
    ),
    ...overrides,
  });

describe('GET /api/account/export', () => {
  beforeEach(() => state.build.mockClear());

  it('exports the verified subject as a private attachment, ignoring query ids', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="iolaus-export-2026-10-06.json"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true });
    expect(state.build).toHaveBeenCalledTimes(1);
    expect(state.build.mock.calls[0][0]).toEqual(locals.workspaceSubject);
    expect(state.build.mock.calls[0][1]).toEqual({
      email: 'alice@example.invalid',
    });
  });

  it('refuses a session without a verified workspace subject', async () => {
    await expect(
      call({ locals: { user: { id: 'user-a' } } }),
    ).rejects.toMatchObject({ status: 403 });
    expect(state.build).not.toHaveBeenCalled();
  });
});
