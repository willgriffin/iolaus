import { describe, expect, it, vi } from 'vitest';
import { persistApplicationFormSchema } from './ats-form-schema.js';

const GREENHOUSE_URL = 'https://boards.greenhouse.io/acme/jobs/42';
const INDEED_URL = 'https://www.indeed.com/viewjob?jk=abc';

// fetchImpl that answers the Greenhouse Job Board API with a one-question schema.
function greenhouseFetch() {
  return (async () => ({
    ok: true,
    json: async () => ({
      questions: [
        {
          label: 'Why this role?',
          required: true,
          fields: [{ name: 'q_cover', type: 'textarea' }],
        },
      ],
    }),
  })) as unknown as typeof fetch;
}

describe('persistApplicationFormSchema aggregator resolution', () => {
  it('resolves an Indeed posting to the underlying ATS and persists the resolved url', async () => {
    const application: Record<string, unknown> = {
      applicationUrl: INDEED_URL,
      requiredQuestionsJson: '{}',
      resolvedApplyUrl: '',
    };
    const detect = vi.fn(async (_url: string) => ({ type: 'greenhouse' }));
    const resolveAggregator = vi.fn(async () => GREENHOUSE_URL);

    const result = await persistApplicationFormSchema(application, {
      detect,
      fetchImpl: greenhouseFetch(),
      resolveAggregator,
    });

    expect(resolveAggregator).toHaveBeenCalledWith(INDEED_URL);
    // Detection (and therefore schema fetch) runs against the resolved ATS url.
    expect(detect).toHaveBeenCalledWith(GREENHOUSE_URL);
    expect(application.resolvedApplyUrl).toBe(GREENHOUSE_URL);
    expect(result).toMatchObject({ persisted: true, ats: 'greenhouse' });
    expect(JSON.parse(String(application.requiredQuestionsJson))).toMatchObject(
      {
        ats: 'greenhouse',
        boardToken: 'acme',
        jobId: '42',
      },
    );
  });

  it('leaves the raw Indeed url in play (manual) when resolution misses', async () => {
    const application: Record<string, unknown> = {
      applicationUrl: INDEED_URL,
      requiredQuestionsJson: '{}',
      resolvedApplyUrl: '',
    };
    const detect = vi.fn(async (_url: string) => ({ type: 'generic' }));
    const resolveAggregator = vi.fn(async () => null);

    const result = await persistApplicationFormSchema(application, {
      detect,
      fetchImpl: greenhouseFetch(),
      resolveAggregator,
    });

    expect(detect).toHaveBeenCalledWith(INDEED_URL);
    expect(application.resolvedApplyUrl).toBe('');
    expect(result.persisted).toBe(false);
    expect(application.requiredQuestionsJson).toBe('{}');
  });

  it('does not invoke the resolver for a non-aggregator (direct ATS) url', async () => {
    const application: Record<string, unknown> = {
      applicationUrl: GREENHOUSE_URL,
      requiredQuestionsJson: '{}',
      resolvedApplyUrl: '',
    };
    const detect = vi.fn(async (_url: string) => ({ type: 'greenhouse' }));
    const resolveAggregator = vi.fn(async () => GREENHOUSE_URL);

    const result = await persistApplicationFormSchema(application, {
      detect,
      fetchImpl: greenhouseFetch(),
      resolveAggregator,
    });

    expect(resolveAggregator).not.toHaveBeenCalled();
    expect(application.resolvedApplyUrl).toBe('');
    expect(result).toMatchObject({ persisted: true, ats: 'greenhouse' });
  });

  it('clears a stale resolvedApplyUrl when the source url is no longer an aggregator', async () => {
    const application: Record<string, unknown> = {
      applicationUrl: GREENHOUSE_URL,
      requiredQuestionsJson: '{}',
      // Left over from a prior run when applicationUrl was an Indeed posting.
      resolvedApplyUrl: 'https://boards.greenhouse.io/old/jobs/1',
    };
    const detect = vi.fn(async (_url: string) => ({ type: 'greenhouse' }));

    await persistApplicationFormSchema(application, {
      detect,
      fetchImpl: greenhouseFetch(),
    });

    expect(application.resolvedApplyUrl).toBe('');
    expect(detect).toHaveBeenCalledWith(GREENHOUSE_URL);
  });

  it('clears a stale resolvedApplyUrl when the source is still Indeed but resolution misses', async () => {
    const application: Record<string, unknown> = {
      applicationUrl: INDEED_URL,
      requiredQuestionsJson: '{}',
      // Resolved from a *different* Indeed posting on a prior run; the current
      // posting is Indeed-hosted/blocked, so resolution now misses.
      resolvedApplyUrl: 'https://boards.greenhouse.io/old/jobs/1',
    };
    const detect = vi.fn(async (_url: string) => ({ type: 'generic' }));
    const resolveAggregator = vi.fn(async () => null);

    const result = await persistApplicationFormSchema(application, {
      detect,
      fetchImpl: greenhouseFetch(),
      resolveAggregator,
    });

    // The stale ATS url must not survive to shadow the current Indeed posting.
    expect(application.resolvedApplyUrl).toBe('');
    expect(detect).toHaveBeenCalledWith(INDEED_URL);
    expect(result.persisted).toBe(false);
  });

  it('clears a stale resolvedApplyUrl even when the application has no apply url', async () => {
    const application: Record<string, unknown> = {
      applicationUrl: '',
      applyUrl: '',
      requiredQuestionsJson: '{}',
      // Left over after both apply URLs were cleared — must not survive to let
      // canAutoSubmit evaluate against a phantom job.
      resolvedApplyUrl: 'https://boards.greenhouse.io/old/jobs/1',
    };
    const detect = vi.fn(async (_url: string) => ({ type: 'greenhouse' }));

    const result = await persistApplicationFormSchema(application, { detect });

    expect(application.resolvedApplyUrl).toBe('');
    expect(detect).not.toHaveBeenCalled();
    expect(result.persisted).toBe(false);
  });
});
