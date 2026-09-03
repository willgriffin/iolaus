import { describe, expect, it } from 'vitest';
import { registerForeignTask } from './api-exposure-collision-fixture.js';

/**
 * Foreign-first ordering; see api-exposure-collision-site-first.spec.ts.
 * In this order the registry's own collision policy rejects the later site
 * registration, so the failure surfaces at import time rather than in the
 * exposure walk. Either way the process fails closed instead of binding a
 * foreign constructor by insertion order.
 */
describe('exposure ambiguity guard (foreign registered first)', () => {
  it('fails closed when the foreign registration precedes the site classes', async () => {
    await registerForeignTask();
    await expect(
      (async () => {
        await import('../objects/index.js');
        const { listExposureCandidates } = await import('./api-exposure.js');
        listExposureCandidates();
      })(),
    ).rejects.toThrow(/Class Name Collision|Ambiguous exposed class Task/);
  });
});
