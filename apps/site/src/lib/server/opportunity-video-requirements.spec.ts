import type { DecisionResult } from '@happyvertical/ai';
import { describe, expect, it } from 'vitest';
import {
  analyzeOpportunityVideoRequirements,
  OPPORTUNITY_VIDEO_REQUIREMENTS_THRESHOLD,
  OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION,
  prepareOpportunityVideoRequirements,
  resolveOpportunityVideoRequirements,
} from './opportunity-video-requirements.js';

type Prepared = ReturnType<typeof prepareOpportunityVideoRequirements>;
type Kind = 'recorded_application_video' | 'live_video_interview';
type Decision = 'required' | 'optional' | 'explicitly_not_required';

function decisionResult(
  prepared: Prepared,
  affirmed: Partial<Record<`${Kind}_${Decision}`, string>> = {},
): DecisionResult {
  const answers: Record<string, unknown> = {};
  for (const kind of [
    'recorded_application_video',
    'live_video_interview',
  ] as const)
    for (const decision of [
      'required',
      'optional',
      'explicitly_not_required',
    ] as const) {
      const key = `${kind}_${decision}` as const;
      const clauseId = affirmed[key];
      answers[key] = {
        type: 'predicate',
        probability: clauseId ? OPPORTUNITY_VIDEO_REQUIREMENTS_THRESHOLD : 0.1,
      };
      answers[`${key}_evidence`] = {
        type: 'choice',
        choice: clauseId ?? 'none',
        confidence: OPPORTUNITY_VIDEO_REQUIREMENTS_THRESHOLD,
      };
    }
  return {
    answers: answers as DecisionResult['answers'],
    model: 'jev-test',
    provenance: { model: 'jev-test', provider: 'typesafe' },
  };
}

describe('opportunity video requirement decisions', () => {
  it('builds a versioned typed decision over an exact required-introduction span', () => {
    const source =
      'Application step: You will be asked to submit a two-minute introductory video as part of your application.';
    const prepared = prepareOpportunityVideoRequirements(source);

    expect(prepared.clauses).toEqual([
      {
        id: 'c0',
        quote: source,
        spanStart: 0,
        spanEnd: source.length,
      },
    ]);
    expect(Object.keys(prepared.request.questions)).toHaveLength(12);
    expect(
      resolveOpportunityVideoRequirements(prepared).recordedSubmission,
    ).toMatchObject({ status: 'unknown', evidence: [] });
    expect(
      analyzeOpportunityVideoRequirements(source, {
        sourceContentFingerprint: 'current-source',
        sourceContentVersion: 7,
      }),
    ).toMatchObject({
      source: {
        sourceContentFingerprint: 'current-source',
        sourceContentVersion: 7,
      },
      recordedSubmission: { status: 'unknown' },
      liveInterview: { status: 'unknown' },
    });

    const result = resolveOpportunityVideoRequirements(
      prepared,
      decisionResult(prepared, { recorded_application_video_required: 'c0' }),
    );
    expect(result).toMatchObject({
      version: OPPORTUNITY_VIDEO_REQUIREMENTS_VERSION,
      recordedSubmission: {
        status: 'required',
        uncertainty: null,
        evidence: [
          {
            id: 'c0',
            quote: source,
            spanStart: 0,
            spanEnd: source.length,
            decision: 'required',
            probability: OPPORTUNITY_VIDEO_REQUIREMENTS_THRESHOLD,
            confidence: OPPORTUNITY_VIDEO_REQUIREMENTS_THRESHOLD,
          },
        ],
      },
      liveInterview: { status: 'unknown' },
    });
  });

  it('keeps an optional recorded video separate from a required live interview', () => {
    const source =
      'You may include a video introduction with your application. Finalists will complete a live video interview.';
    const prepared = prepareOpportunityVideoRequirements(source);
    const result = resolveOpportunityVideoRequirements(
      prepared,
      decisionResult(prepared, {
        recorded_application_video_optional: 'c0',
        live_video_interview_required: 'c1',
      }),
    );

    expect(result.recordedSubmission).toMatchObject({
      status: 'optional',
      evidence: [
        {
          quote: 'You may include a video introduction with your application.',
        },
      ],
    });
    expect(result.liveInterview).toMatchObject({
      status: 'required',
      evidence: [{ quote: 'Finalists will complete a live video interview.' }],
    });
  });

  it('keeps a live interview-only source unknown for a recorded application video', () => {
    const prepared = prepareOpportunityVideoRequirements(
      'Qualified candidates will complete a live video interview with the hiring team.',
    );
    const result = resolveOpportunityVideoRequirements(
      prepared,
      decisionResult(prepared, { live_video_interview_required: 'c0' }),
    );

    expect(result.liveInterview.status).toBe('required');
    expect(result.recordedSubmission).toMatchObject({
      status: 'unknown',
      evidence: [],
    });
  });

  it('retains an explicit no-recording statement only when the typed decision cites it', () => {
    const source = 'A recorded video is not required to apply for this role.';
    const prepared = prepareOpportunityVideoRequirements(source);
    const result = resolveOpportunityVideoRequirements(
      prepared,
      decisionResult(prepared, {
        recorded_application_video_explicitly_not_required: 'c0',
      }),
    );

    expect(result.recordedSubmission).toMatchObject({
      status: 'explicitly_not_required',
      uncertainty: null,
      evidence: [{ quote: source, decision: 'explicitly_not_required' }],
    });
  });

  it('keeps source silence unknown rather than treating it as no video requirement', () => {
    const prepared = prepareOpportunityVideoRequirements(
      'Submit your resume and a short description of your experience.',
    );
    const result = resolveOpportunityVideoRequirements(
      prepared,
      decisionResult(prepared),
    );

    expect(prepared.clauses).toEqual([]);
    expect(result.recordedSubmission).toMatchObject({
      status: 'unknown',
      evidence: [],
    });
    expect(result.liveInterview).toMatchObject({
      status: 'unknown',
      evidence: [],
    });
  });

  it.each([
    'You can apply online but must submit a recorded video.',
    'No experience is needed; submit a video introduction.',
  ])('does not let lexical wording decide %s', (source) => {
    const prepared = prepareOpportunityVideoRequirements(source);
    const withoutDecision = resolveOpportunityVideoRequirements(prepared);
    const withDecision = resolveOpportunityVideoRequirements(
      prepared,
      decisionResult(prepared, { recorded_application_video_required: 'c0' }),
    );

    expect(withoutDecision.recordedSubmission.status).toBe('unknown');
    expect(withDecision.recordedSubmission.status).toBe('required');
  });

  it('offers a same-sentence recording and live interview clause to both predicates', () => {
    const source =
      'Applicants must submit a recorded video, then complete a live video interview.';
    const prepared = prepareOpportunityVideoRequirements(source);
    const result = resolveOpportunityVideoRequirements(
      prepared,
      decisionResult(prepared, {
        recorded_application_video_required: 'c0',
        live_video_interview_required: 'c0',
      }),
    );

    expect(prepared.clauses).toHaveLength(1);
    expect(result.recordedSubmission.status).toBe('required');
    expect(result.liveInterview.status).toBe('required');
    expect(result.liveInterview.evidence[0]).toMatchObject({
      quote: source,
      spanStart: 0,
      spanEnd: source.length,
    });
  });

  it('returns unknown on conflicting explicit predicates instead of selecting one', () => {
    const source =
      'A recorded video is not required. You must submit a recorded video after applying.';
    const prepared = prepareOpportunityVideoRequirements(source);
    const result = resolveOpportunityVideoRequirements(
      prepared,
      decisionResult(prepared, {
        recorded_application_video_explicitly_not_required: 'c0',
        recorded_application_video_required: 'c1',
      }),
    );

    expect(result.recordedSubmission).toMatchObject({
      status: 'unknown',
      uncertainty: expect.stringMatching(/conflicting/iu),
      evidence: [
        {
          decision: 'required',
          quote: 'You must submit a recorded video after applying.',
        },
        {
          decision: 'explicitly_not_required',
          quote: 'A recorded video is not required.',
        },
      ],
    });
  });

  it('rejects incomplete or uncited high-confidence decision results', () => {
    const prepared = prepareOpportunityVideoRequirements(
      'Submit a recorded video.',
    );
    const incomplete = decisionResult(prepared);
    delete incomplete.answers.recorded_application_video_required;
    expect(() =>
      resolveOpportunityVideoRequirements(prepared, incomplete),
    ).toThrow(/every exact predicate/u);

    const uncited = decisionResult(prepared);
    uncited.answers.recorded_application_video_required = {
      type: 'predicate',
      probability: 0.99,
    };
    expect(() =>
      resolveOpportunityVideoRequirements(prepared, uncited),
    ).toThrow(/requires an exact source clause/u);
  });
});
