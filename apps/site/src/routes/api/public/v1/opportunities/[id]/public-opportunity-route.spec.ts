import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicOpportunityInputSchema } from '$lib/public-opportunity-contract.js';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  budget: vi.fn(async () => 599),
}));
vi.mock('$lib/server/app-config.js', () => ({ isSharedHosted: () => true }));
vi.mock('$lib/server/public-search/index.js', () => ({
  getPublicOpportunity: mocks.get,
  consumePublicSearchBudget: mocks.budget,
  PublicSearchError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { GET } from './+server';

function event(id: string) {
  return {
    params: { id },
    request: new Request(
      `https://jobs.test/api/public/v1/opportunities/${encodeURIComponent(id)}`,
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IOLAUS_PUBLIC_SEARCH_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());
describe('shared REST/MCP opportunity ID contract', () => {
  it('passes the shared parsed ID to the public reader', async () => {
    const id = 'opportunity-1';
    mocks.get.mockResolvedValue({ id });
    const response = await GET(event(id) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id });
    expect(mocks.get).toHaveBeenCalledWith(
      publicOpportunityInputSchema.parse({ id }).id,
    );
  });
  it.each([
    '',
    'x'.repeat(129),
  ])('rejects an invalid ID before querying the reader', async (id) => {
    const response = await GET(event(id) as never);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
