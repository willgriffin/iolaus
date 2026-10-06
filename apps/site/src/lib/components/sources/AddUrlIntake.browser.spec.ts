// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

// This form emits the established refresh event; native hydration is exercised separately.
vi.mock('../admin/admin-resource-hydration', () => ({
  ADMIN_RESOURCE_REFRESH_EVENT: 'iolaus:admin-resource-refresh',
}));

import AddUrlIntake from '../admin/AddUrlIntake.svelte';
import { ADMIN_RESOURCE_REFRESH_EVENT } from '../admin/admin-resource-hydration';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function form() {
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(AddUrlIntake, { target });
  cleanup = () => unmount(component);
  flushSync();
  target.querySelector<HTMLButtonElement>('button')?.click();
  flushSync();
  const input = target.querySelector<HTMLInputElement>('input[type=url]');
  if (!input) throw new Error('The public URL input did not render.');
  return {
    target,
    input,
    setUrl(value: string) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
    },
    submit() {
      target
        .querySelector('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      flushSync();
    },
  };
}
function response(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response;
}

describe('shared Add URL form', () => {
  it.each([
    [
      'https://jobs.ashbyhq.com/acme/d78184cd-027f-4932-8613-bf8c94d536ae',
      'opportunity',
      '/admin/opportunities/opp-1',
    ],
    ['https://jobs.ashbyhq.com/acme', 'source', '/admin/sources/source-1'],
  ])('detects %s and displays the truthful queued result', async (url, kind, href) => {
    const refresh = vi.fn();
    window.addEventListener(ADMIN_RESOURCE_REFRESH_EVENT, refresh, {
      once: true,
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({
          status: 'queued',
          kind,
          message: 'Initial work queued',
          href,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = form();
    view.setUrl(url);
    expect(view.target.textContent).toContain(
      kind === 'source' ? 'Job board detected' : 'Job posting detected',
    );
    view.submit();
    await vi.waitFor(() =>
      expect(view.target.textContent).toContain('Initial work queued'),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/url-intake',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url, kind: 'auto' }),
      }),
    );
    expect(view.target.querySelector('a')?.getAttribute('href')).toBe(href);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('requires a clear explicit choice for unknown pages and sends that choice', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({
          status: 'saved',
          message: 'Source saved; its initial pull was not queued.',
          href: '/admin/sources/source-1',
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = form();
    view.setUrl('https://careers.example.com/openings');
    expect(
      view.target.querySelector<HTMLButtonElement>('button[type=submit]')
        ?.disabled,
    ).toBe(true);
    view.target.querySelector<HTMLInputElement>('input[value=source]')?.click();
    flushSync();
    view.submit();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      url: 'https://careers.example.com/openings',
      kind: 'source',
    });
    await vi.waitFor(() =>
      expect(view.target.textContent).toContain('not queued'),
    );
  });

  it('preserves input after an upstream failure and retries without duplicate concurrent submits', async () => {
    let finish: (value: Response) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(
        response({
          status: 'saved',
          message: 'Opportunity saved. Static details unavailable.',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const view = form();
    view.setUrl('https://jobs.ashbyhq.com/acme');
    view.submit();
    view.submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    finish(response({ error: 'Provider unavailable' }, false));
    await vi.waitFor(() =>
      expect(view.target.textContent).toContain('Provider unavailable'),
    );
    expect(view.input.value).toBe('https://jobs.ashbyhq.com/acme');
    view.submit();
    await vi.waitFor(() =>
      expect(view.target.textContent).toContain('Static details unavailable'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe URLs locally and ignores external response links', async () => {
    const fetchMock = vi.fn(async () =>
      response({
        status: 'saved',
        message: 'Saved',
        href: 'https://evil.example.com',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = form();
    view.setUrl('https://name:secret@jobs.example.com/role');
    view.submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.target.querySelector('[role=alert]')).not.toBeNull();
    view.setUrl('https://jobs.ashbyhq.com/acme');
    view.submit();
    await vi.waitFor(() => expect(view.target.textContent).toContain('Saved'));
    expect(view.target.querySelector('a')).toBeNull();
    [...view.target.querySelectorAll('button')]
      .find((button) => button.textContent === 'Add another URL')
      ?.click();
    flushSync();
    expect(view.target.querySelector<HTMLDialogElement>('dialog')?.open).toBe(
      true,
    );
    expect(
      view.target.querySelector<HTMLInputElement>('input[type=url]')?.value,
    ).toBe('');
  });
});
