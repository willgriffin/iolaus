import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isSharedHosted: vi.fn() }));

vi.mock('../src/lib/server/app-config.js', () => ({
  isSharedHosted: mocks.isSharedHosted,
}));

import {
  assertLegacyPersonalResumeBackfillsEnabled,
  legacyPersonalResumeBackfillsEnabled,
} from './legacy-personal-resume-backfill.js';

describe('legacy personal resume backfill mode', () => {
  beforeEach(() => {
    mocks.isSharedHosted.mockReset();
    mocks.isSharedHosted.mockReturnValue(false);
  });

  it('fails closed in private mode until a subject-bound importer is used', () => {
    expect(legacyPersonalResumeBackfillsEnabled()).toBe(false);
    expect(assertLegacyPersonalResumeBackfillsEnabled).toThrow(
      'unavailable in private mode',
    );
  });

  it('fails closed in a fresh shared installation', () => {
    mocks.isSharedHosted.mockReturnValue(true);

    expect(legacyPersonalResumeBackfillsEnabled()).toBe(false);
    expect(assertLegacyPersonalResumeBackfillsEnabled).toThrow(
      'unavailable in shared hosted mode',
    );
  });
});
