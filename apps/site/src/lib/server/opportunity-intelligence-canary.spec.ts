import { describe, expect, it } from 'vitest';
import {
  opportunityIntelligenceCanaryCategories,
  opportunityIntelligenceCanaryFixtures,
} from './fixtures/opportunity-intelligence-canary.js';
import {
  classifyOpportunityIntelligenceCanaryFailure,
  evaluateOpportunityIntelligenceCanary,
  type OpportunityIntelligenceCanaryCaseResult,
} from './opportunity-intelligence-canary.js';

function passingCase(index: number): OpportunityIntelligenceCanaryCaseResult {
  const fixture = opportunityIntelligenceCanaryFixtures[index];
  return {
    categories: fixture.categories,
    context: [
      {
        ceilingTokens: 6_000,
        headroomRatio: 0.25,
        headroomTokens: 1_500,
        inputTokens: 4_500,
        invoked: true,
        phase: 'extraction',
      },
    ],
    extraction: {
      checks: [{ field: `field-${index}`, passed: true }],
      failedFields: [],
      requestCount: 1,
    },
    id: fixture.id,
    latencyMs: {
      case: 1_500,
      extraction: 1_000,
      requests: [1_000],
      scoring: 500,
    },
    scoring: {
      actualDecision: 'clear_accept',
      actualRecommendation: 'recommend',
      agreed: true,
      expectedDecision: 'clear_accept',
      expectedRecommendation: 'recommend',
      modelInvoked: index < 2,
    },
    status: 'succeeded',
  };
}

describe('opportunity intelligence canary', () => {
  it('classifies content-free gateway rate-limit failures', () => {
    expect(
      classifyOpportunityIntelligenceCanaryFailure(
        new Error(
          'Rate limit check failed: request limit exceeded (20/20, resets every 1d)',
        ),
      ),
    ).toBe('rate_limit');
    expect(
      classifyOpportunityIntelligenceCanaryFailure(
        new Error('OpenAI HTTP 429 insufficient_quota'),
      ),
    ).toBe('provider_quota');
  });

  it('ships a deterministic sanitized corpus covering every declared category', () => {
    const categories = new Set(
      opportunityIntelligenceCanaryFixtures.flatMap(
        (fixture) => fixture.categories,
      ),
    );
    expect([...categories].sort()).toEqual(
      [...opportunityIntelligenceCanaryCategories].sort(),
    );
    expect(opportunityIntelligenceCanaryFixtures).toHaveLength(7);

    for (const fixture of opportunityIntelligenceCanaryFixtures) {
      expect(fixture.opportunity.postingUrl).toMatch(
        /^https:\/\/jobs\.example\.invalid\//,
      );
      expect(fixture.opportunity.sourceContentFingerprint).toBe(
        `sanitized-canary-${fixture.id}-v1`,
      );
      expect(JSON.stringify(fixture)).not.toMatch(
        /(?:@gmail\.com|@hotmail\.com|linkedin\.com\/in\/)/i,
      );
    }
  });

  it('accepts only a complete measurement set that clears every predeclared gate', () => {
    const report = evaluateOpportunityIntelligenceCanary({
      cases: Array.from({ length: 7 }, (_, index) => passingCase(index)),
      generatedAt: '2026-07-14T00:00:00.000Z',
      profile: {
        model: 'openai/gpt-5.6-luna',
        name: 'opportunity-intelligence-fallback',
        provider: 'bifrost',
      },
    });

    expect(report.accepted).toBe(true);
    expect(report.gates).toEqual(
      expect.objectContaining({
        caseCount: true,
        corpusCoverage: true,
        contextHeadroom: true,
        failureRate: true,
        fieldQuality: true,
        canaryProfile: true,
        modelScoringCoverage: true,
        requestLatency: true,
        scoringAgreement: true,
      }),
    );
    expect(report.summary).toMatchObject({
      caseCount: 7,
      failureRate: 0,
      modelScoringCases: 2,
      scoringAgreement: { rate: 1 },
    });
  });

  it('records content-free failure modes and rejects regressions', () => {
    const cases = Array.from({ length: 7 }, (_, index) => passingCase(index));
    cases[0] = {
      ...cases[0],
      context: [
        {
          ceilingTokens: 6_000,
          headroomRatio: -0.01,
          headroomTokens: -60,
          inputTokens: 6_060,
          invoked: true,
          phase: 'extraction',
        },
      ],
      extraction: {
        checks: [{ field: 'title', passed: false }],
        failedFields: ['title'],
        requestCount: 1,
      },
      failureMode: 'context_limit',
      latencyMs: { ...cases[0].latencyMs, requests: [91_000] },
      scoring: { ...cases[0].scoring, agreed: false },
      status: 'failed',
    };
    cases[1] = {
      ...cases[1],
      scoring: { ...cases[1].scoring, agreed: false },
    };

    const report = evaluateOpportunityIntelligenceCanary({
      cases,
      profile: {
        model: 'openai/gpt-5.6-luna',
        name: 'opportunity-intelligence-fallback',
        provider: 'bifrost',
      },
    });

    expect(report.accepted).toBe(false);
    expect(report.summary.failureModes).toEqual({ context_limit: 1 });
    expect(report.gates).toMatchObject({
      contextHeadroom: false,
      failureRate: false,
      fieldQuality: false,
      requestLatency: false,
      scoringAgreement: false,
    });
    expect(JSON.stringify(report)).not.toContain('prompt');
  });

  it('rejects substitute corpora and non-canary profiles', () => {
    const cases = Array.from({ length: 7 }, (_, index) => passingCase(index));
    cases[0] = { ...cases[0], id: 'substitute-case' };

    const report = evaluateOpportunityIntelligenceCanary({
      cases,
      profile: {
        model: 'zai/glm-4.7-flashx',
        name: 'opportunity-intelligence-zai',
        provider: 'bifrost',
      },
    });

    expect(report.accepted).toBe(false);
    expect(report.gates).toMatchObject({
      corpusCoverage: false,
      canaryProfile: false,
    });
  });
});
