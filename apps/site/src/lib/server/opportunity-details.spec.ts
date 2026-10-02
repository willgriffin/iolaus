import { describe, expect, it, vi } from 'vitest';
import * as sourceAiConfig from './ai-config.js';
import vanta from './fixtures/ats/vanta-developer-experience.json';
import {
  buildOpportunityLlmExtractionMessages,
  buildOpportunityRequirementCoverageRepairMessages,
  extractSkillListingsFromDescription,
  normalizeOpportunityLlmExtraction,
  preflightOpportunityRequirementCoverageExtraction,
  preflightOpportunityRequirementCoverageRepair,
  processOpportunityRequirementCoverageRepair,
  resolveOpportunityDetails,
} from './opportunity-details';
import {
  pricingForOpportunityIntelligenceModel,
  reservedRequestSpendMicros,
} from './opportunity-intelligence-config.js';
import * as sourceGovernance from './opportunity-intelligence-governance.js';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import {
  buildRequirementCoverageSource,
  prepareRequirementCoverageRepair,
  requirementCoverageContextForOpportunity,
} from './opportunity-requirement-coverage.js';
import * as sourceCoverageProvider from './opportunity-requirement-coverage-provider.js';
import * as sourceSmrt from './smrt.js';

describe('source extraction reservation admission', () => {
  it('refuses injected clients and stops a revoked post-repair principal before cache persistence or audit', async () => {
    const opportunity = {
      id: 'source-opportunity',
      descriptionRaw: 'Requirements\nCuriosity.',
      sourceContentFingerprint: 'current-source',
      sourceContentVersion: 1,
      preparedPostingJson: JSON.stringify({ existingDisplay: 'preserve' }),
    };
    const posting = prepareOpportunityPosting(opportunity);
    const context = requirementCoverageContextForOpportunity({
      ...opportunity,
      preparedPostingFingerprint: posting.fingerprint,
    });
    const base = buildRequirementCoverageSource(context);
    base.dispositions = base.dispositions.map((row) =>
      row.clauseId === base.clauses[1].id
        ? { ...row, type: 'source_context' }
        : row,
    );
    const prepared = prepareRequirementCoverageRepair(
      context,
      base,
      'native-base-request',
      {
        sourceFingerprint: context.sourceFingerprint,
        sourceVersion: context.sourceVersion,
        extractionFingerprint: context.extractionFingerprint,
        auditInputFingerprint: 'native-negative-feedback',
        requestId: 'native-feedback-request',
        probabilities: Object.fromEntries(
          base.clauses.map((row) => [row.id, 0.5]),
        ),
      },
      [base.clauses[1].id],
      { inputTokenCeiling: 6000, maxOutputTokens: 4096 },
    );
    const persist = vi.fn(async () => true);
    let assertions = 0;
    const options = {
      agentRunId: 'native-source-run',
      expectedSourceContentFingerprint: context.sourceFingerprint,
      sourceContentVersion: 1,
      fencedOpportunityUpdate: persist,
      assertCurrentAuthority: vi.fn(async () => {
        if (++assertions >= 3) throw new Error('Principal revoked');
      }),
      baseReservation: { calls: 1, reservedTokens: 10096, spendMicros: 0 },
    };
    await expect(
      processOpportunityRequirementCoverageRepair(opportunity.id, prepared, {
        ...options,
        aiClient: { chat: vi.fn() } as never,
      }),
    ).rejects.toThrow('fresh authority');
    const get = vi.fn(async () => opportunity);
    const chat = vi.fn();
    const governance = vi
      .spyOn(sourceGovernance, 'executeGovernedOpportunityIntelligenceRequest')
      .mockImplementation(
        async () =>
          ({
            output: {
              requirementCoverage: {
                requirements: [
                  {
                    id: 'repair_r1',
                    text: 'Curiosity.',
                    clauseIds: ['c1'],
                    importance: 'unknown',
                  },
                ],
                dispositions: [
                  {
                    clauseId: 'c1',
                    type: 'material_requirement',
                    requirementIds: ['repair_r1'],
                  },
                ],
                removedRequirementIds: [],
              },
            },
          }) as never,
      );
    const audit = vi.spyOn(
      sourceCoverageProvider,
      'evaluateRequirementCoverageAudit',
    );
    vi.spyOn(sourceSmrt, 'getCollection').mockResolvedValue({ get } as never);
    vi.spyOn(
      sourceAiConfig,
      'resolveOpportunityIntelligenceExtractionAiProfileClient',
    ).mockResolvedValue({
      model: 'openai/gpt-6-luna',
      profile: 'opportunity-intelligence-extraction',
      timeout: 1000,
      aiClient: { chat, countTokens: vi.fn(async () => 2000) },
    } as never);
    vi.stubEnv('TYPESAFE_API_KEY', 'loopback-test-key');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT', '4');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT', '80000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS', '100000');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
      '37500',
    );
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '37500',
    );
    try {
      await expect(
        processOpportunityRequirementCoverageRepair(
          opportunity.id,
          prepared,
          options,
        ),
      ).rejects.toThrow('Principal revoked');
      expect(governance).toHaveBeenCalledTimes(1);
      expect(governance.mock.calls[0][0].identity).toMatchObject({
        feature: 'opportunity-source-requirement-repair',
        inputFingerprint: prepared.provenance.inputFingerprint,
      });
      expect(governance.mock.calls[0][0].maxOutputTokens).toBe(4096);
      expect(persist).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect(opportunity.preparedPostingJson).toBe(
        JSON.stringify({ existingDisplay: 'preserve' }),
      );
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
  it('plans a full-source repair without resetting the historical base reservation', async () => {
    const context = requirementCoverageContextForOpportunity({
      descriptionRaw:
        'About the team\nWe build financial software.\nRequirements\nCuriosity and willingness to evolve.',
      sourceContentFingerprint: 'captured-source',
      sourceContentVersion: 1,
    });
    const base = buildRequirementCoverageSource(context);
    base.dispositions = base.dispositions.map((row) =>
      base.clauses.find((clause) => clause.id === row.clauseId)?.kind === 'body'
        ? { ...row, type: 'source_context' }
        : row,
    );
    const target = base.clauses[3].id;
    const prepared = prepareRequirementCoverageRepair(
      context,
      base,
      'completed-base',
      {
        sourceFingerprint: context.sourceFingerprint,
        sourceVersion: context.sourceVersion,
        extractionFingerprint: context.extractionFingerprint,
        auditInputFingerprint: 'failed-literal-audit',
        requestId: 'actual-audit-request',
        probabilities: Object.fromEntries(
          base.clauses.map((row) => [row.id, 0.5]),
        ),
      },
      [target],
      { inputTokenCeiling: 6000, maxOutputTokens: 4096 },
    );
    const messages =
      buildOpportunityRequirementCoverageRepairMessages(prepared);
    const payload = JSON.parse(String(messages[1].content));
    expect(payload.source).toBe(context.sourceText);
    expect(payload.targets).toHaveLength(1);
    expect(payload.targets[0].text).toBe(base.clauses[3].text);
    expect(String(messages[0].content)).toContain(
      'Never repeat or rewrite paid rows',
    );
    const pricing = pricingForOpportunityIntelligenceModel('openai/gpt-6-luna');
    const options = {
      model: 'openai/gpt-6-luna',
      baseReservation: { calls: 0, reservedTokens: 0, spendMicros: 0 },
      auditPricing: pricing,
    };
    const plan = await preflightOpportunityRequirementCoverageRepair(
      prepared,
      options,
    );
    expect(plan.maxOutputTokens).toBe(4096);
    expect(plan.inputTokenCeiling).toBe(6000);
    expect(plan.preflight.calls).toBe(3);
    expect(plan.preflight.reservedTokens).toBe(
      2 * (6000 + 4096) + plan.auditReservation.reservedTokens,
    );
    expect(plan.admitted).toBe(true);
    const declined = await preflightOpportunityRequirementCoverageRepair(
      prepared,
      {
        ...options,
        limits: {
          calls: 4,
          inputTokens: plan.preflight.reservedTokens - 1,
          spendMicros: 100_000,
        },
      },
    );
    expect(declined.admitted).toBe(false);
  });
  it('requests only coverage while retaining full raw clauses and explicit validated heading aliases', () => {
    const opportunity = {
      descriptionRaw:
        'About the team\nHold a high bar for quality and security.\nSkills you bring\nFamiliarity with Kubernetes, Helm and Argo.',
      sourceContentFingerprint: 'public-source',
      sourceContentVersion: 1,
    };
    const coverage = buildRequirementCoverageSource(
      requirementCoverageContextForOpportunity(opportunity),
    );
    const messages = buildOpportunityLlmExtractionMessages(
      opportunity,
      coverage,
    );
    const user = String(messages[1].content);
    expect(user).toContain(
      'only these keys when the posting supports them: requirementCoverage.',
    );
    expect(String(messages[0].content)).toContain('ONLY requirementCoverage');
    expect(String(messages[0].content)).toContain(
      'Every referenced requirement ID must have a defined requirement row',
    );
    expect(String(messages[0].content)).toContain(
      'Familiarity with Kubernetes',
    );
    const payload = JSON.parse(
      user.slice(user.indexOf('provenance:\n') + 'provenance:\n'.length),
    );
    expect(
      payload.sourceClauses.map((row: { text: string }) => row.text),
    ).toEqual(coverage.clauses.map((row) => row.text));
    expect(payload.headingClauseIds).toEqual(['c0']);
    expect(payload.sourceClauses[2]).toMatchObject({
      id: 'c2',
      text: 'Skills you bring',
    });
    expect(String(messages[0].content)).toContain(
      'section_heading ONLY for supplied headingClauseIds',
    );
    const display = normalizeOpportunityLlmExtraction({
      requirementCoverage: { requirements: [], dispositions: [] },
    });
    expect(display).not.toHaveProperty('responsibilities');
    expect(display).not.toHaveProperty('qualifications');
    expect(display).not.toHaveProperty('descriptionSummary');
  });
  it('declines token and spend limits that fit counted input but cannot cover durable reservations', async () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_MAX_INPUT_TOKENS', '6000');
    try {
      const opportunity = {
        id: 'source-reservation-regression',
        title: 'Staff Platform Engineer',
        descriptionRaw:
          'About the team\nWork across platform and product.\nRequirements\nMust improve reliability using Kubernetes, Helm and Argo.',
        sourceContentFingerprint: 'current-source',
        sourceContentVersion: 1,
      };
      const prepared = prepareOpportunityPosting(opportunity);
      const pricing =
        pricingForOpportunityIntelligenceModel('openai/gpt-6-luna');
      const options = {
        model: 'openai/gpt-6-luna',
        counter: async () => 1,
        auditPricing: pricing,
      };
      const plan = await preflightOpportunityRequirementCoverageExtraction(
        opportunity,
        prepared,
        options,
      );
      expect(plan.admitted).toBe(true);
      expect(plan.chunks).toHaveLength(1);
      const chunk = plan.chunks[0];
      expect(chunk.inputTokenCount).toBeLessThan(chunk.inputTokenCeiling);
      expect(chunk.inputTokenCeiling).toBe(6000);
      expect(plan.preflight.reservedTokens).toBe(
        chunk.inputTokenCeiling +
          plan.maxOutputTokens +
          plan.auditReservation.reservedTokens,
      );
      for (const clause of plan.sourceCoverage.clauses)
        expect(plan.messages[0][1].content).toContain(
          JSON.stringify(clause.text),
        );
      const countedTokenBudget =
        chunk.inputTokenCount +
        plan.maxOutputTokens +
        plan.auditReservation.reservedTokens +
        1;
      const tokenLimited =
        await preflightOpportunityRequirementCoverageExtraction(
          opportunity,
          prepared,
          {
            ...options,
            limits: {
              calls: 4,
              inputTokens: countedTokenBudget,
              spendMicros: 100000,
            },
          },
        );
      expect(tokenLimited.sourceReady).toBe(true);
      expect(tokenLimited.preflight.fits).toBe(false);
      expect(tokenLimited.admitted).toBe(false);
      const countedSpend =
        reservedRequestSpendMicros({
          inputTokens: chunk.inputTokenCount,
          maxOutputTokens: plan.maxOutputTokens,
          pricing,
        }) +
        reservedRequestSpendMicros({
          inputTokens: plan.auditReservation.requestBytes,
          maxOutputTokens: plan.auditReservation.maxOutputTokens,
          pricing,
        });
      if (plan.reservedSpendMicros === null)
        throw new Error('Missing fixture pricing');
      expect(countedSpend).toBeLessThan(plan.reservedSpendMicros);
      const spendLimited =
        await preflightOpportunityRequirementCoverageExtraction(
          opportunity,
          prepared,
          {
            ...options,
            limits: {
              calls: 4,
              inputTokens: 80000,
              spendMicros: Math.floor(
                (countedSpend + plan.reservedSpendMicros) / 2,
              ),
            },
          },
        );
      expect(spendLimited.preflight.fits).toBe(true);
      expect(spendLimited.spendFits).toBe(false);
      expect(spendLimited.admitted).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html' },
    status: 200,
  });
}

describe('resolveOpportunityDetails', () => {
  it('loads the branded Dropbox posting from its primary Greenhouse board', async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      String(input).endsWith('/boards/dropbox')
        ? jsonResponse({ name: 'Dropbox' })
        : jsonResponse({
            id: 8036650,
            absolute_url:
              'https://jobs.dropbox.com/listing/8036650?gh_jid=8036650',
            title: 'Enterprise Context Architect',
            location: { name: 'Remote - Canada: Select locations' },
            content: '<p>Design enterprise context architecture.</p>',
          }),
    );
    const result = await resolveOpportunityDetails(
      { postingUrl: 'https://jobs.dropbox.com/listing/8036650?gh_jid=8036650' },
      fetchMock,
    );
    expect(result).toMatchObject({
      provider: 'greenhouse',
      status: 'resolved',
      companyName: 'Dropbox',
      locations: ['Remote - Canada: Select locations'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/dropbox/jobs/8036650?content=true',
    );
  });

  it('preserves explicit Vanta employer, all Canada eligibility locations, and structured annual pay', async () => {
    const result = await resolveOpportunityDetails(
      { postingUrl: vanta.sourceUrl },
      async () =>
        htmlResponse(
          `<script>window.__appData = ${JSON.stringify({ organization: vanta.organization, posting: vanta.posting })}</script><script type="application/ld+json">${JSON.stringify(vanta.jobPosting)}</script>`,
        ),
    );
    expect(result).toMatchObject({
      companyName: 'Vanta',
      companyWebsiteUrl: 'https://vanta.com',
      locations: ['Remote U.S.', 'Remote - Canada', 'Canada', 'USA'],
      salaryMin: 224000,
      salaryMax: 263000,
      currency: 'USD',
      provider: 'ashby',
      status: 'resolved',
    });
  });

  it('does not invent an employer from posting prose or a board slug', async () => {
    const result = await resolveOpportunityDetails(
      { postingUrl: 'https://jobs.ashbyhq.com/ambiguous/id' },
      async () =>
        htmlResponse(
          `<script>{"posting":{"id":"id","title":"Engineer","descriptionPlainText":"At Vanta, GitLab and Wealthsimple we work together.","locationName":"Remote","compensationTierSummary":"401(k) and 4 weeks vacation"}}</script>`,
        ),
    );
    expect(result).toMatchObject({
      companyName: '',
      locations: ['Remote'],
      salaryMin: null,
      salaryMax: null,
    });
  });
  it('normalizes supported LLM extraction fields into opportunity updates', () => {
    expect(
      normalizeOpportunityLlmExtraction({
        currency: 'CAD',
        domainTags: ['agentic AI', 'developer tools'],
        employmentType: 'full time',
        founderSignal: 'yes',
        hourlyMax: '',
        preferredSkills: ['SvelteKit', 'Postgres'],
        relocationSupported: false,
        salaryMin: '160000',
        seniority: 'staff-plus',
        unknownField: 'ignored',
        workMode: 'on-site',
      }),
    ).toEqual({
      currency: 'CAD',
      domainTags: 'agentic AI\ndeveloper tools',
      employmentType: 'full_time',
      founderSignal: true,
      preferredSkills: 'SvelteKit\nPostgres',
      relocationSupported: false,
      salaryMin: 160000,
      seniority: 'staff',
      workMode: 'onsite',
    });
  });

  it('omits unknown enum extraction values so provider facts are preserved', () => {
    expect(
      normalizeOpportunityLlmExtraction({
        employmentType: 'unknown',
        seniority: 'unknown',
        workMode: 'unknown',
      }),
    ).toEqual({});
  });

  it('extracts required and preferred skill listings from explicit sections', () => {
    expect(
      extractSkillListingsFromDescription(`
About the role
Build product systems.

Requirements
- TypeScript
- Node.js
- Production Svelte experience.

Nice to have
- LLM evaluation workflows
- Postgres

Benefits
- Health coverage
`),
    ).toEqual({
      preferredSkills: 'LLM evaluation workflows\nPostgres',
      requiredSkills: 'TypeScript\nNode.js\nProduction Svelte experience',
    });
  });

  it('resolves a Greenhouse board URL to the exact posting and full content', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url:
              'https://c3.ai/job-description/8365468002?gh_jid=8365468002',
            content:
              '&lt;p&gt;Build C3 AI platform services.&lt;/p&gt;&lt;p&gt;Requirements&lt;/p&gt;&lt;ul&gt;&lt;li&gt;TypeScript&lt;/li&gt;&lt;li&gt;Reliable backend systems&lt;/li&gt;&lt;/ul&gt;',
            first_published: '2026-05-01T12:00:00-04:00',
            id: 8365468002,
            location: { name: 'Redwood City, CA' },
            title: 'Senior Software Engineer, Platform - Data + AI (Back-End)',
          },
        ],
      }),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl: 'https://boards.greenhouse.io/embed/job_board?for=c3iot',
        title: 'Senior Software Engineer, Platform - Data + AI (Back-End)',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/c3iot/jobs?content=true',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://c3.ai/job-description/8365468002?gh_jid=8365468002',
      externalId: '8365468002',
      provider: 'greenhouse',
      status: 'resolved',
    });
    expect(result).toMatchObject({
      descriptionRaw: expect.stringContaining('Build C3 AI platform services.'),
      // Deterministic crawl parks requirement bullets in qualifications; the LLM
      // extract step refines them into atomic skills.
      qualifications: 'TypeScript\nReliable backend systems',
    });
  });

  it('resolves Greenhouse job-board posting URLs with path job ids', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        absolute_url:
          'https://job-boards.greenhouse.io/sourcegraph91/jobs/5996694004',
        content:
          '&lt;p&gt;Lead Sourcegraph code intelligence systems.&lt;/p&gt;',
        first_published: '2026-06-01T12:00:00-04:00',
        id: 5996694004,
        location: { name: 'Remote' },
        title: 'Engineering Manager - Code Plane [M3]',
      }),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://job-boards.greenhouse.io/sourcegraph91/jobs/5996694004',
        title:
          'Engineering Manager - Code Plane [M3] Remote Apply for position',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/sourcegraph91/jobs/5996694004?content=true',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://job-boards.greenhouse.io/sourcegraph91/jobs/5996694004',
      externalId: '5996694004',
      provider: 'greenhouse',
      status: 'resolved',
    });
  });

  it('resolves Fireblocks custom Greenhouse posting URLs by board token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url:
              'https://www.fireblocks.com/careers/position/4681572006?gh_jid=4681572006',
            content:
              '&lt;p&gt;Build yield systems for digital asset infrastructure.&lt;/p&gt;&lt;p&gt;Requirements&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Backend systems&lt;/li&gt;&lt;li&gt;Distributed services&lt;/li&gt;&lt;/ul&gt;',
            first_published: '2026-06-20T12:00:00-04:00',
            id: 4681572006,
            location: { name: 'New York, NY' },
            title: 'Senior Backend Engineer, Yield',
          },
        ],
      }),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://www.fireblocks.com/careers/position/4681572006?gh_jid=4681572006',
        title: 'Senior Backend Engineer, Yield',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/fireblocks/jobs?content=true',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://www.fireblocks.com/careers/position/4681572006?gh_jid=4681572006',
      externalId: '4681572006',
      provider: 'greenhouse',
      qualifications: 'Backend systems\nDistributed services',
      status: 'resolved',
    });
  });

  it('resolves Ripple custom Greenhouse posting URLs by board token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            absolute_url:
              'https://ripple.com/careers/all-jobs/job/8000106?gh_jid=8000106',
            content:
              '&lt;p&gt;Build crypto payment platform systems.&lt;/p&gt;&lt;p&gt;Requirements&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Distributed services&lt;/li&gt;&lt;/ul&gt;',
            first_published: '2026-06-20T12:00:00-04:00',
            id: 8000106,
            location: { name: 'Toronto, Canada' },
            title: 'Senior Platform Engineer',
          },
        ],
      }),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://ripple.com/careers/all-jobs/job/8000106?gh_jid=8000106',
        title: 'Senior Platform Engineer',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/ripple/jobs?content=true',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://ripple.com/careers/all-jobs/job/8000106?gh_jid=8000106',
      externalId: '8000106',
      provider: 'greenhouse',
      qualifications: 'Distributed services',
      status: 'resolved',
    });
  });

  it('resolves branded Greenhouse posting URLs from a16z portfolio results', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        absolute_url:
          'https://databricks.com/company/careers/open-positions/job?gh_jid=8568122002',
        content:
          '&lt;p&gt;Build lakehouse data platform systems.&lt;/p&gt;&lt;p&gt;Requirements&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Distributed systems&lt;/li&gt;&lt;/ul&gt;',
        first_published: '2026-06-20T12:00:00-04:00',
        id: 8568122002,
        location: { name: 'Remote' },
        title:
          'Sr. Specialist Solutions Architect - Data Engineering & Warehousing',
      }),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://databricks.com/company/careers/open-positions/job?gh_jid=8568122002',
        title:
          'Sr. Specialist Solutions Architect - Data Engineering & Warehousing',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/databricks/jobs/8568122002?content=true',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://databricks.com/company/careers/open-positions/job?gh_jid=8568122002',
      externalId: '8568122002',
      provider: 'greenhouse',
      qualifications: 'Distributed systems',
      status: 'resolved',
    });
  });

  it('marks a Greenhouse board URL stale when the title is no longer present', async () => {
    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://boards.greenhouse.io/embed/job_board?for=sentinellabs',
        title: 'Staff Agentic AI Engineer',
      },
      vi.fn(async () =>
        jsonResponse({
          jobs: [
            {
              absolute_url:
                'https://www.sentinelone.com/jobs/7722830003?gh_jid=7722830003',
              id: 7722830003,
              location: { name: 'Tel Aviv' },
              title: 'Staff AI Detection Engineer',
            },
          ],
        }),
      ),
    );

    expect(result).toMatchObject({
      candidates: [
        {
          title: 'Staff AI Detection Engineer',
          url: 'https://www.sentinelone.com/jobs/7722830003?gh_jid=7722830003',
        },
      ],
      provider: 'greenhouse',
      status: 'not_found',
    });
  });

  it('does not resolve a Greenhouse board URL without a saved opportunity title', async () => {
    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://boards.greenhouse.io/embed/job_board?for=sentinellabs',
        title: '',
      },
      vi.fn(async () =>
        jsonResponse({
          jobs: [
            {
              absolute_url:
                'https://www.sentinelone.com/jobs/7722830003?gh_jid=7722830003',
              id: 7722830003,
              location: { name: 'Tel Aviv' },
              title: '',
            },
          ],
        }),
      ),
    );

    expect(result).toMatchObject({
      candidates: [
        {
          title: '',
          url: 'https://www.sentinelone.com/jobs/7722830003?gh_jid=7722830003',
        },
      ],
      message:
        'A saved opportunity title is required to match Greenhouse board listings.',
      provider: 'greenhouse',
      status: 'unsupported',
    });
  });

  it('resolves an Ashby board URL to the canonical posting and full detail text', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://jobs.ashbyhq.com/redcan') {
        return htmlResponse(`
          <script>
          window.__DATA__ = {"jobPostings":[{"id":"479fd076-585f-4662-8a6e-ad8d2c2823a1","title":"Staff Software Engineer – Agentic AI Products","employmentType":"FullTime","locationName":"Waterloo","workplaceType":"Remote"}]},"routerPrefix":"/"};
          </script>
        `);
      }

      return htmlResponse(`
        <script>
          window.__DATA__ = {"posting":{"id":"479fd076-585f-4662-8a6e-ad8d2c2823a1","title":"Staff Software Engineer – Agentic AI Products","compensationTierSummary":"CAD $160k - $190k","employmentType":"FullTime","locationName":"Waterloo","publishedDate":"2026-04-15","workplaceType":"Remote","descriptionPlainText":"Build agentic AI products for enterprise software deployment.\\n\\nRequired skills\\n- TypeScript\\n- Node.js\\n\\nPreferred skills\\n- Product architecture\\n- Production systems"},"applicationFormDefinition":{}};
        </script>
      `);
    });

    const result = await resolveOpportunityDetails(
      {
        postingUrl: 'https://jobs.ashbyhq.com/redcan',
        title: 'Staff Software Engineer - Agentic AI Products',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith('https://jobs.ashbyhq.com/redcan');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://jobs.ashbyhq.com/redcan/479fd076-585f-4662-8a6e-ad8d2c2823a1',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://jobs.ashbyhq.com/redcan/479fd076-585f-4662-8a6e-ad8d2c2823a1',
      compNotes: 'CAD $160k - $190k',
      currency: 'CAD',
      descriptionRaw: expect.stringContaining('Build agentic AI products'),
      employmentType: 'full_time',
      provider: 'ashby',
      // Required then preferred requirement bullets are combined into
      // qualifications; the LLM extract step refines them into atomic skills.
      qualifications:
        'TypeScript\nNode.js\nProduct architecture\nProduction systems',
      salaryMax: 190000,
      salaryMin: 160000,
      status: 'resolved',
      workMode: 'remote',
    });
  });

  it('does not resolve an Ashby board URL without a saved opportunity title', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(`
        <script>
          window.__DATA__ = {"jobPostings":[{"id":"479fd076-585f-4662-8a6e-ad8d2c2823a1","title":"","locationName":"Waterloo","workplaceType":"Remote"}]},"routerPrefix":"/"};
        </script>
      `),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl: 'https://jobs.ashbyhq.com/redcan',
        title: '   ',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      candidates: [
        {
          title: '',
          url: 'https://jobs.ashbyhq.com/redcan/479fd076-585f-4662-8a6e-ad8d2c2823a1',
        },
      ],
      message:
        'A saved opportunity title is required to match Ashby board listings.',
      provider: 'ashby',
      status: 'unsupported',
    });
  });

  it('resolves a YC Work at a Startup job page from JSON-LD and embedded metadata', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(`
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "JobPosting",
                "title": "Founding Full-Stack Engineer - AI Agents for Pharma",
                "description": "<h3>About iollo</h3><p>Build autonomous scientific workflows.</p><h3>Requirements</h3><ul><li>TypeScript</li><li>Production infrastructure</li></ul>",
                "datePosted": "2026-05-26T18:42:23Z",
                "employmentType": "FULL_TIME",
                "hiringOrganization": { "@type": "Organization", "name": "Quinn" },
                "baseSalary": {
                  "@type": "MonetaryAmount",
                  "currency": "USD",
                  "value": {
                    "@type": "QuantitativeValue",
                    "unitText": "YEAR",
                    "minValue": 170000,
                    "maxValue": 270000
                  }
                },
                "jobLocation": [{
                  "@type": "Place",
                  "address": {
                    "@type": "PostalAddress",
                    "addressLocality": "San Francisco",
                    "addressRegion": "California",
                    "addressCountry": "US"
                  }
                }],
                "jobLocationType": "TELECOMMUTE",
                "applicantLocationRequirements": { "@type": "Country", "name": "US" }
              }
            </script>
          </head>
          <body>
            <div data-page="{&quot;currentJob&quot;:{&quot;salaryRange&quot;:&quot;$170K - $270K&quot;,&quot;equityRange&quot;:&quot;0.15% - 0.30%&quot;,&quot;minExperience&quot;:&quot;3+ years&quot;,&quot;visa&quot;:&quot;US citizen/visa only&quot;,&quot;location&quot;:&quot;San Francisco, CA, US / Remote (US)&quot;}}"></div>
          </body>
        </html>
      `),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://www.ycombinator.com/companies/quinn/jobs/Vi2myfm-founding-full-stack-engineer-ai-agents-for-pharma',
        title: 'Founding Full-Stack Engineer - AI Agents for Pharma',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.ycombinator.com/companies/quinn/jobs/Vi2myfm-founding-full-stack-engineer-ai-agents-for-pharma',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://www.ycombinator.com/companies/quinn/jobs/Vi2myfm-founding-full-stack-engineer-ai-agents-for-pharma',
      compNotes:
        'Salary: $170K - $270K\nEquity: 0.15% - 0.30%\nExperience: 3+ years\nVisa: US citizen/visa only',
      currency: 'USD',
      descriptionRaw: expect.stringContaining(
        'Build autonomous scientific workflows.',
      ),
      employmentType: 'full_time',
      equityMaxPercent: 0.3,
      equityMinPercent: 0.15,
      externalId: 'Vi2myfm-founding-full-stack-engineer-ai-agents-for-pharma',
      locationNotes: 'San Francisco, CA, US / Remote (US)',
      provider: 'ycombinator',
      qualifications: 'TypeScript\nProduction infrastructure',
      salaryMax: 270000,
      salaryMin: 170000,
      status: 'resolved',
      title: 'Founding Full-Stack Engineer - AI Agents for Pharma',
      workMode: 'remote',
    });
  });

  it('resolves a Lever posting through the public postings API', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        categories: {
          commitment: 'Full-time',
          location: 'United States / Remote',
        },
        createdAt: 1_766_722_400_000,
        descriptionPlain:
          'Build secure crypto infrastructure for institutions.',
        hostedUrl:
          'https://jobs.lever.co/anchorage/2a9e3da2-678e-4b33-b0e9-f6a7c69a9fbf',
        id: '2a9e3da2-678e-4b33-b0e9-f6a7c69a9fbf',
        lists: [
          {
            content:
              '<ul><li>Distributed systems</li><li>Platform security</li></ul>',
            text: 'Requirements',
          },
        ],
        text: 'Staff Software Engineer, Platform',
        workplaceType: 'remote',
      }),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://jobs.lever.co/anchorage/2a9e3da2-678e-4b33-b0e9-f6a7c69a9fbf',
        title: 'Staff Software Engineer, Platform',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.lever.co/v0/postings/anchorage/2a9e3da2-678e-4b33-b0e9-f6a7c69a9fbf',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://jobs.lever.co/anchorage/2a9e3da2-678e-4b33-b0e9-f6a7c69a9fbf',
      descriptionRaw: expect.stringContaining('Build secure crypto'),
      employmentType: 'full_time',
      externalId: '2a9e3da2-678e-4b33-b0e9-f6a7c69a9fbf',
      locationNotes: 'United States / Remote',
      provider: 'lever',
      qualifications: 'Distributed systems\nPlatform security',
      status: 'resolved',
      title: 'Staff Software Engineer, Platform',
      workMode: 'remote',
    });
  });

  it('resolves an Apple Careers posting from static hydration data', async () => {
    const hydration = JSON.stringify({
      loaderData: {
        jobDetails: {
          jobsData: {
            jobNumber: '200646237-3350',
            postingTitle: 'ML Engineer - Creator Studio',
            transformedPostingTitle: 'ml-engineer-creator-studio',
            jobSummary:
              'Build on-device ML and AI tools in the creative space.',
            description:
              'Define and implement key agentic AI features in Creator Studio applications.',
            minimumQualifications:
              '5+ years developing scalable code.\nExperience delivering Generative AI products.',
            preferredQualifications:
              'Experience with Core ML, Swift, and iOS/macOS machine learning development.',
            longPostingDate: '2026-02-10T18:57:15.270+00:00',
            locations: [
              {
                city: 'Vancouver',
                stateProvince: 'British Columbia',
                countryName: 'Canada',
              },
            ],
          },
        },
      },
    });
    const fetchMock = vi.fn(async () =>
      htmlResponse(
        `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(hydration)});</script>`,
      ),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://jobs.apple.com/en-us/details/200646237-3350/ml-engineer-creator-studio?team=SFTWR',
        title: 'ML Engineer - Creator Studio',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://jobs.apple.com/en-us/details/200646237-3350/ml-engineer-creator-studio?team=SFTWR',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://jobs.apple.com/en-us/details/200646237-3350/ml-engineer-creator-studio',
      descriptionRaw: expect.stringContaining('agentic AI features'),
      externalId: '200646237-3350',
      locationNotes: 'Vancouver, British Columbia, Canada',
      provider: 'apple-careers',
      qualifications: expect.stringContaining(
        '5+ years developing scalable code',
      ),
      status: 'resolved',
      title: 'ML Engineer - Creator Studio',
    });
  });

  it('resolves a Google Careers posting from static job page HTML', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(`
        <html>
          <head>
            <title>AI/ML Senior Software Engineer, Data Optimization and Platform — Google Careers</title>
            <link rel="canonical" href="https://www.google.com/about/careers/applications/jobs/results/82347231926985414-aiml-senior-software-engineer-data-optimization-and-platform" />
          </head>
          <body>
            <span class="r0wTof">London, UK</span>
            <div class="KwJkGe">
              <h3>Minimum qualifications:</h3>
              <ul><li>5 years of experience with Python.</li><li>3 years of experience with ML infrastructure.</li></ul>
              <h3>Preferred qualifications:</h3>
              <ul><li>Experience in Gen AI.</li></ul>
            </div>
            <div class="aG5W3"><h3>About the job</h3><p>Build data optimization and platform systems for Google Cloud.</p></div>
          </body>
        </html>
      `),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://www.google.com/about/careers/applications/jobs/results/82347231926985414-aiml-senior-software-engineer-data-optimization-and-platform?q=AI+Platform',
        title: 'AI/ML Senior Software Engineer, Data Optimization and Platform',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.google.com/about/careers/applications/jobs/results/82347231926985414-aiml-senior-software-engineer-data-optimization-and-platform?q=AI+Platform',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://www.google.com/about/careers/applications/jobs/results/82347231926985414-aiml-senior-software-engineer-data-optimization-and-platform',
      descriptionRaw: expect.stringContaining('Build data optimization'),
      externalId: '82347231926985414',
      locationNotes: 'London, UK',
      provider: 'google-careers',
      qualifications: expect.stringContaining('5 years of experience'),
      status: 'resolved',
      title: 'AI/ML Senior Software Engineer, Data Optimization and Platform',
    });
  });

  it('resolves a generic JSON-LD job posting page', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(`
        <html>
          <head>
            <link rel="canonical" href="https://www.guru.com/jobs/senior-ai-engineer-needed/2118920" />
            <script type="application/ld+json">
              {
                "@context": "https://schema.org/",
                "@type": "JobPosting",
                "title": "Senior AI Engineer Needed",
                "description": "Responsibilities: Design and implement AI-powered features. Required Skills: TypeScript, Vector Databases",
                "skills": "TypeScript, Vector Databases, RAG",
                "datePosted": "2026-06-20T00:00:00.0000000+00:00",
                "employmentType": "CONTRACTOR",
                "Identifier": {
                  "@type": "PropertyValue",
                  "Name": "Guru",
                  "Value": "2118920"
                },
                "baseSalary": {
                  "@type": "MonetaryAmount",
                  "currency": "USD",
                  "Value": {
                    "@type": "QuantitativeValue",
                    "minValue": "500",
                    "maxValue": "1000",
                    "unitText": "PROJECT"
                  }
                }
              }
            </script>
          </head>
          <body><h1>Senior AI Engineer Needed</h1></body>
        </html>
      `),
    );

    const result = await resolveOpportunityDetails(
      {
        postingUrl:
          'https://www.guru.com/jobs/senior-ai-engineer-needed/2118920&SearchUrl=search.aspx?',
        title: 'Senior AI Engineer Needed',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.guru.com/jobs/senior-ai-engineer-needed/2118920&SearchUrl=search.aspx?',
    );
    expect(result).toMatchObject({
      canonicalUrl:
        'https://www.guru.com/jobs/senior-ai-engineer-needed/2118920',
      currency: 'USD',
      descriptionRaw: expect.stringContaining('Design and implement'),
      employmentType: 'contract',
      externalId: '2118920',
      provider: 'generic',
      requiredSkills: 'TypeScript, Vector Databases, RAG',
      salaryMax: 1000,
      salaryMin: 500,
      status: 'resolved',
      title: 'Senior AI Engineer Needed',
    });
  });

  it('resolves a BambooHR posting from Open Graph metadata', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(`
        <html>
          <head>
            <meta property="og:url" content="https://kobalt.bamboohr.com/careers/79" />
            <meta property="og:title" content="Account Executive- EMEA" />
            <meta property="og:description" content="About Us: At Kobalt.io,
            our mission is to solve cybersecurity for SMBs at scale.
            Build and close customer opportunities with technical stakeholders." />
            <meta property="og:site_name" content="Kobalt Security Inc." />
          </head>
        </html>
      `),
    );

    await expect(
      resolveOpportunityDetails(
        {
          postingUrl: 'https://kobalt.bamboohr.com/careers/79',
          title: 'Apply',
        },
        fetchMock,
      ),
    ).resolves.toMatchObject({
      canonicalUrl: 'https://kobalt.bamboohr.com/careers/79',
      descriptionRaw: expect.stringContaining('solve cybersecurity'),
      externalId: '79',
      locationNotes: 'Kobalt Security Inc.',
      provider: 'bamboohr',
      status: 'resolved',
      title: 'Account Executive- EMEA',
    });
  });

  it('resolves a generic JSON-LD job posting from encoded script type and @graph', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(`
        <html>
          <head>
            <link rel="canonical" href="https://builtin.com/job/platform-engineer/9969533" />
            <script type="application/ld&#x2B;json">
              {
                "@context": "https://schema.org",
                "@graph": [
                  {
                    "@type": "Organization",
                    "name": "Built In"
                  },
                  {
                    "@type": "JobPosting",
                    "title": "Platform Engineer",
                    "description": "Build developer tooling and distributed systems.",
                    "datePosted": "2026-06-26T00:00:00.000Z",
                    "employmentType": "FULL_TIME",
                    "identifier": {
                      "@type": "PropertyValue",
                      "value": "9969533"
                    },
                    "jobLocationType": "TELECOMMUTE"
                  }
                ]
              }
            </script>
          </head>
        </html>
      `),
    );

    await expect(
      resolveOpportunityDetails(
        {
          postingUrl: 'https://builtin.com/job/platform-engineer/9969533',
          title: 'Platform Engineer',
        },
        fetchMock,
      ),
    ).resolves.toMatchObject({
      canonicalUrl: 'https://builtin.com/job/platform-engineer/9969533',
      descriptionRaw: expect.stringContaining('distributed systems'),
      employmentType: 'full_time',
      externalId: '9969533',
      provider: 'generic',
      status: 'resolved',
      title: 'Platform Engineer',
      workMode: 'remote',
    });
  });

  it('resolves a Freelancer project from embedded SEO state', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(`
        <html>
          <head><title>Native AI Customer Support App</title></head>
          <body>
            <script>
              window.__data = {
                "projectsSeo": {
                  "0": {
                    "documents": {
                      "machine-learning/native-customer-support-app": {
                        "rawDocument": {
                          "projectId": 40545720,
                          "title": "Native AI Customer Support App",
                          "description": "Build a native Android app with on-device AI, SQLite storage, OTP login, and bilingual voice support. Requirements: Kotlin, machine learning, telephony APIs.",
                          "budget": { "min": 1500, "max": 12500 },
                          "currencyDetails": { "code": "INR" },
                          "formattedBudget": "₹1500-12500 INR",
                          "skills": [
                            { "name": "Machine Learning (ML)" },
                            { "name": "Android" },
                            { "name": "SQLite" }
                          ],
                          "startTime": 1782658114,
                          "type": "fixed",
                          "seoUrl": "machine-learning/native-customer-support-app"
                        }
                      }
                    }
                  }
                }
              };
            </script>
          </body>
        </html>
      `),
    );

    await expect(
      resolveOpportunityDetails(
        {
          postingUrl:
            'https://www.freelancer.com/projects/machine-learning/native-customer-support-app',
          title: 'Native AI Customer Support App',
        },
        fetchMock,
      ),
    ).resolves.toMatchObject({
      canonicalUrl:
        'https://www.freelancer.com/projects/machine-learning/native-customer-support-app',
      compNotes: expect.stringContaining('₹1500-12500 INR'),
      currency: 'INR',
      descriptionRaw: expect.stringContaining('on-device AI'),
      employmentType: 'contract',
      externalId: '40545720',
      provider: 'freelancer',
      requiredSkills: 'Machine Learning (ML), Android, SQLite',
      salaryMax: 12500,
      salaryMin: 1500,
      status: 'resolved',
      title: 'Native AI Customer Support App',
      workMode: 'remote',
    });
  });

  it('resolves an AI Jobs.net posting from static HTML metadata', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(`
        <html>
          <head>
            <meta name="description" content="Adapt to new codebases. Requirements: TypeScript, distributed systems, production AI infrastructure." />
            <meta property="og:title" content="Software Engineer" />
            <link rel="canonical" href="https://aijobs.net/job/software-engineer-remote-189637/" />
          </head>
          <body>
            <main>
              <h1>Software Engineer</h1>
              <section>
                <h2>Requirements</h2>
                <ul><li>TypeScript</li><li>Distributed systems</li></ul>
              </section>
            </main>
          </body>
        </html>
      `),
    );

    await expect(
      resolveOpportunityDetails(
        {
          postingUrl: 'https://aijobs.net/job/software-engineer-remote-189637/',
          title: 'Software Engineer',
        },
        fetchMock,
      ),
    ).resolves.toMatchObject({
      canonicalUrl: 'https://aijobs.net/job/software-engineer-remote-189637/',
      descriptionRaw: expect.stringContaining('Adapt to new codebases'),
      externalId: '189637',
      provider: 'aijobs',
      status: 'resolved',
      title: 'Software Engineer',
    });
  });

  it('resolves Workable apply pages through their markdown posting endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(
        'https://apply.workable.com/tehora/jobs/view/275E30B2F8.md',
      );
      return new Response(
        `# Conseiller en gouvernance des ressources informationnelles (senior)

> TEHORA · Québec City, Canada (Remote) · Full-time · Posted 2026-06-28

**Workplace:** remote

## Description

Build reliable governance systems for information resources.

## Requirements

- Distributed systems
- Senior stakeholder communication
`,
        { headers: { 'content-type': 'text/markdown' }, status: 200 },
      );
    });

    await expect(
      resolveOpportunityDetails(
        {
          postingUrl: 'https://apply.workable.com/tehora/j/275E30B2F8',
          title: 'Apply',
        },
        fetchMock,
      ),
    ).resolves.toMatchObject({
      canonicalUrl: 'https://apply.workable.com/tehora/j/275E30B2F8',
      descriptionRaw: expect.stringContaining(
        'Build reliable governance systems',
      ),
      employmentType: 'full_time',
      externalId: '275E30B2F8',
      locationNotes: 'Québec City, Canada (Remote)',
      postedAt: new Date('2026-06-28'),
      provider: 'workable',
      qualifications: 'Distributed systems\nSenior stakeholder communication',
      status: 'resolved',
      title:
        'Conseiller en gouvernance des ressources informationnelles (senior)',
      workMode: 'remote',
    });
  });

  it('does not guess for unsupported sources', async () => {
    await expect(
      resolveOpportunityDetails({
        postingUrl: 'https://www.linkedin.com/jobs/view/4416339641/',
        title: 'Founding Engineer',
      }),
    ).resolves.toMatchObject({
      provider: 'unsupported',
      status: 'unsupported',
    });
  });

  it('resolves Arc.dev remote job details from Next.js page data', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(String.raw`
        <html>
          <head><title>Fhir R4 / Healthcare Interoperability Contractor - Arc</title></head>
          <body>
            <script id="__NEXT_DATA__" type="application/json">
              {
                "props": {
                  "pageProps": {
                    "job": {
                      "randomKey": "p0jjtydbgs",
                      "title": "Fhir R4 / Healthcare Interoperability Contractor",
                      "jobType": "contract",
                      "availableHoursPerWeek": 15,
                      "estimatedWeeks": 4,
                      "description": "**Role Overview**\n\nBuild a FHIR R4 clinical data pipeline.\n\n**Required Skills**\n\n- HL7/FHIR R4 standards\n- Healthcare APIs",
                      "requiredLocations": ["worldwide"],
                      "minHourlyRate": 80,
                      "maxHourlyRate": 120,
                      "createdAt": 1782657269,
                      "categories": [{ "name": "HL7" }, { "name": "FHIR" }]
                    }
                  }
                }
              }
            </script>
          </body>
        </html>
      `),
    );

    await expect(
      resolveOpportunityDetails(
        {
          postingUrl:
            'https://arc.dev/remote-jobs/details/fhir-r4-healthcare-interoperability-contractor-p0jjtydbgs',
          title: 'Fhir R4 / Healthcare Interoperability Contractor',
        },
        fetchMock,
      ),
    ).resolves.toMatchObject({
      canonicalUrl:
        'https://arc.dev/remote-jobs/details/fhir-r4-healthcare-interoperability-contractor-p0jjtydbgs',
      descriptionRaw: expect.stringContaining('FHIR R4 clinical data pipeline'),
      employmentType: 'contract',
      externalId: 'p0jjtydbgs',
      hourlyMax: 120,
      hourlyMin: 80,
      locationNotes: 'worldwide',
      provider: 'generic',
      requiredSkills: 'HL7, FHIR',
      status: 'resolved',
      title: 'Fhir R4 / Healthcare Interoperability Contractor',
      workMode: 'remote',
    });
  });
});
