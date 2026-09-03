import { describe, expect, it, vi } from 'vitest';
import type { AtsFilePart, AtsFormSchema } from './ats/types.js';
import { runAutoSubmitApplicationJob } from './auto-submit-application-job.js';
import type { AutoSubmitEligibility } from './auto-submit-eligibility.js';

const SCHEMA: AtsFormSchema = {
  ats: 'greenhouse',
  boardToken: 'acme',
  jobId: '1',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  questions: [
    {
      id: 'first_name',
      label: 'First Name',
      required: true,
      type: 'input_text',
    },
    { id: 'resume', label: 'Resume', required: true, type: 'input_file' },
  ],
};

const RESUME: AtsFilePart = {
  fieldName: 'resume',
  filename: 'resume.pdf',
  contentType: 'application/pdf',
  byteLength: 2048,
  present: true,
  sha256: 'approved-resume-digest',
};

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    status: 'submitting',
    requiredQuestionsJson: JSON.stringify(SCHEMA),
    requiredAnswersJson: JSON.stringify({ first_name: 'Ada' }),
    finalApprovalMaterialsJson: JSON.stringify([
      {
        materialRecordId: 'resume-app-1',
        materialType: 'resume',
        materialVersion: 'resume-version',
        pdfDigest: 'approved-resume-digest',
        pdfFilename: 'resume.pdf',
      },
    ]),
    ...overrides,
  };
}

function eligibility(
  overrides: Partial<AutoSubmitEligibility> = {},
): AutoSubmitEligibility {
  return {
    eligible: true,
    code: 'eligible',
    reason: '',
    detectionType: 'greenhouse',
    missingQuestions: [],
    ...overrides,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    config: { enabled: false, dryRun: true },
    resolveResume: async () => RESUME,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recordAudit: vi.fn(async (_options: any) => ({ id: 'run-1' })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    routeToAnswerCollection: vi.fn(async (_options: any) => ({
      created: true,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setApplicationStatus: vi.fn(async (_app: any, _status: any) => {}),
    ...over,
  };
}

describe('runAutoSubmitApplicationJob', () => {
  it('dry-run: persists the exact payload as an audit and never marks submitted', async () => {
    const resolveResume = vi.fn(async () => RESUME);
    const d = deps({ evaluate: async () => eligibility(), resolveResume });
    const result = await runAutoSubmitApplicationJob(
      application({ resumeAssetId: 'resume-app-1' }),
      {},
      undefined,
      d as never,
    );

    expect(result.outcome).toBe('dry_run');
    // status moved to "pending submission", never to submitted.
    expect(d.setApplicationStatus).toHaveBeenCalledWith(
      expect.anything(),
      'submitting',
    );
    expect(d.recordAudit).toHaveBeenCalledTimes(1);
    const audit = d.recordAudit.mock.calls[0][0];
    expect(audit.runType).toBe('auto_submit_dry_run');
    expect(audit.status).toBe('dry_run');
    expect(audit.output.payload.endpoint).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1',
    );
    expect(audit.output.payload.fields).toEqual([
      { name: 'first_name', value: 'Ada' },
    ]);
    expect(audit.output.payload.files).toEqual([
      expect.objectContaining({
        filename: 'resume.pdf',
      }),
    ]);
    expect(resolveResume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeAssetId: 'resume-app-1' }),
    );
  });

  it('does not change dry-run status if its payload audit cannot be saved', async () => {
    const d = deps({
      evaluate: async () => eligibility(),
      recordAudit: vi.fn(async () => {
        throw new Error('audit unavailable');
      }),
    });

    await expect(
      runAutoSubmitApplicationJob(application(), {}, undefined, d as never),
    ).rejects.toThrow('audit unavailable');
    expect(d.setApplicationStatus).not.toHaveBeenCalled();
  });

  it('missing answers: routes to the collection CTA, never to manual', async () => {
    const missingQuestions = [
      {
        id: 'first_name',
        label: 'First Name',
        required: true,
        type: 'input_text',
      },
    ];
    const d = deps({
      evaluate: async () =>
        eligibility({
          eligible: false,
          code: 'missing_answers',
          reason: 'Missing 1 required answer(s).',
          missingQuestions,
        }),
    });
    const result = await runAutoSubmitApplicationJob(
      application(),
      {},
      undefined,
      d as never,
    );

    expect(result.outcome).toBe('awaiting_user');
    expect(d.routeToAnswerCollection).toHaveBeenCalledTimes(1);
    expect(d.setApplicationStatus).not.toHaveBeenCalled();
    expect(d.recordAudit.mock.calls[0][0].runType).toBe('auto_submit_blocked');
  });

  it('does not route missing answers when its blocker audit cannot be saved', async () => {
    const d = deps({
      evaluate: async () =>
        eligibility({
          eligible: false,
          code: 'missing_answers',
          missingQuestions: [
            {
              id: 'first_name',
              label: 'First Name',
              required: true,
              type: 'input_text',
            },
          ],
        }),
      recordAudit: vi.fn(async () => {
        throw new Error('audit unavailable');
      }),
    });

    await expect(
      runAutoSubmitApplicationJob(application(), {}, undefined, d as never),
    ).rejects.toThrow('audit unavailable');
    expect(d.routeToAnswerCollection).not.toHaveBeenCalled();
  });

  it('already submitted: idempotent no-op', async () => {
    const d = deps({
      evaluate: async () =>
        eligibility({ eligible: false, code: 'already_submitted' }),
    });
    const result = await runAutoSubmitApplicationJob(
      application(),
      {},
      undefined,
      d as never,
    );
    expect(result.outcome).toBe('noop');
    expect(d.setApplicationStatus).not.toHaveBeenCalled();
    expect(d.recordAudit).not.toHaveBeenCalled();
  });

  it('not approved: no-op, never moves into the approval-bound manual_submission', async () => {
    const d = deps({
      evaluate: async () =>
        eligibility({ eligible: false, code: 'not_approved' }),
    });
    const result = await runAutoSubmitApplicationJob(
      application(),
      {},
      undefined,
      d as never,
    );
    expect(result.outcome).toBe('noop');
    expect(d.setApplicationStatus).not.toHaveBeenCalled();
    expect(d.recordAudit).not.toHaveBeenCalled();
  });

  it('other ineligibility: falls back to manual_submission', async () => {
    const d = deps({
      evaluate: async () =>
        eligibility({ eligible: false, code: 'account_required' }),
    });
    const result = await runAutoSubmitApplicationJob(
      application(),
      {},
      undefined,
      d as never,
    );
    expect(result.outcome).toBe('manual_submission');
    expect(d.setApplicationStatus).toHaveBeenCalledWith(
      expect.anything(),
      'manual_submission',
    );
  });

  it('blocks before building a payload when the resolved resume bytes changed', async () => {
    const calls: string[] = [];
    const d = deps({
      evaluate: async () => eligibility(),
      resolveResume: async () => ({ ...RESUME, sha256: 'different-digest' }),
      recordAudit: vi.fn(async () => {
        calls.push('audit');
        return { id: 'run-1' };
      }),
      setApplicationStatus: vi.fn(async () => {
        calls.push('status');
      }),
    });

    const result = await runAutoSubmitApplicationJob(
      application(),
      {},
      undefined,
      d as never,
    );

    expect(result).toMatchObject({
      outcome: 'manual_submission',
      code: 'approval_materials_changed',
    });
    expect(d.setApplicationStatus).toHaveBeenCalledWith(
      expect.anything(),
      'manual_submission',
    );
    expect(d.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        runType: 'auto_submit_blocked',
        status: 'blocked',
      }),
    );
    expect(calls).toEqual(['audit', 'status']);
  });

  it('blocks before building a payload when the approved resume filename changed', async () => {
    const d = deps({ evaluate: async () => eligibility() });
    const result = await runAutoSubmitApplicationJob(
      application({
        finalApprovalMaterialsJson: JSON.stringify([
          {
            materialRecordId: 'resume-app-1',
            materialType: 'resume',
            materialVersion: 'resume-version',
            pdfDigest: 'approved-resume-digest',
            pdfFilename: 'Renamed - Example Candidate - Programmer.pdf',
          },
        ]),
      }),
      {},
      undefined,
      d as never,
    );

    expect(result).toMatchObject({
      outcome: 'manual_submission',
      code: 'approval_materials_changed',
    });
    expect(d.setApplicationStatus).toHaveBeenCalledWith(
      expect.anything(),
      'manual_submission',
    );
  });

  it('blocks legacy approval snapshots that do not record a resume digest', async () => {
    const d = deps({ evaluate: async () => eligibility() });
    const result = await runAutoSubmitApplicationJob(
      application({
        finalApprovalMaterialsJson: JSON.stringify([
          {
            materialRecordId: 'resume-app-1',
            materialType: 'resume',
            materialVersion: 'legacy-resume-version',
          },
        ]),
      }),
      {},
      undefined,
      d as never,
    );

    expect(result).toMatchObject({
      outcome: 'manual_submission',
      code: 'approval_materials_changed',
    });
    expect(d.setApplicationStatus).toHaveBeenCalledWith(
      expect.anything(),
      'manual_submission',
    );
  });

  it('does not change status if recording a resume-mismatch audit fails', async () => {
    const d = deps({
      evaluate: async () => eligibility(),
      resolveResume: async () => ({ ...RESUME, sha256: 'different-digest' }),
      recordAudit: vi.fn(async () => {
        throw new Error('audit unavailable');
      }),
    });

    await expect(
      runAutoSubmitApplicationJob(application(), {}, undefined, d as never),
    ).rejects.toThrow('audit unavailable');
    expect(d.setApplicationStatus).not.toHaveBeenCalled();
  });

  it('live mode: stubbed submit fails and falls back to manual_submission', async () => {
    const d = deps({
      config: { enabled: true, dryRun: false },
      evaluate: async () => eligibility(),
    });
    const result = await runAutoSubmitApplicationJob(
      application(),
      {},
      undefined,
      d as never,
    );
    expect(result.outcome).toBe('manual_submission');
    // never silently reports submitted
    expect(
      d.setApplicationStatus.mock.calls.some((c) => c[1] === 'submitted'),
    ).toBe(false);
  });
});
