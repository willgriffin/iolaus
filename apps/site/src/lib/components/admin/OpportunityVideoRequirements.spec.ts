import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OpportunityVideoRequirements from './OpportunityVideoRequirements.svelte';

const unknown = {
  version: 'opportunity-video-requirements/v2',
  fingerprint: 'source',
  source: { sourceContentFingerprint: 'raw', sourceContentVersion: 1 },
  recordedSubmission: {
    kind: 'recorded_application_video',
    status: 'unknown',
    evidence: [],
    uncertainty: 'Unverified',
  },
  liveInterview: {
    kind: 'live_video_interview',
    status: 'unknown',
    evidence: [],
    uncertainty: 'Unverified',
  },
};
describe('OpportunityVideoRequirements', () => {
  it('keeps recorded application videos and live interviews independently unknown without inventing an absent requirement', () => {
    const { body } = render(OpportunityVideoRequirements, {
      props: { requirements: unknown },
    });
    expect(body).toContain(
      'Recorded application video: <strong>Unknown</strong>',
    );
    expect(body).toContain('Live video interview: <strong>Unknown</strong>');
    expect(body).not.toContain('Explicitly not required');
    expect(body).not.toContain('No video');
  });
  it('shows a typed high-confidence source-cited recorded requirement without changing unknown live-interview status', () => {
    const requirements = {
      ...unknown,
      provenance: { model: 'jev-latest', provider: 'typesafe' },
      recordedSubmission: {
        ...unknown.recordedSubmission,
        status: 'required',
        uncertainty: null,
        evidence: [
          {
            id: 'c0',
            quote: 'Submit an application video.',
            spanStart: 0,
            spanEnd: 28,
            decision: 'required',
            probability: 0.95,
            confidence: 0.95,
          },
        ],
      },
    };
    const { body } = render(OpportunityVideoRequirements, {
      props: { requirements },
    });
    expect(body).toContain(
      'Recorded application video: <strong>Required</strong>',
    );
    expect(body).toContain('Live video interview: <strong>Unknown</strong>');
    expect(body).toContain('Submit an application video.');
    expect(body).toContain('Captured posting');
    expect(body).toContain('Citation details');
    expect(body).toContain('Characters 0–28');
  });
  it('does not promote an unsupported cached status with no typed provenance or exact evidence', () => {
    const { body } = render(OpportunityVideoRequirements, {
      props: {
        requirements: {
          ...unknown,
          recordedSubmission: {
            ...unknown.recordedSubmission,
            status: 'required',
          },
        },
      },
    });
    expect(body).not.toContain('<strong>Required</strong>');
    expect(body).toContain('<strong>Unknown</strong>');
  });
});
