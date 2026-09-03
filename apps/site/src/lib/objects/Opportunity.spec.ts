import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../server/smrt';
import {
  OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
  OPPORTUNITY_INTELLIGENCE_METHOD,
} from '../server/opportunity-intelligence-job-schema';
import { Opportunity } from './Opportunity';

const { runOpportunityIntelligenceJob } = vi.hoisted(() => ({
  runOpportunityIntelligenceJob: vi.fn(async () => ({
    message: 'Processed opportunity intelligence.',
    status: 'processed',
  })),
}));

vi.mock('../server/opportunity-intelligence-job.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../server/opportunity-intelligence-job')
    >();
  return {
    ...actual,
    runOpportunityIntelligenceJob,
  };
});

describe('Opportunity TaskRunner loading', () => {
  beforeEach(() => {
    runOpportunityIntelligenceJob.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts the runner object id argument before delegating to base loadFromId', async () => {
    const baseLoad = vi
      .spyOn(SmrtObject.prototype, 'loadFromId')
      .mockResolvedValue(undefined);
    const opportunity = new Opportunity();

    await opportunity.loadFromId('opp-1');

    expect(opportunity.id).toBe('opp-1');
    expect(baseLoad).toHaveBeenCalledOnce();
  });

  it('registers the queued object type and exposes the processIntelligence method', async () => {
    const registeredClass = ObjectRegistry.getClass(
      OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
    );
    expect(registeredClass?.constructor).toBe(Opportunity);

    const opportunity = new Opportunity();
    opportunity.id = 'opp-1';
    const args = { modes: 'all', userId: 'user-1' } as const;
    const context = { logger: { error: vi.fn(), info: vi.fn() } } as never;
    expect(typeof opportunity[OPPORTUNITY_INTELLIGENCE_METHOD]).toBe(
      'function',
    );

    const result = await opportunity.processIntelligence(args, context);

    expect(result).toEqual({
      message: 'Processed opportunity intelligence.',
      status: 'processed',
    });
    expect(runOpportunityIntelligenceJob).toHaveBeenCalledWith(
      opportunity,
      args,
      context,
    );
  });
});
