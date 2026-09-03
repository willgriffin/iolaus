import { describe, expect, it } from 'vitest';
import { load } from './+page.server';

describe('/admin task workspace route', () => {
  it('redirects the root admin alias to the canonical task route', async () => {
    await expect(load({} as never)).rejects.toMatchObject({
      location: '/admin/tasks',
      status: 307,
    });
  });
});
