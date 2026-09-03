import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordAgentAudit } from './application-workflow.js';
import {
  preflightPosting,
  recordPostingPreflight,
  requireFreshPostingPreflight,
} from './posting-preflight.js';

vi.mock('./application-workflow.js', () => ({
  recordAgentAudit: vi.fn(async () => ({ id: 'run-1' })),
}));

const GREENHOUSE_JOB = 'https://job-boards.greenhouse.io/temporal/jobs/123';
const ASHBY_JOB = 'https://jobs.ashbyhq.com/acme/job-1';
const LEVER_JOB = 'https://jobs.lever.co/acme/job-1';

function response(
  options: { body?: string; location?: string; status?: number } = {},
) {
  const status = options.status ?? 200;
  const bytes = new TextEncoder().encode(
    options.body ?? '<form id="application-form">Job Application 123</form>',
  );
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers(
      options.location ? { location: options.location } : undefined,
    ),
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

describe('preflightPosting', () => {
  it('classifies a known ATS posting with its job id intact as live', async () => {
    const fetchImpl = vi.fn(async () => response());
    const result = await preflightPosting({
      checkedAt: new Date('2026-08-25T00:00:00.000Z'),
      fetchImpl,
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'live',
      evidence: { provider: 'greenhouse', responseStatus: 200 },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(GREENHOUSE_JOB),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('detects the walkthrough redirect from a job to a Greenhouse board page', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ location: '/temporal', status: 302 }))
      .mockResolvedValueOnce(response());
    const result = await preflightPosting({
      fetchImpl,
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'closed',
      reason: 'redirected_to_different_posting',
      evidence: { redirected: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not close an opportunity when a known ATS redirect changes its job id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response({ location: '/temporal/jobs/456', status: 302 }),
      )
      .mockResolvedValueOnce(response({ status: 404 }));

    const result = await preflightPosting({
      fetchImpl,
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'redirected_to_different_posting',
      evidence: { redirected: true, responseStatus: 404 },
    });
  });

  it('does not treat a redirect to another ATS board as the same posting', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response({ location: '/another-company/jobs/123', status: 302 }),
      )
      .mockResolvedValueOnce(response({ status: 404 }));

    const result = await preflightPosting({
      fetchImpl,
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'redirected_to_different_posting',
      evidence: { redirected: true, responseStatus: 404 },
    });
  });

  it('detects a closed page marker without storing the whole response body', async () => {
    const result = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          body: 'This job has been closed. Please browse open roles.',
        }),
      ),
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'closed',
      reason: 'closed_page_marker',
      evidence: {
        evidenceExcerpt: 'Closed-page marker detected.',
      },
    });
  });

  it('fails safely as inconclusive for an unavailable or unsupported posting', async () => {
    const unavailable = await preflightPosting({
      fetchImpl: vi.fn(async () => response({ status: 503 })),
      postingUrl: GREENHOUSE_JOB,
    });
    const unsupported = await preflightPosting({
      postingUrl: 'https://example.com/jobs/123',
    });

    expect(unavailable).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unavailable_status',
    });
    expect(unsupported).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unsupported_posting_host',
    });
  });

  it('does not fetch incomplete, insecure, or lookalike posting URLs', async () => {
    const fetchImpl = vi.fn(async () => response());

    const missingJobId = await preflightPosting({
      fetchImpl,
      postingUrl: 'https://job-boards.greenhouse.io/temporal',
    });
    const insecure = await preflightPosting({
      fetchImpl,
      postingUrl: GREENHOUSE_JOB.replace('https:', 'http:'),
    });
    const lookalike = await preflightPosting({
      fetchImpl,
      postingUrl: 'https://not-greenhouse.io/jobs/123',
    });
    const nonDefaultPort = await preflightPosting({
      fetchImpl,
      postingUrl: 'https://job-boards.greenhouse.io:8443/temporal/jobs/123',
    });
    const credentialed = await preflightPosting({
      fetchImpl,
      postingUrl:
        'https://will:secret@job-boards.greenhouse.io/temporal/jobs/123',
    });

    expect(missingJobId).toMatchObject({
      outcome: 'inconclusive',
      reason: 'missing_job_id',
    });
    expect(insecure).toMatchObject({
      outcome: 'inconclusive',
      reason: 'invalid_url',
    });
    expect(lookalike).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unsupported_posting_host',
    });
    expect(nonDefaultPort).toMatchObject({
      outcome: 'inconclusive',
      reason: 'invalid_url',
    });
    expect(credentialed).toMatchObject({
      outcome: 'inconclusive',
      reason: 'invalid_url',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('canonicalizes a supported Greenhouse form URL without persisting its query', async () => {
    const formUrl =
      'https://boards.greenhouse.io/embed/job_app?for=temporal&token=123&source=secret';
    const fetchImpl = vi.fn(async () => response());

    const result = await preflightPosting({
      fetchImpl,
      postingUrl: formUrl,
    });

    expect(result).toMatchObject({
      outcome: 'live',
      evidence: { finalUrl: GREENHOUSE_JOB },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(GREENHOUSE_JOB),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('canonicalizes a hosted Greenhouse gh_jid URL without its query', async () => {
    const fetchImpl = vi.fn(async () => response());

    const result = await preflightPosting({
      fetchImpl,
      postingUrl:
        'https://boards.greenhouse.io/temporal?gh_jid=123&source=secret',
    });

    expect(result).toMatchObject({
      outcome: 'live',
      evidence: { finalUrl: GREENHOUSE_JOB },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(GREENHOUSE_JOB),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('does not follow a redirect away from a known ATS host', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ location: 'https://example.com/jobs/123', status: 302 }),
    );

    const result = await preflightPosting({
      fetchImpl,
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unsafe_redirect',
      evidence: { finalUrl: GREENHOUSE_JOB },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies a malformed redirect header as an auditable safe failure', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ location: 'https://[invalid', status: 302 }),
    );

    const result = await preflightPosting({
      fetchImpl,
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unsafe_redirect',
      evidence: { finalUrl: GREENHOUSE_JOB },
    });
  });

  it('does not follow a redirect to a known host on a non-default port', async () => {
    const result = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          location: 'https://jobs.lever.co:8443/acme/job-1',
          status: 302,
        }),
      ),
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unsafe_redirect',
    });
  });

  it('does not follow a credential-bearing redirect URL', async () => {
    const result = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          location:
            'https://will:secret@job-boards.greenhouse.io/temporal/jobs/123',
          status: 302,
        }),
      ),
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unsafe_redirect',
    });
  });

  it('does not fetch malformed Greenhouse paths that lack a board token', async () => {
    const fetchImpl = vi.fn(async () => response());

    const jobsPath = await preflightPosting({
      fetchImpl,
      postingUrl: 'https://job-boards.greenhouse.io/jobs/123',
    });
    const embedPath = await preflightPosting({
      fetchImpl,
      postingUrl: 'https://boards.greenhouse.io/embed/job_app?gh_jid=123',
    });

    expect(jobsPath).toMatchObject({
      outcome: 'inconclusive',
      reason: 'missing_job_id',
    });
    expect(embedPath).toMatchObject({
      outcome: 'inconclusive',
      reason: 'missing_job_id',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not classify an unreadable successful response as live', async () => {
    const unreadable = {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('stream interrupted'));
        },
      }),
      headers: new Headers(),
      ok: true,
      status: 200,
    } as unknown as Response;

    const result = await preflightPosting({
      fetchImpl: vi.fn(async () => unreadable),
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'fetch_error',
    });
  });

  it('requires positive job-page evidence and detects expired postings', async () => {
    const interstitial = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({ body: 'Job Application 123 — Access Denied' }),
      ),
      postingUrl: GREENHOUSE_JOB,
    });
    const expired = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          body: 'This job is no longer available. Job Application 123',
        }),
      ),
      postingUrl: GREENHOUSE_JOB,
    });
    const liveWithDisclaimer = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          body: '<form id="application-form">Apply now</form> This agency is not accepting applications for unrelated roles.',
        }),
      ),
      postingUrl: GREENHOUSE_JOB,
    });
    const staleFormOnClosedPosting = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          body: '<form id="application-form"></form> This job has been closed.',
        }),
      ),
      postingUrl: GREENHOUSE_JOB,
    });

    expect(interstitial).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unverified_page',
    });
    expect(expired).toMatchObject({
      outcome: 'closed',
      reason: 'closed_page_marker',
    });
    expect(liveWithDisclaimer).toMatchObject({
      outcome: 'live',
      reason: 'verified_live',
    });
    expect(staleFormOnClosedPosting).toMatchObject({
      outcome: 'closed',
      reason: 'closed_page_marker',
    });
  });

  it('requires a form with usable fields for Ashby and Lever', async () => {
    const ashby = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          body: '"applicationForm":{"formDefinition":{"sections":[]}}',
        }),
      ),
      postingUrl: ASHBY_JOB,
    });
    const lever = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({ body: '<li class="application-question"></li>' }),
      ),
      postingUrl: LEVER_JOB,
    });

    expect(ashby).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unverified_page',
    });
    expect(lever).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unverified_page',
    });
  });

  it('recognizes Ashby structured job metadata within the bounded page scan', async () => {
    const result = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          body: `${'x'.repeat(70_000)}<script type="application/ld+json">${JSON.stringify(
            {
              '@type': 'JobPosting',
              directApply: true,
              identifier: { value: 'job-1' },
            },
          )}</script>`,
        }),
      ),
      postingUrl: ASHBY_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'live',
      reason: 'verified_live',
    });
  });

  it('requires the matching Ashby job id in structured metadata', async () => {
    const result = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          body: `<script type="application/ld+json">${JSON.stringify({
            '@type': 'JobPosting',
            directApply: true,
            identifier: { value: 'different-job' },
          })}</script>`,
        }),
      ),
      postingUrl: ASHBY_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'unverified_page',
    });
  });

  it('releases bodies after a redirect or non-success response', async () => {
    const redirectResponse = response({
      location: 'https://example.com/jobs/123',
      status: 302,
    });
    const closedResponse = response({ status: 404 });
    const redirectBody = redirectResponse.body;
    const closedBody = closedResponse.body;
    if (!redirectBody || !closedBody) {
      throw new Error('Test responses must include a readable body.');
    }
    const cancelRedirect = vi.spyOn(redirectBody, 'cancel');
    const cancelClosed = vi.spyOn(closedBody, 'cancel');

    await preflightPosting({
      fetchImpl: vi.fn(async () => redirectResponse),
      postingUrl: GREENHOUSE_JOB,
    });
    await preflightPosting({
      fetchImpl: vi.fn(async () => closedResponse),
      postingUrl: GREENHOUSE_JOB,
    });

    expect(cancelRedirect).toHaveBeenCalled();
    expect(cancelClosed).toHaveBeenCalled();
  });

  it('scans a bounded but realistic Greenhouse page prefix for its form', async () => {
    const result = await preflightPosting({
      fetchImpl: vi.fn(async () =>
        response({
          body: `${'x'.repeat(20_000)}<form id="application-form">Job Application 123</form>`,
        }),
      ),
      postingUrl: GREENHOUSE_JOB,
    });

    expect(result).toMatchObject({
      outcome: 'live',
      reason: 'verified_live',
    });
  });

  it('does not start a redirect follow-up after the total deadline expires', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ location: '/temporal/jobs/123', status: 302 }),
    );
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(5);
    let result: Awaited<ReturnType<typeof preflightPosting>> | undefined;

    try {
      result = await preflightPosting({
        fetchImpl,
        postingUrl: GREENHOUSE_JOB,
        timeoutMs: 5,
      });
    } finally {
      now.mockRestore();
    }

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      reason: 'fetch_error',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an ATS request or response body exceeds its deadline', async () => {
    const stalledFetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const stalledBody = {
      body: {
        getReader: () => ({
          cancel: vi.fn(async () => undefined),
          read: () =>
            new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        }),
      },
      headers: new Headers(),
      ok: true,
      status: 200,
    } as unknown as Response;

    const stalledRequest = await preflightPosting({
      fetchImpl: stalledFetch as typeof fetch,
      postingUrl: GREENHOUSE_JOB,
      timeoutMs: 5,
    });
    const stalledResponse = await preflightPosting({
      fetchImpl: vi.fn(async () => stalledBody),
      postingUrl: GREENHOUSE_JOB,
      timeoutMs: 5,
    });
    const slowReader = {
      cancel: vi.fn(async () => undefined),
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array([65]),
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    };
    const slowBody = {
      body: { getReader: () => slowReader },
      headers: new Headers(),
      ok: true,
      status: 200,
    } as unknown as Response;
    const now = vi.spyOn(Date, 'now');
    let currentTime = 0;
    now.mockImplementation(() => {
      currentTime += 1;
      return currentTime;
    });
    let slowResponse: Awaited<ReturnType<typeof preflightPosting>> | undefined;
    try {
      slowResponse = await preflightPosting({
        fetchImpl: vi.fn(async () => slowBody),
        postingUrl: GREENHOUSE_JOB,
        timeoutMs: 2,
      });
    } finally {
      now.mockRestore();
    }

    expect(stalledRequest).toMatchObject({
      outcome: 'inconclusive',
      reason: 'fetch_error',
    });
    expect(stalledResponse).toMatchObject({
      outcome: 'inconclusive',
      reason: 'fetch_error',
    });
    expect(slowResponse).toMatchObject({
      outcome: 'inconclusive',
      reason: 'fetch_error',
    });
    expect(slowReader.read).toHaveBeenCalledTimes(1);
  });
});

describe('recordPostingPreflight', () => {
  it('records bounded evidence against the opportunity using AgentRun', async () => {
    const result = await recordPostingPreflight({
      fetchImpl: vi.fn(async () => response()),
      opportunity: { id: 'opp-1', sourceId: 'source-1' },
      postingUrl: GREENHOUSE_JOB,
      user: { id: 'user-1' },
    });

    expect(result.agentRun).toEqual({ id: 'run-1' });
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        opportunity: { id: 'opp-1', sourceId: 'source-1' },
        runType: 'posting_preflight',
        status: 'completed',
        user: { id: 'user-1' },
      }),
    );
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          evidence: expect.objectContaining({
            finalUrl: GREENHOUSE_JOB,
            responseStatus: 200,
          }),
        }),
      }),
    );
  });

  it('rejects credentials without persisting them in preflight evidence', async () => {
    const secretUrl = `${GREENHOUSE_JOB.replace('https://', 'https://will:secret@')}?token=secret#fragment`;

    await recordPostingPreflight({
      fetchImpl: vi.fn(async () => response()),
      opportunity: { id: 'opp-1', sourceId: 'source-1' },
      postingUrl: secretUrl,
      user: { id: 'user-1' },
    });

    const audit = vi.mocked(recordAgentAudit).mock.calls.at(-1)?.[0];
    expect(audit).toMatchObject({
      input: { postingUrl: '' },
      output: { reason: 'invalid_url' },
    });
    expect(JSON.stringify(audit)).not.toContain('secret');
  });

  it('falls back from an unsupported company URL to a valid ATS apply URL', async () => {
    await recordPostingPreflight({
      fetchImpl: vi.fn(async () => response()),
      opportunity: {
        applyUrl: GREENHOUSE_JOB,
        canonicalUrl: 'https://company.example/jobs?gh_jid=123',
        id: 'opp-1',
        sourceId: 'source-1',
      },
      user: { id: 'user-1' },
    });

    const audit = vi.mocked(recordAgentAudit).mock.calls.at(-1)?.[0];
    expect(audit).toMatchObject({
      input: { postingUrl: GREENHOUSE_JOB },
      output: { evidence: { finalUrl: GREENHOUSE_JOB } },
    });
  });
});

describe('requireFreshPostingPreflight', () => {
  beforeEach(() => {
    vi.mocked(recordAgentAudit).mockClear();
  });

  it('runs a new live preflight before permitting application work', async () => {
    const opportunity = {
      id: 'opp-1',
      postingUrl: GREENHOUSE_JOB,
      save: vi.fn(async () => {}),
    };

    const result = await requireFreshPostingPreflight({
      action: 'generate_packet',
      fetchImpl: vi.fn(async () => response()),
      opportunity,
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({
      outcome: 'live',
      overridden: false,
      reason: 'verified_live',
    });
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ action: 'posting_preflight' }),
        runType: 'posting_preflight',
      }),
    );
  });

  it('archives a conclusively closed posting and refuses application work', async () => {
    const onClosed = vi.fn(async () => {});
    const opportunity = {
      freshness: 'fresh',
      id: 'opp-1',
      postingUrl: GREENHOUSE_JOB,
      save: vi.fn(async () => {}),
      status: 'recommended',
    };

    await expect(
      requireFreshPostingPreflight({
        action: 'accept_opportunity',
        fetchImpl: vi.fn(async () =>
          response({ body: 'This job has been closed.' }),
        ),
        onClosed,
        opportunity,
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'This posting is closed and has been archived. Application work cannot continue.',
      },
      status: 409,
    });

    expect(opportunity).toMatchObject({
      freshness: 'stale',
      humanReviewStatus: 'archived',
      status: 'archived',
    });
    expect(opportunity.save).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('returns a closed result after cleanup when a lifecycle caller defers failure', async () => {
    const onClosed = vi.fn(async () => {});
    const opportunity = {
      id: 'opp-1',
      postingUrl: GREENHOUSE_JOB,
      save: vi.fn(async () => {}),
      status: 'recommended',
    };

    await expect(
      requireFreshPostingPreflight({
        action: 'create_application_draft',
        deferFailure: true,
        fetchImpl: vi.fn(async () =>
          response({ body: 'This job has been closed.' }),
        ),
        onClosed,
        opportunity,
        user: { id: 'user-1' },
      }),
    ).resolves.toMatchObject({ outcome: 'closed', overridden: false });

    expect(opportunity).toMatchObject({
      freshness: 'stale',
      status: 'archived',
    });
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('blocks an inconclusive posting without an explicit owner override', async () => {
    await expect(
      requireFreshPostingPreflight({
        action: 'create_application_draft',
        fetchImpl: vi.fn(async () => response({ status: 503 })),
        opportunity: {
          id: 'opp-1',
          postingUrl: GREENHOUSE_JOB,
          save: vi.fn(async () => {}),
        },
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'The posting could not be verified as live. An authenticated owner must enter a reason to override this check.',
      },
      status: 409,
    });
    expect(recordAgentAudit).toHaveBeenCalledTimes(1);
  });

  it('records an owner-attributed override separately from unverified evidence', async () => {
    const result = await requireFreshPostingPreflight({
      action: 'accept_opportunity',
      fetchImpl: vi.fn(async () => response({ status: 503 })),
      opportunity: {
        id: 'opp-1',
        organizationProfileId: 'org-1',
        postingUrl: GREENHOUSE_JOB,
        save: vi.fn(async () => {}),
      },
      overrideReason: 'I checked the employer page and it remains open.',
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({
      outcome: 'inconclusive',
      overridden: true,
      reason: 'unavailable_status',
    });
    expect(recordAgentAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: {
          action: 'override_posting_preflight',
          actor: 'owner',
          overrideReason: 'I checked the employer page and it remains open.',
          preflightReason: 'unavailable_status',
          workflowAction: 'accept_opportunity',
        },
        output: {
          outcome: 'inconclusive',
          overridden: true,
          reason: 'unavailable_status',
          verifiedLive: false,
        },
        runType: 'posting_preflight_override',
        status: 'completed',
        user: { id: 'user-1' },
      }),
    );
  });
});
