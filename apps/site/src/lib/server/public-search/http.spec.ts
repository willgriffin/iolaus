import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shared: true,
  budget: vi.fn(async () => 599),
}));
vi.mock('../app-config.js', () => ({ isSharedHosted: () => mocks.shared }));
vi.mock('./index.js', () => ({
  consumePublicSearchBudget: mocks.budget,
  PublicSearchError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { publicResponse, publicSearchParameters } from './http.js';
import { preparePublicPage } from './page.js';

beforeEach(() => {
  mocks.shared = true;
  process.env.IOLAUS_PUBLIC_SEARCH_ENABLED = 'true';
  mocks.budget.mockClear();
});
it('revalidates current visibility before 304 and never shared-caches match', async () => {
  const req = new Request('https://example.test/api/public/v1/opportunities');
  const a = await publicResponse(req, 3, () => ({ items: ['visible'] }));
  const etag = a.headers.get('etag')!;
  const cached = new Request(req, { headers: { 'if-none-match': etag } });
  expect(
    (await publicResponse(cached, 3, () => ({ items: ['visible'] }))).status,
  ).toBe(304);
  const removed = await publicResponse(cached, 3, () => ({ items: [] }));
  expect(removed.status).toBe(200);
  expect(removed.headers.get('cache-control')).toBe(
    'public, max-age=0, must-revalidate',
  );
  const match = await publicResponse(req, 10, () => ({ items: [] }), false);
  expect(match.headers.get('cache-control')).toBe('no-store');
  expect(match.headers.has('etag')).toBe(false);
});
it('fails closed in private mode and returns problem errors without internal details', async () => {
  mocks.shared = false;
  const r = await publicResponse(
    new Request('https://example.test'),
    1,
    () => ({ private: 'never' }),
  );
  expect(r.status).toBe(404);
  expect(mocks.budget).not.toHaveBeenCalled();
  mocks.shared = true;
  const failed = await publicResponse(
    new Request('https://example.test'),
    1,
    () => {
      throw new Error('PRIVATE_DATABASE_SECRET');
    },
  );
  expect(failed.status).toBe(503);
  expect(failed.headers.get('content-type')).toBe('application/problem+json');
  expect(await failed.text()).not.toContain('SECRET');
});
it('rejects duplicate scalars and parses bounded public filters without trusting identity headers', () => {
  expect(
    publicSearchParameters(
      new URL(
        'https://example.test?skills=rust,postgres&skills=typescript&remote_ok=true',
      ),
    ),
  ).toEqual({ skills: ['rust', 'postgres', 'typescript'], remote_ok: true });
  expect(() =>
    publicSearchParameters(new URL('https://example.test?q=a&q=b')),
  ).toThrow();
  expect(() =>
    publicSearchParameters(new URL('https://example.test?remote_ok=1')),
  ).toThrow();
});

it('never shares public HTML containing session-dependent layout data', async () => {
  const setHeaders = vi.fn();
  await preparePublicPage(setHeaders);
  expect(setHeaders).toHaveBeenCalledWith({
    'cache-control': 'private, no-store',
  });
  expect(mocks.budget).toHaveBeenCalledWith(3);
});
