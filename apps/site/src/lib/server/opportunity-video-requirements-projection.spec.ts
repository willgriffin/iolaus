import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCurrentOpportunityVideoRequirementsEvidence: vi.fn(),
}));

vi.mock('./opportunity-requirement-coverage-provider.js', () => ({
  readCurrentOpportunityVideoRequirementsEvidence:
    mocks.readCurrentOpportunityVideoRequirementsEvidence,
}));

import {
  loadCurrentOpportunityVideoRequirementsProjections,
  projectCurrentOpportunityVideoRequirements,
} from './opportunity-video-requirements-projection.js';

const opportunity = {
  id: 'opportunity-1',
  sourceContentFingerprint: 'source-current',
  sourceContentVersion: 4,
};
const receipt = {
  requestId: 'global-request-1',
  compositeInputFingerprint: 'composite-current',
  sourceContentFingerprint: 'source-current',
  sourceContentVersion: 4,
  videoRequirements: {
    version: 'opportunity-video-requirements/v2' as const,
    fingerprint: 'leaf-current',
    source: {
      sourceContentFingerprint: 'source-current',
      sourceContentVersion: 4,
    },
    provenance: { provider: 'typesafe', model: 'jev-test' },
    recordedSubmission: {
      kind: 'recorded_application_video' as const,
      status: 'required' as const,
      evidence: [],
      uncertainty: null,
    },
    liveInterview: {
      kind: 'live_video_interview' as const,
      status: 'unknown' as const,
      evidence: [],
      uncertainty: 'No verified source statement.',
    },
  },
};

describe('current opportunity video requirement projection', () => {
  beforeEach(() => {
    mocks.readCurrentOpportunityVideoRequirementsEvidence.mockReset();
    mocks.readCurrentOpportunityVideoRequirementsEvidence.mockResolvedValue(
      undefined,
    );
  });

  it('returns only an attested GLOBAL receipt for the current exact source', () => {
    const projected = projectCurrentOpportunityVideoRequirements({
      opportunity,
      receipt,
    });
    expect(projected).toEqual(receipt.videoRequirements);
    expect(projected).not.toBe(receipt.videoRequirements);
  });

  it.each([
    ['source fingerprint', { ...receipt, sourceContentFingerprint: 'old' }],
    ['source version', { ...receipt, sourceContentVersion: 3 }],
    [
      'leaf source identity',
      {
        ...receipt,
        videoRequirements: {
          ...receipt.videoRequirements,
          source: {
            ...receipt.videoRequirements.source,
            sourceContentVersion: 3,
          },
        },
      },
    ],
    [
      'missing actual provider provenance',
      {
        ...receipt,
        videoRequirements: {
          ...receipt.videoRequirements,
          provenance: undefined,
        },
      },
    ],
  ])('rejects a stale or unattested %s receipt', (_label, candidate) => {
    expect(
      projectCurrentOpportunityVideoRequirements({
        opportunity,
        receipt: candidate,
      }),
    ).toBeNull();
  });

  it('uses a persisted current sidecar only as a bounded selector for an actual GLOBAL receipt', async () => {
    mocks.readCurrentOpportunityVideoRequirementsEvidence.mockImplementation(
      async (candidate: Record<string, unknown>) => {
        if (candidate.id === 'opportunity-1') return receipt;
        if (candidate.id === 'tampered-actual')
          return { ...receipt, sourceContentVersion: 3 };
        return undefined;
      },
    );
    const projections =
      await loadCurrentOpportunityVideoRequirementsProjections([
        {
          ...opportunity,
          preparedPostingJson: JSON.stringify({
            opportunityVideoRequirements: receipt,
          }),
        },
        {
          ...opportunity,
          id: 'forged-sidecar',
          preparedPostingJson: JSON.stringify({
            opportunityVideoRequirements: receipt,
          }),
        },
        {
          ...opportunity,
          id: 'tampered-actual',
          preparedPostingJson: JSON.stringify({
            opportunityVideoRequirements: receipt,
          }),
        },
        {
          ...opportunity,
          id: 'stale-selector',
          sourceContentVersion: 5,
          preparedPostingJson: JSON.stringify({
            opportunityVideoRequirements: receipt,
          }),
        },
        {
          ...opportunity,
          id: 'invalid-selector',
          preparedPostingJson: '{"opportunityVideoRequirements":"forged"}',
        },
      ]);

    expect(projections).toEqual(
      new Map([['opportunity-1', receipt.videoRequirements]]),
    );
    expect(
      mocks.readCurrentOpportunityVideoRequirementsEvidence,
    ).toHaveBeenCalledTimes(3);
  });
});
