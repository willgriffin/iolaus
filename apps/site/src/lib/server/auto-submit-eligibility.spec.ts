import { describe, expect, it } from 'vitest';
import type { AtsFormSchema } from './ats/types.js';
import type { AutoSubmitConfig } from './auto-submit-config.js';
import {
  canAutoSubmit,
  effectiveApplyUrl,
  findMissingRequiredAnswers,
  parseRequiredAnswers,
  summarizeApplicationFormAnswers,
} from './auto-submit-eligibility.js';

const ACTIVE: AutoSubmitConfig = { enabled: false, dryRun: true };

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
    { id: 'why', label: 'Why?', required: false, type: 'textarea' },
  ],
};

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    status: 'approved',
    approvedByUserId: 'user-1',
    finalApprovalAt: new Date('2026-01-01T00:00:00.000Z'),
    finalApprovalKind: 'final_submission',
    finalApprovedByUserId: 'user-1',
    applicationUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    accountStatus: 'none_needed',
    requiredQuestionsJson: JSON.stringify(SCHEMA),
    requiredAnswersJson: JSON.stringify({ first_name: 'Ada' }),
    ...overrides,
  };
}

const greenhouseDetect = async () => ({ type: 'greenhouse' });
const resumePresent = async () => true;

function options(overrides = {}) {
  return {
    approvalMaterialsCurrent: async () => true,
    config: ACTIVE,
    detect: greenhouseDetect,
    resumeExists: resumePresent,
    ...overrides,
  };
}

describe('parseRequiredAnswers', () => {
  it('coerces values to trimmed strings', () => {
    expect(parseRequiredAnswers('{"a":" x ","b":3}')).toEqual({
      a: 'x',
      b: '3',
    });
  });
  it('returns {} for invalid json', () => {
    expect(parseRequiredAnswers('nope')).toEqual({});
    expect(parseRequiredAnswers('')).toEqual({});
  });
});

describe('findMissingRequiredAnswers', () => {
  it('reports required scalar questions with no answer, excluding files', () => {
    const missing = findMissingRequiredAnswers(SCHEMA, {});
    expect(missing.map((q) => q.id)).toEqual(['first_name']);
  });
  it('returns empty when all required scalar answers are present', () => {
    expect(findMissingRequiredAnswers(SCHEMA, { first_name: 'Ada' })).toEqual(
      [],
    );
  });

  it('excludes the file question per-ATS, not just Greenhouse (Ashby File, Lever resume)', () => {
    // A *required* resume question must never be flagged as a missing answer —
    // it is satisfied by the resume artifact. Each ATS names its file type
    // differently, so the check must dispatch by schema.ats.
    const ashby: AtsFormSchema = {
      ats: 'ashby',
      boardToken: 'acme',
      jobId: '1',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      questions: [
        {
          id: '_systemfield_resume',
          label: 'Resume',
          required: true,
          type: 'File',
        },
      ],
    };
    const lever: AtsFormSchema = {
      ats: 'lever',
      boardToken: 'acme',
      jobId: '1',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      questions: [
        { id: 'resume', label: 'Resume/CV', required: true, type: 'resume' },
      ],
    };
    expect(findMissingRequiredAnswers(ashby, {})).toEqual([]);
    expect(findMissingRequiredAnswers(lever, {})).toEqual([]);
  });
});

describe('summarizeApplicationFormAnswers', () => {
  it('reports no schema when none is persisted', () => {
    expect(
      summarizeApplicationFormAnswers({ requiredQuestionsJson: '{}' }),
    ).toEqual({
      ats: '',
      hasSchema: false,
      requiredQuestions: [],
      missingRequiredAnswers: [],
    });
  });

  it('lists required scalar questions with answered flags and gaps', () => {
    const summary = summarizeApplicationFormAnswers({
      requiredQuestionsJson: JSON.stringify(SCHEMA),
      requiredAnswersJson: JSON.stringify({ first_name: 'Ada' }),
    });
    expect(summary.ats).toBe('greenhouse');
    expect(summary.hasSchema).toBe(true);
    // 'resume' (file) and 'why' (optional) excluded; only required scalars.
    expect(summary.requiredQuestions).toEqual([
      { id: 'first_name', label: 'First Name', answered: true },
    ]);
    expect(summary.missingRequiredAnswers).toEqual([]);
  });

  it('flags missing required answers', () => {
    const summary = summarizeApplicationFormAnswers({
      requiredQuestionsJson: JSON.stringify(SCHEMA),
      requiredAnswersJson: '{}',
    });
    expect(summary.requiredQuestions[0]).toEqual({
      id: 'first_name',
      label: 'First Name',
      answered: false,
    });
    expect(summary.missingRequiredAnswers.map((q) => q.id)).toEqual([
      'first_name',
    ]);
  });
});

describe('canAutoSubmit', () => {
  it('is eligible when all conditions hold', async () => {
    const result = await canAutoSubmit(application(), options());
    expect(result).toMatchObject({ eligible: true, code: 'eligible' });
  });

  it('is feature_off when the feature is dormant', async () => {
    const result = await canAutoSubmit(
      application(),
      options({ config: { enabled: false, dryRun: false } }),
    );
    expect(result.code).toBe('feature_off');
    expect(result.eligible).toBe(false);
  });

  it('is already_submitted for past-submission statuses', async () => {
    const result = await canAutoSubmit(
      application({ status: 'submitted' }),
      options(),
    );
    expect(result.code).toBe('already_submitted');
  });

  it('is already_submitted when submittedAt is set', async () => {
    const result = await canAutoSubmit(
      application({ submittedAt: new Date('2026-01-01') }),
      options(),
    );
    expect(result.code).toBe('already_submitted');
  });

  it('is not_approved when no final submission approval is recorded', async () => {
    const result = await canAutoSubmit(
      application({ finalApprovalKind: '' }),
      options(),
    );
    expect(result.code).toBe('not_approved');
    expect(result.eligible).toBe(false);
  });

  it('fails closed when current materials no longer match final approval', async () => {
    const result = await canAutoSubmit(
      application(),
      options({ approvalMaterialsCurrent: async () => false }),
    );
    expect(result.code).toBe('approval_materials_changed');
    expect(result.eligible).toBe(false);
  });

  it('is schema_missing when the persisted schema is for a different ATS', async () => {
    const staleSchema = { ...SCHEMA, ats: 'ashby' };
    const result = await canAutoSubmit(
      application({ requiredQuestionsJson: JSON.stringify(staleSchema) }),
      options(),
    );
    expect(result.code).toBe('schema_missing');
  });

  it('is schema_missing when the schema job id does not match the apply URL', async () => {
    const staleSchema = { ...SCHEMA, jobId: '9999' };
    const result = await canAutoSubmit(
      application({ requiredQuestionsJson: JSON.stringify(staleSchema) }),
      options(),
    );
    expect(result.code).toBe('schema_missing');
  });

  it('is unsupported_ats for an unknown ATS', async () => {
    const result = await canAutoSubmit(
      application(),
      options({ detect: async () => ({ type: 'workday' }) }),
    );
    expect(result.code).toBe('unsupported_ats');
  });

  it('is unsupported_ats when nothing is detected', async () => {
    const result = await canAutoSubmit(
      application(),
      options({ detect: async () => null }),
    );
    expect(result.code).toBe('unsupported_ats');
  });

  it('is account_required when an account/login is needed', async () => {
    const result = await canAutoSubmit(
      application({ accountStatus: 'needs_2fa' }),
      options(),
    );
    expect(result.code).toBe('account_required');
  });

  it('is resume_missing when no resume artifact exists', async () => {
    const result = await canAutoSubmit(
      application(),
      options({ resumeExists: async () => false }),
    );
    expect(result.code).toBe('resume_missing');
  });

  it('is schema_missing when no form schema is persisted', async () => {
    // Both the empty-string and the default empty-object ('{}') lack a
    // questions array, so no schema has been fetched yet.
    for (const requiredQuestionsJson of ['', '{}']) {
      const result = await canAutoSubmit(
        application({ requiredQuestionsJson }),
        options(),
      );
      expect(result.code).toBe('schema_missing');
    }
  });

  it('is missing_answers (with the list) when a required answer is absent', async () => {
    const result = await canAutoSubmit(
      application({ requiredAnswersJson: '{}' }),
      options(),
    );
    expect(result.code).toBe('missing_answers');
    expect(result.missingQuestions.map((q) => q.id)).toEqual(['first_name']);
  });

  // Detection that only recognizes Greenhouse, so an application is eligible
  // only if canAutoSubmit acted on the resolved Greenhouse URL — not the raw
  // Indeed applicationUrl (which would detect as nothing → unsupported_ats).
  const greenhouseOnlyDetect = async (url: string) =>
    url.includes('greenhouse.io') ? { type: 'greenhouse' } : null;

  it('routes auto-submit through resolvedApplyUrl when applicationUrl is an aggregator', async () => {
    const result = await canAutoSubmit(
      application({
        applicationUrl: 'https://www.indeed.com/viewjob?jk=abc',
        resolvedApplyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      }),
      options({ detect: greenhouseOnlyDetect }),
    );
    expect(result.code).toBe('eligible');
  });

  it('is schema_missing when resolvedApplyUrl points at a different job than the schema', async () => {
    const result = await canAutoSubmit(
      application({
        applicationUrl: 'https://www.indeed.com/viewjob?jk=abc',
        resolvedApplyUrl: 'https://boards.greenhouse.io/acme/jobs/999',
      }),
      options({ detect: greenhouseOnlyDetect }),
    );
    expect(result.code).toBe('schema_missing');
  });
});

describe('effectiveApplyUrl', () => {
  it('prefers resolvedApplyUrl, then applicationUrl, then applyUrl', () => {
    expect(
      effectiveApplyUrl({
        resolvedApplyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        applicationUrl: 'https://www.indeed.com/viewjob?jk=abc',
        applyUrl: 'https://example.com/raw',
      }),
    ).toBe('https://boards.greenhouse.io/acme/jobs/1');
    expect(
      effectiveApplyUrl({
        applicationUrl: 'https://www.indeed.com/viewjob?jk=abc',
        applyUrl: 'https://example.com/raw',
      }),
    ).toBe('https://www.indeed.com/viewjob?jk=abc');
    expect(effectiveApplyUrl({ applyUrl: 'https://example.com/raw' })).toBe(
      'https://example.com/raw',
    );
  });

  it('skips empty/blank values and returns empty when none are set', () => {
    expect(
      effectiveApplyUrl({
        resolvedApplyUrl: '   ',
        applicationUrl: 'https://example.com/app',
      }),
    ).toBe('https://example.com/app');
    expect(effectiveApplyUrl({})).toBe('');
  });
});
