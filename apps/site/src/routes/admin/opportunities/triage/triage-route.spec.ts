import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';

/**
 * The standalone triage route is retired: the deck is a modal over the
 * opportunity list. This route exists only so the old URL keeps working.
 */
async function redirectFor(url: string): Promise<{
  status: number;
  location: string;
}> {
  const { load } = await import('./+page.server');
  try {
    await (load as unknown as (input: { url: URL }) => unknown)({
      url: new URL(url),
    });
  } catch (cause) {
    if (isRedirect(cause)) {
      return { location: cause.location, status: cause.status };
    }
    throw cause;
  }
  throw new Error('Expected the triage route to redirect');
}

describe('retired triage route', () => {
  it('redirects to the list with the deck open', async () => {
    const { location, status } = await redirectFor(
      'http://localhost/admin/opportunities/triage',
    );

    expect(status).toBe(302);
    expect(location).toBe('/admin/opportunities?triage=1');
  });

  it('carries the operator filters across to the list', async () => {
    const { location } = await redirectFor(
      'http://localhost/admin/opportunities/triage?skill=Rust&workMode=remote&q=platform',
    );

    const params = new URL(location, 'http://localhost').searchParams;
    expect(params.get('triage')).toBe('1');
    expect(params.getAll('skill')).toEqual(['Rust']);
    expect(params.getAll('workMode')).toEqual(['remote']);
    expect(params.get('q')).toBe('platform');
  });

  it('drops the standalone view own skip cursor', async () => {
    // `offset` was that view's client-side skip state, not a filter. A modal
    // session starts fresh, so carrying it would silently hide cards.
    const { location } = await redirectFor(
      'http://localhost/admin/opportunities/triage?offset=12&skill=Rust',
    );

    const params = new URL(location, 'http://localhost').searchParams;
    expect(params.get('offset')).toBeNull();
    expect(params.getAll('skill')).toEqual(['Rust']);
  });
});
