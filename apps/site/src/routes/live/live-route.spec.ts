import { describe, expect, it } from 'vitest';
import { GET } from './+server';

describe('liveness route', () => {
  it('remains process-only while readiness dependencies are unavailable', async () => {
    const response = await GET({} as unknown as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
