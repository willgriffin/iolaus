import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCollection = vi.hoisted(() => vi.fn());
const privateEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);
const recordAgentAudit = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('$env/dynamic/private', () => ({
  env: privateEnv,
}));

vi.mock('./smrt.js', () => ({
  getCollection,
}));

vi.mock('./application-workflow.js', () => ({
  recordAgentAudit,
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function coverageResponse(messages: unknown[]): { content: string } {
  const user = (messages as Array<{ content: string }>)[1].content;
  const marker = 'provenance:\n';
  const payload = JSON.parse(
    user.slice(user.indexOf(marker) + marker.length),
  ) as {
    sourceClauses: Array<{ id: string; text: string }>;
    headingClauseIds: string[];
  };
  const body = payload.sourceClauses.filter(
    ({ id }) => !payload.headingClauseIds.includes(id),
  );
  return {
    content: JSON.stringify({
      requirementCoverage: {
        requirements: body.map(({ id, text }, index) => ({
          id: `r${index + 1}`,
          text,
          clauseIds: [id],
          importance: 'unknown',
        })),
        dispositions: payload.sourceClauses.map(({ id }) => {
          const index = body.findIndex((clause) => clause.id === id);
          return index < 0
            ? {
                clauseId: id,
                type: 'nonrequirement',
                requirementIds: [],
                exclusionRule: 'section_heading',
              }
            : {
                clauseId: id,
                type: 'role_context',
                requirementIds: [`r${index + 1}`],
              };
        }),
      },
    }),
  };
}

function coverageTexts(opportunity: Record<string, unknown>): string[] {
  return JSON.parse(
    String(opportunity.preparedPostingJson),
  ).requirementCoverage.requirements.map(({ text }: { text: string }) => text);
}

describe('processOpportunityWithLlm', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // Admit the existing bounded extraction plus independent coverage audit.
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT', '4');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT', '80000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS', '100000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_MAX_INPUT_TOKENS', '6000');
    for (const key of Object.keys(privateEnv)) delete privateEnv[key];
    getCollection.mockReset();
    recordAgentAudit.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('scrapes posting text, refetches the saved opportunity, and preserves literal coverage', async () => {
    const initialOpportunity = {
      id: 'opp-1',
      postingUrl: 'https://boards.greenhouse.io/embed/job_board?for=acme',
      save: vi.fn(),
      title: 'Staff Software Engineer',
    };
    const loadedOpportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      ...initialOpportunity,
      save: vi.fn(async () => {}),
    };
    const collection = {
      get: vi
        .fn()
        .mockResolvedValueOnce(initialOpportunity)
        .mockResolvedValueOnce(loadedOpportunity)
        .mockResolvedValueOnce(loadedOpportunity),
    };
    getCollection.mockResolvedValue(collection);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          jobs: [
            {
              absolute_url: 'https://example.com/jobs/staff-engineer',
              content:
                '<p>Build AI workflow systems.</p><p>Requirements</p><ul><li>TypeScript</li></ul>',
              id: 123,
              location: { name: 'Remote' },
              title: 'Staff Software Engineer',
            },
          ],
        }),
      ),
    );

    const chatMock = vi.fn(async (messages: unknown[], _options?: unknown) =>
      coverageResponse(messages),
    );
    const aiClient = {
      chat: chatMock,
    };

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient,
      model: 'openai/gpt-6-luna',
    });

    expect(collection.get).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: 'processed',
      updatedFields: [
        'seniority',
        'preparedPostingJson',
        'applyUrl',
        'applyMethod',
      ],
    });
    expect(loadedOpportunity.descriptionRaw).toContain(
      'Build AI workflow systems.',
    );
    expect(loadedOpportunity.requiredSkills).toBe('');
    expect(loadedOpportunity.salaryMin).toBeNull();
    expect(coverageTexts(loadedOpportunity)).toEqual(
      expect.arrayContaining(['Build AI workflow systems.', '- TypeScript']),
    );
    expect(loadedOpportunity.save).toHaveBeenCalledTimes(3);

    const [messages, chatOptions] = chatMock.mock.calls[0] as [
      Array<{ content: string }>,
      Record<string, unknown>,
    ];
    // System instructions + a user message carrying the posting text.
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('Build AI workflow systems.');
    expect(chatOptions).toMatchObject({
      maxTokens: 4_096,
      model: 'openai/gpt-6-luna',
      reasoning: { effort: 'low', maxTokens: 1_024 },
    });
  });

  it('uses the dedicated smrt-config profile for extraction by default', async () => {
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      descriptionRaw: 'Backend platform role requiring TypeScript.',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      save: vi.fn(async () => {}),
      title: 'Staff Software Engineer',
    };
    const collection = {
      get: vi.fn().mockResolvedValue(opportunity),
    };
    getCollection.mockResolvedValue(collection);

    const chatMock = vi.fn(
      async (messages: unknown[], _options?: Record<string, unknown>) =>
        coverageResponse(messages),
    );
    const aiClient = {
      chat: chatMock,
    };

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient,
      profile: 'opportunity-intelligence-extraction',
    });

    expect(result).toMatchObject({
      status: 'processed',
      updatedFields: [
        'seniority',
        'preparedPostingJson',
        'applyUrl',
        'applyMethod',
      ],
    });
    const chatOptions = chatMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(chatOptions).toMatchObject({
      maxTokens: 4_096,
      model: 'openai/gpt-6-luna',
    });
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          model: 'openai/gpt-6-luna',
          profile: 'opportunity-intelligence-extraction',
          provider: 'bifrost',
        }),
      }),
    );
  });

  it('extracts the first balanced JSON object from wrapped model output', async () => {
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      descriptionRaw: 'Build {agent} workflow systems.',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      save: vi.fn(async () => {}),
      title: 'Staff Software Engineer',
    };
    const collection = {
      get: vi.fn().mockResolvedValue(opportunity),
    };
    getCollection.mockResolvedValue(collection);

    const chatMock = vi.fn(
      async (messages: unknown[], _options?: Record<string, unknown>) => ({
        content: [
          'Here is the extracted JSON:',
          coverageResponse(messages).content,
          'I also considered {"ignored":true}.',
        ].join('\n'),
      }),
    );

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient: { chat: chatMock },
    });

    expect(result).toMatchObject({ status: 'processed' });
    expect(result.updatedFields).toContain('preparedPostingJson');
    expect(coverageTexts(opportunity)).toEqual([
      'Build {agent} workflow systems.',
    ]);
    expect(opportunity.descriptionSummary).toBeUndefined();
    expect(opportunity.requiredSkills).toBeUndefined();

    const chatOptions = chatMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(chatOptions).toMatchObject({
      responseFormat: { type: 'json_object' },
      reasoning: { effort: 'low', maxTokens: 1_024 },
    });
  });

  it('preserves deterministic display fields during coverage-only extraction', async () => {
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      descriptionRaw: 'Remote full-time role requiring TypeScript.',
      employmentType: 'full_time',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      requiredSkills: 'TypeScript',
      salaryMin: 150000,
      save: vi.fn(async () => {}),
      title: 'Staff Software Engineer',
      workMode: 'remote',
    };
    const collection = {
      get: vi.fn().mockResolvedValue(opportunity),
    };
    getCollection.mockResolvedValue(collection);

    const chatMock = vi.fn(async (messages: unknown[]) =>
      coverageResponse(messages),
    );

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient: { chat: chatMock },
    });

    expect(result).toMatchObject({
      status: 'processed',
      updatedFields: [
        'seniority',
        'preparedPostingJson',
        'applyUrl',
        'applyMethod',
      ],
    });
    expect(opportunity).toMatchObject({
      employmentType: 'full_time',
      requiredSkills: 'TypeScript',
      salaryMin: 150000,
      workMode: 'remote',
    });
    expect(opportunity.preferredSkills).toBeUndefined();
    expect(coverageTexts(opportunity)).toEqual([
      'Remote full-time role requiring TypeScript.',
    ]);
  });

  it('builds extraction prompts from the canonical source snapshot', async () => {
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      applyMethod: 'company_site',
      applyUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Stale derived posting text.',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      requiredSkills: 'Stale extracted skill',
      save: vi.fn(async () => {}),
      sourceContentJson: JSON.stringify({
        descriptionRaw: 'Canonical source posting requires TypeScript.',
        requiredSkills: 'TypeScript',
      }),
      title: 'Staff Software Engineer',
    };
    getCollection.mockResolvedValue({
      get: vi.fn().mockResolvedValue(opportunity),
    });
    const chatMock = vi.fn(async (messages: unknown[]) =>
      coverageResponse(messages),
    );

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    await processOpportunityWithLlm('opp-1', {
      aiClient: { chat: chatMock },
    });

    const messages = chatMock.mock.calls[0]?.[0] as Array<{ content: string }>;
    expect(messages[1]?.content).toContain(
      'Canonical source posting requires TypeScript.',
    );
    expect(messages[1]?.content).not.toContain('Stale derived posting text.');
    expect(messages[1]?.content).not.toContain('Stale extracted skill');
  });

  it('discards extraction writes when the source fingerprint changes in flight', async () => {
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      descriptionRaw: 'Backend platform role requiring TypeScript.',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      save: vi.fn(async () => {}),
      sourceContentFingerprint: 'fingerprint-v1',
      sourceContentVersion: 1,
      title: 'Staff Software Engineer',
    };
    getCollection.mockResolvedValue({
      get: vi.fn().mockResolvedValue(opportunity),
    });
    const fencedOpportunityUpdate = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient: {
        chat: vi.fn(async (messages: unknown[]) => coverageResponse(messages)),
      },
      expectedSourceContentFingerprint: 'fingerprint-v1',
      fencedOpportunityUpdate,
      sourceContentVersion: 1,
    });

    expect(result).toMatchObject({
      message: 'Discarded stale opportunity extraction results.',
      status: 'skipped',
      updatedFields: [],
    });
    expect(fencedOpportunityUpdate).toHaveBeenLastCalledWith(
      'opp-1',
      'fingerprint-v1',
      expect.objectContaining({ preparedPostingJson: expect.any(String) }),
      1,
    );
    expect(opportunity.save).not.toHaveBeenCalled();
  });

  it('audits coverage-only extraction as stale when its source changes in flight', async () => {
    const opportunityV1: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      applyMethod: 'company_site',
      applyUrl: 'https://example.com/jobs/staff-engineer',
      descriptionRaw: 'Backend platform role requiring TypeScript.',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      save: vi.fn(async () => {}),
      sourceContentFingerprint: 'fingerprint-v1',
      sourceContentVersion: 1,
      title: 'Backend Software Engineer',
    };
    getCollection.mockResolvedValue({
      get: vi.fn().mockResolvedValue(opportunityV1),
    });

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const fencedOpportunityUpdate = vi.fn(
      async (_id: string, expected: string) =>
        opportunityV1.sourceContentFingerprint === expected,
    );
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient: {
        chat: vi.fn(async (messages: unknown[]) => {
          opportunityV1.sourceContentFingerprint = 'fingerprint-v2';
          return coverageResponse(messages);
        }),
      },
      expectedSourceContentFingerprint: 'fingerprint-v1',
      fencedOpportunityUpdate,
      sourceContentVersion: 1,
      sourceCrawlId: 'crawl-1',
      sourceCrawlItemId: 'crawl-item-1',
      sourceId: 'source-1',
    });

    expect(result).toMatchObject({
      message: 'Discarded stale opportunity extraction results.',
      stale: true,
      status: 'skipped',
      updatedFields: [],
    });
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          contentFingerprint: 'fingerprint-v1',
          contentVersion: 1,
          sourceCrawlId: 'crawl-1',
          sourceCrawlItemId: 'crawl-item-1',
          sourceId: 'source-1',
        }),
        output: expect.objectContaining({
          discardedAsStale: true,
          updatedFields: ['preparedPostingJson'],
        }),
        status: 'succeeded',
      }),
    );
    expect(fencedOpportunityUpdate).toHaveBeenCalledTimes(2);
    expect(opportunityV1.save).not.toHaveBeenCalled();
  });

  it('returns an audited error when extraction times out', async () => {
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      descriptionRaw: 'Backend platform role requiring TypeScript.',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      save: vi.fn(async () => {}),
      title: 'Staff Software Engineer',
    };
    const collection = {
      get: vi.fn().mockResolvedValue(opportunity),
    };
    getCollection.mockResolvedValue(collection);

    const chatMock = vi.fn(
      async () =>
        await new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('AI request timed out after 1ms')),
            1,
          ),
        ),
    );
    const aiClient = {
      chat: chatMock,
    };

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient,
      timeout: 1,
    });

    expect(result).toMatchObject({
      message: 'AI request timed out after 1ms',
      status: 'error',
    });
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'AI request timed out after 1ms',
        status: 'failed',
      }),
    );
  });

  it('returns an audited error when extraction returns invalid JSON', async () => {
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      descriptionRaw: 'Backend platform role requiring TypeScript.',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      save: vi.fn(async () => {}),
      title: 'Staff Software Engineer',
    };
    const collection = {
      get: vi.fn().mockResolvedValue(opportunity),
    };
    getCollection.mockResolvedValue(collection);

    const chatMock = vi.fn(async () => ({ content: 'not json' }));

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient: { chat: chatMock },
    });

    expect(result).toMatchObject({
      message: 'LLM extraction returned invalid JSON.',
      status: 'error',
    });
    expect(opportunity.save).toHaveBeenCalledOnce();
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'LLM extraction returned invalid JSON.',
        output: expect.objectContaining({
          rawContentLength: 'not json'.length,
          rawContentPreview: 'not json',
          rawContentTruncated: false,
        }),
        status: 'failed',
      }),
    );
  });

  it('reports bifrost configuration when no provider key is available', async () => {
    vi.stubEnv('BIFROST_API_KEY', '');
    vi.stubEnv('HAVE_AI_API_KEY', '');
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      descriptionRaw: 'Backend platform role requiring TypeScript.',
      id: 'opp-1',
      postingUrl: 'https://example.com/jobs/staff-engineer',
      save: vi.fn(async () => {}),
      title: 'Staff Software Engineer',
    };
    const collection = {
      get: vi.fn().mockResolvedValue(opportunity),
    };
    getCollection.mockResolvedValue(collection);

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1');

    expect(result).toMatchObject({
      message:
        'Configure the dedicated key for the explicitly selected opportunity-intelligence profile before extraction.',
      opportunityId: 'opp-1',
      status: 'error',
    });
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        error:
          'Configure the dedicated key for the explicitly selected opportunity-intelligence profile before extraction.',
        input: expect.objectContaining({
          opportunityId: 'opp-1',
          postingUrl: 'https://example.com/jobs/staff-engineer',
          profile: 'opportunity-intelligence-extraction',
          provider: 'bifrost',
        }),
        runType: 'opportunity_llm_extract',
        status: 'failed',
      }),
    );
  });

  it('audits extraction prerequisites when posting text is missing', async () => {
    const opportunity: Record<string, unknown> & {
      save: ReturnType<typeof vi.fn>;
    } = {
      id: 'opp-1',
      postingUrl: '',
      save: vi.fn(async () => {}),
      title: 'Staff Software Engineer',
    };
    const collection = {
      get: vi.fn().mockResolvedValue(opportunity),
    };
    getCollection.mockResolvedValue(collection);
    const chatMock = vi.fn(async () => ({
      content: JSON.stringify({ requiredSkills: ['TypeScript'] }),
    }));

    const { processOpportunityWithLlm } = await import('./opportunity-details');
    const result = await processOpportunityWithLlm('opp-1', {
      aiClient: { chat: chatMock },
    });

    expect(result).toMatchObject({
      message:
        'Opportunity needs captured posting text before LLM extraction can run.',
      opportunityId: 'opp-1',
      status: 'error',
    });
    expect(chatMock).not.toHaveBeenCalled();
    expect(recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        error:
          'Opportunity needs captured posting text before LLM extraction can run.',
        input: expect.objectContaining({
          opportunityId: 'opp-1',
          profile: 'opportunity-intelligence-extraction',
          provider: 'bifrost',
        }),
        runType: 'opportunity_llm_extract',
        status: 'failed',
      }),
    );
  });
});
