import { describe, expect, it } from 'vitest';
import {
  containsRequiredRoleGrants,
  inspectLegacyNativeBackfill,
  requiredRoleGrants,
} from './db-release-inspectors.js';
import { releaseCatalog } from './db-release-catalog.js';
import { legacyPersonalResumeBackfillsEnabled } from './legacy-personal-resume-backfill.js';
import { releaseStepChecksum } from './db-release-executor.js';

describe('reconciled release inspection', () => {
  it('matches scoped grants and normalized public read aliases', () => {
    expect([
      ...requiredRoleGrants(
        ['companies.read', 'companies.update', 'opportunities.read'],
        ['companies.*'],
      ),
    ]).toEqual(['companies.read', 'companies.update']);
    expect([
      ...requiredRoleGrants(
        ['companies.read', 'companies.update'],
        ['companies.get'],
      ),
    ]).toEqual(['companies.read']);
  });
  it('requires every expected grant while preserving additive operator grants', () => {
    const expected = requiredRoleGrants(
      ['companies.read', 'overviews.personalize'],
      ['companies.read'],
    );
    expect(containsRequiredRoleGrants(['companies.read'], expected)).toBe(
      false,
    );
    expect(
      containsRequiredRoleGrants(
        ['companies.read', 'overviews.personalize', 'operator.custom'],
        expected,
      ),
    ).toBe(true);
  });
  it('does not treat an absent legacy marker as evidence a partial import never ran', async () => {
    let calls = 0;
    const result = await inspectLegacyNativeBackfill({
      query: async () => ({
        rows: calls++ === 0 ? [] : [{ id: 'legacy-input' }],
        rowCount: 0,
      }),
    });
    expect(result.outcome).toBe('needs-repair');
    expect(calls).toBe(2);
  });
  it('imports a historical marker or verifies there are no reachable input effects', async () => {
    expect(
      (
        await inspectLegacyNativeBackfill({
          query: async () => ({ rows: [{ present: true }], rowCount: 1 }),
        })
      ).outcome,
    ).toBe('complete');
    const empty = await inspectLegacyNativeBackfill({
      query: async () => ({ rows: [], rowCount: 0 }),
    });
    expect(empty).toEqual({
      outcome: 'complete',
      checkpoint: { reason: 'empty-legacy-input' },
    });
  });
  it('permanently excludes personal resume and asset imports from the catalog', () => {
    expect(legacyPersonalResumeBackfillsEnabled()).toBe(false);
    const steps = releaseCatalog({} as never);
    expect(
      steps.some((step) =>
        /resume-admin|resume-source|asset-files/.test(step.id),
      ),
    ).toBe(false);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    for (const step of steps)
      expect(releaseStepChecksum(step)).toMatch(/^[0-9a-f]{64}$/);
  });
});
