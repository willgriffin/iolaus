import { describe, expect, it } from 'vitest';
import { registerForeignTask } from './api-exposure-collision-fixture.js';

/**
 * The registry lets two packages register the same simple class name, but
 * collection registration and the MCP generator resolve by simple name. The
 * exposure walk must fail closed. The registry lives on `globalThis`, so each
 * registration order gets its own spec file for real isolation; the
 * foreign-first order lives in api-exposure-collision-foreign-first.spec.ts.
 */
describe('exposure ambiguity guard (site registered first)', () => {
  it('fails closed when a foreign package registers a site class name', async () => {
    await import('../objects/index.js');
    await registerForeignTask();
    const { listExposureCandidates } = await import('./api-exposure.js');
    expect(() => listExposureCandidates()).toThrow(
      /Ambiguous exposed class Task/,
    );
  });
});
