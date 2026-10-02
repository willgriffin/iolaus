import { describe, expect, it } from 'vitest';
import { Application } from './Application.js';

describe('Application TaskRunner dispatch', () => {
  it('rejects a shape-only fake execution context before reading queued args', async () => {
    const application = new Application();
    application.id = 'application-1';

    await expect(
      application.autoSubmit(
        {
          runtimeWorkspaceSubject: {
            profileId: 'profile-1',
            tenantId: 'tenant-1',
            userId: 'user-1',
          },
        },
        { job: { tenantId: 'tenant-1' }, logger: {} } as never,
      ),
    ).rejects.toThrow('active TaskRunner execution context');
  });
});
