import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  opportunities: new Map<string, Record<string, unknown>>(),
  snapshot: vi.fn(async (_id: string) => null as unknown),
  tasks: [] as Record<string, unknown>[],
}));

vi.mock('./application-review.js', () => ({
  loadApplicationReviewSnapshot: mocks.snapshot,
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    if (className === 'Opportunity') {
      return {
        get: vi.fn(async (id: string) => mocks.opportunities.get(id) ?? null),
        list: vi.fn(async () => []),
      };
    }
    if (className === 'Task') {
      return {
        get: vi.fn(async () => null),
        list: vi.fn(async () => mocks.tasks),
      };
    }
    throw new Error(`Unexpected collection ${className}`);
  }),
}));

const PRIVATE_MARKERS = [
  'will@example.com',
  '+1 303 555 0123',
  'Boulder, CO',
  'US citizen; no sponsorship',
  'ats-login@example.com',
  'warden://',
  'Reusable library answer',
  'Private application notes',
  'PACKET BODY',
];

function material(
  overrides: Partial<{
    availability: string;
    label: string;
    materialType: string;
    notice: string;
    pdfPath: string;
    reviewStatus: string;
  }> = {},
) {
  return {
    availability: 'ready',
    body: 'PACKET BODY should never be returned',
    href: '/admin/resume-assets/asset-1',
    label: 'Packet',
    materialRecordId: 'asset-1',
    materialRecordType: 'ResumeAsset',
    materialType: 'packet',
    materialVersion: 'v1',
    notice: '',
    pdfDigest: 'digest',
    pdfFilename: 'packet.pdf',
    path: 'packet.md',
    pdfHref: '/admin/resume-assets/asset-1/pdf',
    pdfPath: 'packet.pdf',
    reviewStatus: 'not_reviewed',
    title: 'Packet',
    ...overrides,
  };
}

function schema(questions: Array<Record<string, unknown>>) {
  return JSON.stringify({
    ats: 'greenhouse',
    boardToken: 'acme',
    fetchedAt: '2026-08-30T00:00:00.000Z',
    jobId: '123',
    questions,
  });
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    opportunityId: 'opp-1',
    status: 'awaiting_user',
    applyMethod: 'ats',
    applicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
    resumeMode: 'default',
    coverLetterMode: 'generated',
    applicationInstructions: 'Answer every required question.',
    requiredAnswers: 'Why us: because.',
    requiredQuestionsJson: schema([
      { id: 'q_why', label: 'Why Acme?', required: true, type: 'textarea' },
      {
        id: 'q_salary',
        label: 'Salary expectation',
        required: true,
        type: 'input_text',
      },
      { id: 'resume', label: 'Resume', required: true, type: 'input_file' },
    ]),
    requiredAnswersJson: JSON.stringify({ q_why: 'Because of the mission.' }),
    accountStatus: 'needs_login',
    accountLoginIdentity: 'ats-login@example.com',
    accountNotes: 'Reset password monthly',
    wardenReference: 'warden://secret/1',
    notes: 'Private application notes',
    approvalScope: '',
    approvalNotes: '',
    approvedAt: null,
    finalApprovalKind: '',
    finalApprovalAt: null,
    finalApprovedByUserId: '',
    finalApprovalMaterialsJson: '[]',
    submittedAt: null,
    ...overrides,
  };
}

describe('inspectJobApplication', () => {
  beforeEach(() => {
    mocks.snapshot.mockReset();
    mocks.opportunities.clear();
    mocks.tasks = [];
    mocks.opportunities.set('opp-1', {
      id: 'opp-1',
      status: 'apply',
      title: 'Platform Engineer',
    });
  });

  it('returns 404 for an unknown application', async () => {
    mocks.snapshot.mockResolvedValue(null);
    const { inspectJobApplication } = await import(
      './application-inspect-webmcp'
    );
    await expect(
      inspectJobApplication({ applicationId: 'missing' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(inspectJobApplication({})).rejects.toMatchObject({
      status: 400,
    });
  });

  it('explains what an awaiting_user application is waiting for without exposing private data', async () => {
    mocks.snapshot.mockResolvedValue({
      application: application(),
      comments: [
        {
          id: 'comment-1',
          body: 'Tighten the second paragraph.',
          materialRecordId: 'asset-3',
          materialType: 'cover_letter',
          materialVersion: 'v1',
          resolvedAt: null,
          status: 'open',
          updated_at: '2026-08-30T12:00:00.000Z',
        },
        {
          id: 'comment-2',
          body: '',
          materialRecordId: 'asset-1',
          materialType: 'packet',
          materialVersion: 'v1',
          resolvedAt: '2026-08-30T12:30:00.000Z',
          status: 'reviewed',
        },
      ],
      finalApprovalMaterialsCurrent: false,
      materials: [
        material({ reviewStatus: 'reviewed' }),
        material({
          label: 'Resume',
          materialType: 'resume',
          reviewStatus: 'not_reviewed',
        }),
        material({
          availability: 'needs_attention',
          label: 'Cover letter',
          materialType: 'cover_letter',
          notice:
            'This application requests a cover letter, but no reviewable artifact is selected.',
          pdfPath: '',
        }),
        material({
          label: 'Answers',
          materialRecordType: 'Application',
          materialType: 'answers',
          pdfPath: '',
        } as never),
      ],
    });
    mocks.tasks = [
      {
        id: 'task-1',
        applicationId: 'app-1',
        assigneeRole: 'owner',
        blockerReason: 'Waiting on the salary answer.',
        status: 'blocked',
        taskType: 'collect_application_answers',
        title: 'Collect answers',
      },
      {
        id: 'task-2',
        applicationId: 'app-1',
        status: 'done',
        taskType: 'prepare_application_packet',
        title: 'Old task',
      },
    ];
    const { inspectJobApplication } = await import(
      './application-inspect-webmcp'
    );

    const result = await inspectJobApplication({ applicationId: 'app-1' });
    const serialized = JSON.stringify(result);

    for (const marker of PRIVATE_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
    expect(result.application).toMatchObject({
      id: 'app-1',
      status: 'awaiting_user',
      adminUrl: '/admin/applications/app-1/',
      reviewUrl: '/admin/applications/app-1/review',
      materialsLocked: false,
    });
    expect(result.opportunity).toEqual({
      id: 'opp-1',
      title: 'Platform Engineer',
      status: 'apply',
      adminUrl: '/admin/opportunities/opp-1/',
    });
    expect(
      result.materials.map((entry) => [entry.type, entry.reviewStatus]),
    ).toEqual([
      ['packet', 'reviewed'],
      ['resume', 'not_reviewed'],
      ['cover_letter', 'not_reviewed'],
      ['answers', 'not_reviewed'],
    ]);
    expect(result.materials[2]).toMatchObject({
      availability: 'needs_attention',
      openCommentCount: 1,
      pdfAvailable: false,
    });
    expect(result.answers).toMatchObject({
      ats: 'greenhouse',
      hasSchema: true,
    });
    expect(result.answers.questions).toEqual([
      {
        id: 'q_why',
        label: 'Why Acme?',
        required: true,
        answered: true,
        answer: 'Because of the mission.',
      },
      {
        id: 'q_salary',
        label: 'Salary expectation',
        required: true,
        answered: false,
        answer: '',
      },
    ]);
    expect(result.tasks).toHaveLength(1);
    expect(result.comments.unresolved).toEqual([
      {
        id: 'comment-1',
        materialType: 'cover_letter',
        body: 'Tighten the second paragraph.',
        updatedAt: '2026-08-30T12:00:00.000Z',
      },
    ]);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'missing_required_answer',
      'material_needs_attention',
      'open_review_comment',
      'blocked_task',
      'employer_account',
      'material_not_reviewed',
      'material_not_reviewed',
      'owner_approval_required',
    ]);
    expect(result.awaiting).toContain(
      '"Salary expectation" has no committed answer',
    );
    expect(result.awaiting).toContain('needs_login');
    expect(result.awaiting).toContain('has not recorded final approval');
    expect(result.approval).toEqual({
      recorded: false,
      scope: '',
      notes: '',
      approvedAt: null,
      final: {
        recorded: false,
        kind: '',
        approvedAt: null,
        materialCount: 0,
        materialsCurrent: false,
      },
    });
    expect(result.submission).toBeNull();
  });

  it('reports approval scope, timestamps, and submission evidence for a submitted application', async () => {
    mocks.snapshot.mockResolvedValue({
      application: application({
        status: 'submitted',
        accountStatus: 'ready',
        approvalScope: 'Submit the reviewed packet to Greenhouse.',
        approvalNotes: 'Looks good.',
        approvedAt: '2026-08-30T13:00:00.000Z',
        finalApprovalKind: 'final_submission',
        finalApprovalAt: '2026-08-30T13:05:00.000Z',
        finalApprovedByUserId: 'user-1',
        finalApprovalMaterialsJson: JSON.stringify([
          {
            materialRecordId: 'asset-1',
            materialType: 'packet',
            materialVersion: 'v1',
          },
          {
            materialRecordId: 'app-1',
            materialType: 'answers',
            materialVersion: 'v2',
          },
        ]),
        submittedAt: '2026-08-30T14:00:00.000Z',
        submissionMethod: 'ats_form',
        submittedByRole: 'owner',
        submissionEvidenceUrl: 'https://acme.example/confirmation/1',
        submissionNotes: 'Confirmation email received.',
        requiredAnswersJson: JSON.stringify({
          q_why: 'Because of the mission.',
          q_salary: 'Market.',
        }),
      }),
      comments: [],
      finalApprovalMaterialsCurrent: true,
      materials: [material({ reviewStatus: 'reviewed' })],
    });
    const { inspectJobApplication } = await import(
      './application-inspect-webmcp'
    );

    const result = await inspectJobApplication({ applicationId: 'app-1' });

    expect(result.blockers).toEqual([]);
    expect(result.awaiting).toBe('');
    expect(result.application.materialsLocked).toBe(true);
    expect(result.approval).toEqual({
      recorded: true,
      scope: 'Submit the reviewed packet to Greenhouse.',
      notes: 'Looks good.',
      approvedAt: '2026-08-30T13:00:00.000Z',
      final: {
        recorded: true,
        kind: 'final_submission',
        approvedAt: '2026-08-30T13:05:00.000Z',
        materialCount: 2,
        materialsCurrent: true,
      },
    });
    expect(result.submission).toEqual({
      submittedAt: '2026-08-30T14:00:00.000Z',
      method: 'ats_form',
      byRole: 'owner',
      evidenceUrl: 'https://acme.example/confirmation/1',
      notes: 'Confirmation email received.',
    });
  });

  it('bounds answers, comments, and tasks', async () => {
    const questions = Array.from({ length: 80 }, (_, index) => ({
      id: `q_${index}`,
      label: `Question ${index}`,
      required: false,
      type: 'input_text',
    }));
    mocks.snapshot.mockResolvedValue({
      application: application({
        status: 'application_drafting',
        accountStatus: 'ready',
        requiredQuestionsJson: schema(questions),
        requiredAnswersJson: JSON.stringify({ q_0: 'z'.repeat(5_000) }),
      }),
      comments: Array.from({ length: 40 }, (_, index) => ({
        id: `comment-${index}`,
        body: 'b'.repeat(5_000),
        materialType: 'packet',
        resolvedAt: null,
        status: 'open',
      })),
      finalApprovalMaterialsCurrent: false,
      materials: [material()],
    });
    mocks.tasks = Array.from({ length: 30 }, (_, index) => ({
      id: `task-${index}`,
      status: 'open',
      taskType: 'follow_up',
      title: 'Follow up',
    }));
    const { inspectJobApplication } = await import(
      './application-inspect-webmcp'
    );

    const result = await inspectJobApplication({ applicationId: 'app-1' });

    expect(result.answers.questions).toHaveLength(60);
    expect(result.answers.truncated).toBe(true);
    expect(result.answers.questions[0]?.answer.length).toBeLessThanOrEqual(
      1_001,
    );
    expect(result.comments.unresolved).toHaveLength(25);
    expect(result.comments.unresolvedTotal).toBe(40);
    expect(result.comments.unresolved[0]?.body.length).toBeLessThanOrEqual(
      1_001,
    );
    expect(result.tasks).toHaveLength(20);
    expect(result.blockers.length).toBeLessThanOrEqual(40);
  });
});
