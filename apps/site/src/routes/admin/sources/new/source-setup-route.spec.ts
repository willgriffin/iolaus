import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertOperation: vi.fn(async () => undefined),
  createRootSource: vi.fn(async () => ({ id: 'source-1' })),
  parseRootSourceSetup: vi.fn(() => ({ name: 'OpenAI Careers' })),
  runAsOwner: vi.fn(),
}));

vi.mock('$lib/server/source-root-setup.js', () => ({
  createRootSource: mocks.createRootSource,
  parseRootSourceSetup: mocks.parseRootSourceSetup,
  rootSourceTypeOptions: [],
}));

vi.mock('$lib/server/owner-principal.js', () => ({
  isOwnerAuthorityDenial: vi.fn(() => false),
  OwnerPrincipalError: class OwnerPrincipalError extends Error {},
  runAsOwner: mocks.runAsOwner,
}));

function event(user: { id: string } | null = { id: 'owner-1' }) {
  return {
    locals: { permissions: ['sources.create'], user },
    request: new Request('https://iolaus.localhost/admin/sources/new', {
      body: new URLSearchParams({
        name: 'OpenAI Careers',
        provider: 'ashby',
        type: 'company_careers',
        url: 'https://jobs.ashbyhq.com/openai',
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    }),
  };
}

describe('source setup route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires the owner principal and asserts source creation before saving', async () => {
    mocks.runAsOwner.mockImplementationOnce(async (_locals, work) =>
      work({ assertOperation: mocks.assertOperation }),
    );
    const { actions } = await import('./+page.server');

    await expect(actions.create(event() as never)).rejects.toMatchObject({
      status: 303,
    });

    expect(mocks.assertOperation).toHaveBeenCalledWith('sources', 'create');
    expect(mocks.parseRootSourceSetup).toHaveBeenCalledOnce();
    expect(mocks.createRootSource).toHaveBeenCalledWith({
      name: 'OpenAI Careers',
    });
  });

  it('does not save when the authenticated owner gate rejects the request', async () => {
    mocks.runAsOwner.mockRejectedValueOnce(new Error('Not authenticated'));
    const { actions } = await import('./+page.server');

    await expect(actions.create(event(null) as never)).resolves.toMatchObject({
      status: 400,
    });
    expect(mocks.createRootSource).not.toHaveBeenCalled();
  });
});
