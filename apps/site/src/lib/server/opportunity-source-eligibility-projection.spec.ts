import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SourceEligibilityEvidence,
  sourceEligibilityFactKey,
} from './source-eligibility-facts.js';

const loadEvidence = vi.fn();
vi.mock('./resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: loadEvidence,
}));

beforeEach(() => {
  loadEvidence.mockReset();
});

const source = 'Remote from Canada. No visa sponsorship is available.';
const CA = { code: 'CA', label: 'Canada' };

function evidence(): SourceEligibilityEvidence {
  const citation = (text: string) => ({
    clauseId: 'source:1',
    start: source.indexOf(text),
    end: source.indexOf(text) + text.length,
    hash: createHash('sha256').update(text).digest('hex'),
  });
  const country = { kind: 'work_country_allowed' as const, country: CA };
  const remote = { kind: 'remote_available' as const };
  return {
    version: 'source-eligibility-facts/v1',
    aggregateFingerprint: 'aggregate:1',
    requestId: 'request:1',
    sourceContentFingerprint: 'source:1',
    sourceContentVersion: 1,
    coverage: { authorization: true, geography: true, workArrangement: true },
    facts: [
      {
        ...country,
        key: sourceEligibilityFactKey(country),
        citations: [citation('Remote from Canada.')],
      },
      {
        ...remote,
        key: sourceEligibilityFactKey(remote),
        citations: [citation('Remote from Canada.')],
      },
    ],
  };
}

describe('current source eligibility projections', () => {
  it('uses a current GLOBAL-reader receipt with only the active typed profile', async () => {
    loadEvidence.mockResolvedValue({
      candidate: {
        authorizedWorkCountriesJson: JSON.stringify([
          { country: CA, scope: 'country' },
        ]),
        targetWorkCountryJson: JSON.stringify(CA),
      },
    });
    const { loadCurrentSourceEligibilityProjections } = await import(
      './opportunity-source-eligibility-projection.js'
    );
    const readEvidence = vi.fn().mockResolvedValue({
      evidence: evidence(),
      sourceContext: {
        sourceText: source,
        sourceContentFingerprint: 'source:1',
        sourceContentVersion: 1,
      },
    });
    const result = await loadCurrentSourceEligibilityProjections({
      opportunities: [{ id: 'opp-1' }],
      readEvidence,
      subject: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        profileId: 'profile-1',
      },
    });
    expect(result.get('opp-1')).toMatchObject({
      eligibilityBucket: 'eligible',
      sourceStatus: 'current',
    });
    expect(readEvidence).toHaveBeenCalledWith({ id: 'opp-1' });
  });

  it('does not load private evidence or expose a persisted-looking stale source receipt', async () => {
    loadEvidence.mockResolvedValue({ candidate: {} });
    const { loadCurrentSourceEligibilityProjections } = await import(
      './opportunity-source-eligibility-projection.js'
    );
    const stale = evidence();
    stale.sourceContentVersion = 2;
    const result = await loadCurrentSourceEligibilityProjections({
      opportunities: [{ id: 'opp-1' }],
      readEvidence: vi.fn().mockResolvedValue({
        evidence: stale,
        sourceContext: {
          sourceText: source,
          sourceContentFingerprint: 'source:1',
          sourceContentVersion: 1,
        },
      }),
      subject: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        profileId: 'profile-1',
      },
    });
    expect(result.size).toBe(0);
    expect(loadEvidence).not.toHaveBeenCalled();
  });

  it('fails closed when the GLOBAL receipt reader rejects', async () => {
    const { loadCurrentSourceEligibilityProjections } = await import(
      './opportunity-source-eligibility-projection.js'
    );
    const result = await loadCurrentSourceEligibilityProjections({
      opportunities: [{ id: 'opp-1' }],
      readEvidence: vi
        .fn()
        .mockRejectedValue(new Error('invalid GLOBAL receipt')),
      subject: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        profileId: 'profile-1',
      },
    });
    expect(result.size).toBe(0);
    expect(loadEvidence).not.toHaveBeenCalled();
  });

  it('bounds source receipt reads to four concurrent opportunities', async () => {
    let active = 0;
    let maximum = 0;
    const { loadCurrentSourceEligibilityProjections } = await import(
      './opportunity-source-eligibility-projection.js'
    );
    const result = await loadCurrentSourceEligibilityProjections({
      opportunities: Array.from({ length: 9 }, (_, index) => ({
        id: `opp-${index}`,
      })),
      readEvidence: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return undefined;
      },
      subject: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        profileId: 'profile-1',
      },
    });
    expect(maximum).toBe(4);
    expect(result.size).toBe(0);
    expect(loadEvidence).not.toHaveBeenCalled();
  });

  it('keeps a verified source receipt unknown when the active profile cannot load', async () => {
    loadEvidence.mockImplementation(() => {
      throw new Error('profile missing');
    });
    const { loadCurrentSourceEligibilityProjections } = await import(
      './opportunity-source-eligibility-projection.js'
    );
    const result = await loadCurrentSourceEligibilityProjections({
      opportunities: [{ id: 'opp-1' }],
      readEvidence: vi.fn().mockResolvedValue({
        evidence: evidence(),
        sourceContext: {
          sourceText: source,
          sourceContentFingerprint: 'source:1',
          sourceContentVersion: 1,
        },
      }),
      subject: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        profileId: 'profile-1',
      },
    });
    expect(result.get('opp-1')).toMatchObject({
      eligibilityBucket: 'unknown',
      sourceStatus: 'current',
    });
    expect(loadEvidence).toHaveBeenCalledTimes(1);
  });
});
