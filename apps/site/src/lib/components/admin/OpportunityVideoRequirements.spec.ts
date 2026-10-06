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
function finding(kind: string, status: string) {
  const quote =
    kind === 'recorded_application_video'
      ? 'Submit an application video.'
      : 'The interview takes place by video.';
  return {
    kind,
    status,
    uncertainty: null,
    evidence: [
      {
        id: 'c0',
        quote,
        spanStart: 0,
        spanEnd: quote.length,
        decision: status,
        probability: 0.95,
        confidence: 0.95,
      },
    ],
  };
}
const provenance = { model: 'jev-latest', provider: 'typesafe' };
describe('OpportunityVideoRequirements', () => {
  it.each([
    false,
    true,
  ])('hides No and Unknown entirely on compact=%s surfaces', (compact) => {
    for (const status of ['unknown', 'explicitly_not_required']) {
      const requirements = {
        ...unknown,
        provenance,
        recordedSubmission: finding('recorded_application_video', status),
        liveInterview: finding('live_video_interview', status),
      };
      const { body } = render(OpportunityVideoRequirements, {
        props: { requirements, compact },
      });
      expect(body).not.toContain('Video application steps');
      expect(body).not.toContain('<svg');
      expect(body).not.toContain('Unknown');
      expect(body).not.toContain('Explicitly not required');
      expect(body).not.toContain('Submit an application video.');
    }
  });
  it('shows a distinct recorded-video icon with an accessible required name and evidence details', () => {
    const { body } = render(OpportunityVideoRequirements, {
      props: {
        requirements: {
          ...unknown,
          provenance,
          recordedSubmission: finding('recorded_application_video', 'required'),
        },
      },
    });
    expect(body).toContain('lucide-clapperboard');
    expect(body).toContain('title="Recorded application video: required"');
    expect(body).toContain('aria-label="Recorded application video: required"');
    expect(body).toContain('Submit an application video.');
    expect(body).toContain('Captured posting');
    expect(body).toContain('Citation details');
    expect(body).toMatch(
      /<summary[^>]*role="button"[^>]*aria-label="Recorded application video: required"/,
    );
    expect(body).toMatch(
      /<summary[^>]*role="button"[^>]*>Citation details<\/summary>/,
    );
    expect(body).not.toContain('Live video interview');
    expect(body).not.toContain('<strong>Required</strong>');
    expect(body).not.toMatch(/<details[^>]*\bopen\b/);
  });
  it('shows an optional live-interview icon without claiming it is required', () => {
    const { body } = render(OpportunityVideoRequirements, {
      props: {
        requirements: {
          ...unknown,
          provenance,
          liveInterview: finding('live_video_interview', 'optional'),
        },
        compact: true,
      },
    });
    expect(body).toContain('lucide-video');
    expect(body).toContain('title="Live video interview: optional"');
    expect(body).toContain('aria-label="Live video interview: optional"');
    expect(body).toMatch(
      /<span[^>]*role="img"[^>]*aria-label="Live video interview: optional"/,
    );
    expect(body).not.toContain('<details');
    expect(body).not.toContain('<summary');
    expect(body).not.toContain('The interview takes place by video.');
    expect(body).not.toContain('Live video interview: required');
    expect(body).not.toContain('Recorded application video');
  });
  it('keeps both positive steps distinct and hides a negative sibling independently', () => {
    const requirements = {
      ...unknown,
      provenance,
      recordedSubmission: finding('recorded_application_video', 'optional'),
      liveInterview: finding('live_video_interview', 'required'),
    };
    const { body } = render(OpportunityVideoRequirements, {
      props: { requirements },
    });
    expect(body).toContain('Recorded application video: optional');
    expect(body).toContain('Live video interview: required');
    const { body: mixed } = render(OpportunityVideoRequirements, {
      props: {
        requirements: {
          ...requirements,
          liveInterview: finding(
            'live_video_interview',
            'explicitly_not_required',
          ),
        },
      },
    });
    expect(mixed).toContain('lucide-clapperboard');
    expect(mixed).not.toContain('lucide-video');
    expect(mixed).not.toContain('The interview takes place by video.');
  });
  it.each([
    { provenance: undefined },
    {
      recordedSubmission: {
        ...finding('recorded_application_video', 'required'),
        evidence: [],
      },
    },
    {
      recordedSubmission: {
        ...finding('recorded_application_video', 'required'),
        evidence: [
          {
            ...finding('recorded_application_video', 'required').evidence[0],
            probability: 0.5,
          },
        ],
      },
    },
    {
      recordedSubmission: {
        ...finding('recorded_application_video', 'required'),
        evidence: [
          {
            ...finding('recorded_application_video', 'required').evidence[0],
            decision: 'optional',
          },
        ],
      },
    },
    { recordedSubmission: finding('live_video_interview', 'required') },
  ])('never turns unattested or inconsistent positive cache into an icon (%j)', (change) => {
    const { body } = render(OpportunityVideoRequirements, {
      props: {
        requirements: {
          ...unknown,
          provenance,
          recordedSubmission: finding('recorded_application_video', 'required'),
          ...change,
        },
      },
    });
    expect(body).not.toContain('<svg');
    expect(body).not.toContain('Video application steps');
  });
});
