import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ replaceState: vi.fn() }));
vi.mock('$app/navigation', () => navigation);

import type { ResumeImportView } from '$lib/resume-import';
import ResumeImport from './ResumeImport.svelte';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  navigation.replaceState.mockReset();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const review = (revision = 'r1', warnings: string[] = []) => ({
  id: 'import-1',
  status: 'review' as const,
  revision,
  filename: 'resume.pdf',
  warnings,
  entries: [
    {
      id: 'experience-1',
      kind: 'experience' as const,
      fields: { company: 'Acme', title: 'Engineer' },
    },
  ],
});
const response = (payload: unknown, ok = true) =>
  ({ ok, json: async () => payload }) as Response;

function mountImport(initialImport?: ResumeImportView) {
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(ResumeImport, {
    target,
    props: initialImport ? { initialImport } : {},
  });
  cleanup = () => unmount(component);
  flushSync();
  return target;
}

function choosePdf(target: HTMLElement) {
  const input = target.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' })],
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  target.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
  flushSync();
}

describe('ResumeImport browser behavior', () => {
  it('acknowledges upload, shows real stages and automatically opens review', async () => {
    let stage = 'reading_pdf';
    const processing = () => ({
      ...review(),
      status: 'processing',
      progress: stage,
      entries: [],
    });
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) =>
      response(
        options?.method === 'POST'
          ? processing()
          : stage === 'done'
            ? review()
            : processing(),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport();
    choosePdf(target);
    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Upload and review'))!
      .click();
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Reading your PDF'),
    );
    expect(target.textContent).not.toContain('Uploading PDF…');
    stage = 'reading_scan';
    await vi.waitFor(
      () => expect(target.textContent).toContain('Reading page layout'),
      { timeout: 4000 },
    );
    stage = 'done';
    await vi.waitFor(
      () => expect(target.textContent).toContain('Review proposed changes'),
      { timeout: 4000 },
    );
    const completedCalls = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(fetchMock).toHaveBeenCalledTimes(completedCalls);
    expect(navigation.replaceState).toHaveBeenCalled();
  });

  it('shows interrupted status checks and recovers without uploading again', async () => {
    let disconnected = true;
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => {
      if (disconnected) throw new TypeError('Network disconnected');
      return response(review());
    });
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport({
      ...review(),
      status: 'processing',
      progress: 'extracting_details',
      entries: [],
    });
    expect(target.textContent).toContain('Extracting experience');
    await vi.waitFor(
      () => expect(target.textContent).toContain('Reconnecting'),
      { timeout: 3000 },
    );
    disconnected = false;
    await vi.waitFor(
      () => expect(target.textContent).toContain('Review proposed changes'),
      { timeout: 4000 },
    );
    expect(
      fetchMock.mock.calls.every(
        (call) =>
          call.length < 2 || (call[1] as RequestInit)?.method !== 'POST',
      ),
    ).toBe(true);
  });

  it.each([
    401, 403, 404, 410,
  ])('stops polling on permanent HTTP %i errors and offers expired recovery', async (status) => {
    const expired = status === 410;
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({
        error: expired ? 'This import expired.' : 'This import is unavailable.',
        ...(expired ? { code: 'expired_import' } : {}),
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport({
      ...review(),
      status: 'processing',
      entries: [],
    });
    await vi.waitFor(() =>
      expect(target.querySelector('[role=alert]')?.textContent).toContain(
        expired ? 'This import expired.' : 'This import is unavailable.',
      ),
    );
    expect(target.textContent).not.toContain('Reconnecting');
    expect(target.textContent?.includes('Start a new import')).toBe(expired);
    const count = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it('retries a transient HTTP failure and reaches review', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Temporarily unavailable.' }),
      })
      .mockResolvedValue(response(review()));
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport({
      ...review(),
      status: 'processing',
      entries: [],
    });
    await vi.waitFor(
      () => expect(target.textContent).toContain('Reconnecting'),
      { timeout: 3000 },
    );
    await vi.waitFor(
      () => expect(target.textContent).toContain('Review proposed changes'),
      { timeout: 4000 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('edits, adds and removes individual bullets without changing the summary', async () => {
    const initial = review();
    initial.entries[0].fields = {
      company: 'Acme',
      title: 'Engineer',
      summary: 'Role overview.',
      bullets: 'Built a service.\nMentored engineers.',
    } as (typeof initial.entries)[0]['fields'];
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) =>
      response({ ...initial, status: 'applied' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport(initial);
    const bullet = () =>
      Array.from(target.querySelectorAll('label'))
        .filter((label) => /^Bullet \d+/.test(label.textContent ?? ''))
        .map((label) => label.querySelector('textarea')!);
    expect(bullet()).toHaveLength(2);
    bullet()[0].value = '';
    bullet()[0].dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(bullet()).toHaveLength(2);
    bullet()[0].value = 'Improved reliability.';
    bullet()[0].dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    target
      .querySelector<HTMLButtonElement>('[aria-label="Remove bullet 2"]')!
      .click();
    flushSync();
    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent === 'Add bullet')!
      .click();
    flushSync();
    bullet()[1].value = 'Coached teammates.';
    bullet()[1].dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent === 'Apply selected changes')!
      .click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.entries[0].fields).toMatchObject({
      summary: 'Role overview.',
      bullets: 'Improved reliability.\nCoached teammates.',
    });
  });

  it('edits labeled bullet sections and shows role-backed skill evidence without submitting its JSON', async () => {
    const initial: ResumeImportView = {
      ...review(),
      entries: [
        {
          id: 'experience-1',
          kind: 'experience',
          fields: {
            company: 'Acme',
            title: 'Engineer',
            bulletSections: JSON.stringify([
              {
                title: 'Platform delivery',
                bullets: ['Built a service.'],
              },
            ]),
          },
        },
        {
          id: 'skill-1',
          kind: 'skill',
          fields: {
            name: 'TypeScript',
            skillEvidence: JSON.stringify([
              {
                proposalExperienceId: 'experience-1',
                usage: 'Built the service.',
                depth: 'hands_on',
                quote: 'Built a TypeScript service.',
                page: 2,
              },
            ]),
          },
        },
      ],
    };
    const fetchMock = vi.fn(async () =>
      response({ ...initial, status: 'applied' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport(initial);
    expect(target.textContent).toContain('Evidence from roles');
    expect(target.textContent).toContain('Engineer — Acme');
    expect(target.textContent).toContain('Page 2');
    const title = Array.from(
      target.querySelectorAll<HTMLInputElement>('input'),
    ).find((input) => input.value === 'Platform delivery');
    expect(title).toBeDefined();
    title!.value = '';
    title!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(title!.value).toBe('');
    title!.value = 'Platform architecture';
    title!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Apply selected changes')
      ?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    const payload = JSON.parse(String(calls[0]?.[1].body));
    const experience = payload.entries.find(
      (entry: { id: string }) => entry.id === 'experience-1',
    );
    const skill = payload.entries.find(
      (entry: { id: string }) => entry.id === 'skill-1',
    );
    expect(JSON.parse(experience.fields.bulletSections)).toEqual([
      { title: 'Platform architecture', bullets: ['Built a service.'] },
    ]);
    expect(skill.fields).not.toHaveProperty('skillEvidence');
  });

  it('keeps an empty section editable but blocks apply until it has a title and bullet', async () => {
    const initial: ResumeImportView = {
      ...review(),
      entries: [
        {
          id: 'experience-1',
          kind: 'experience',
          fields: { company: 'Acme', title: 'Engineer' },
        },
      ],
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport(initial);
    [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Add section')
      ?.click();
    flushSync();
    const sectionTitle = Array.from(target.querySelectorAll('label'))
      .find((label) => label.textContent?.startsWith('Section title'))
      ?.querySelector<HTMLInputElement>('input');
    expect(sectionTitle).toBeDefined();
    sectionTitle!.value = 'Architecture';
    sectionTitle!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    const sectionBullet = Array.from(target.querySelectorAll('label'))
      .find((label) => label.textContent?.startsWith('Bullet 1'))
      ?.querySelector<HTMLTextAreaElement>('textarea');
    expect(sectionBullet).toBeDefined();
    [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Apply selected changes')
      ?.click();
    flushSync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.querySelector('[role=alert]')?.textContent).toContain(
      'Review bullet sections before applying',
    );
    sectionBullet!.value = 'Built a service.';
    sectionBullet!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(sectionBullet!.value).toBe('Built a service.');
  });

  it('reviews projects separately without exposing an editable parent identifier', () => {
    const initial: ResumeImportView = review();
    initial.entries.push({
      id: 'project-1',
      kind: 'project',
      fields: {
        name: 'Example Portal',
        summary: 'Built a portal.',
        bullets: 'Improved checkout.\nReduced latency.',
        proposalExperienceId: 'experience-1',
      },
    });
    const target = mountImport(initial);
    expect(target.textContent).toContain(
      'These bullets appear once in a project section',
    );
    expect(target.textContent).not.toContain('proposalExperienceId');
    const project = target.querySelectorAll('article')[1];
    expect(project.querySelector('input')?.value).toBe('Example Portal');
    expect(target.querySelectorAll('article')[0].contains(project)).toBe(true);
    expect(project.querySelector('h2')?.textContent).toBe('Example Portal');
    expect(project.querySelectorAll('.bullet-row')).toHaveLength(2);
    expect(target.querySelectorAll('.bullet-row')).toHaveLength(2);
    const parentAction = target.querySelector('select')!;
    parentAction.value = 'skip';
    parentAction.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(project.textContent).toContain('saved without an experience link');
  });

  it('requires informed consent and keeps the upload busy until its response arrives', async () => {
    let resolve: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport();
    const upload = target.querySelector<HTMLButtonElement>('button')!;
    expect(upload.disabled).toBe(true);
    choosePdf(target);
    expect(upload.disabled).toBe(false);
    upload.click();
    flushSync();
    expect(upload.textContent).toContain('Uploading');
    expect(upload.disabled).toBe(true);
    const body = (
      fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    )[0]?.[1].body as FormData;
    expect(body.get('consent')).toBe('true');
    expect(body.get('file')).toBeInstanceOf(File);
    resolve(response(review()));
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Review proposed changes.'),
    );
    expect(navigation.replaceState).toHaveBeenCalledWith('/?id=import-1', {});
  });

  it('shows an AI-provider failure and lets the user retain the selected file for retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(
          { error: 'Configured AI provider is unavailable. Try again later.' },
          false,
        ),
      ),
    );
    const target = mountImport();
    choosePdf(target);
    target.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() =>
      expect(target.querySelector('[role=alert]')?.textContent).toContain(
        'AI provider is unavailable',
      ),
    );
    expect(target.textContent).toContain('resume.pdf');
    expect(target.querySelector<HTMLButtonElement>('button')?.disabled).toBe(
      false,
    );
  });

  it('refreshes a revision with server warnings and preserves edited draft on stale apply', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          review('r2', ['Some text could not be read. Please verify dates.']),
        ),
      )
      .mockResolvedValueOnce(
        response(
          {
            error:
              'This review is stale. Refresh and compare the newest proposal.',
          },
          false,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport({
      ...review('r1'),
      status: 'processing' as const,
    });
    target.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Some text could not be read'),
    );
    const title = [...target.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.value === 'Engineer',
    )!;
    title.value = 'Senior Engineer';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    const apply = [
      ...target.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Apply selected'))!;
    apply.click();
    await vi.waitFor(() =>
      expect(target.querySelector('[role=alert]')?.textContent).toContain(
        'review is stale',
      ),
    );
    expect(title.value).toBe('Senior Engineer');
    const payload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(payload).toMatchObject({
      revision: 'r2',
      entries: [
        {
          id: 'experience-1',
          action: 'create',
          fields: { title: 'Senior Engineer' },
        },
      ],
    });
  });

  it('preserves an opaque receipt query after a reload and clears it after removal', async () => {
    window.history.replaceState(
      {},
      '',
      '/admin/career/import?view=review&id=import-1',
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(review('r2')))
      .mockResolvedValueOnce(response({}));
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport({
      ...review('r1'),
      status: 'processing' as const,
    });
    expect(target.textContent).toContain('Waiting for processing to start');
    target.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() =>
      expect(navigation.replaceState).toHaveBeenCalledWith(
        '/admin/career/import?view=review&id=import-1',
        {},
      ),
    );
    [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) =>
        button.textContent?.includes('Remove this private upload'),
      )
      ?.click();
    await vi.waitFor(() =>
      expect(navigation.replaceState).toHaveBeenLastCalledWith(
        '/admin/career/import?view=review',
        {},
      ),
    );
  });

  it('does not persist a response identifier that could be interpreted as a URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({ ...review(), id: 'https://outside.example/import' }),
      ),
    );
    const target = mountImport();
    choosePdf(target);
    target.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() =>
      expect(target.querySelector('[role=alert]')?.textContent).toContain(
        'unexpected response',
      ),
    );
    expect(navigation.replaceState).not.toHaveBeenCalled();
  });

  it('requires an explicit new generation after an expired receipt rejects the same PDF', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          {
            error: 'This PDF belongs to a deleted or expired import.',
            code: 'expired_import',
          },
          false,
        ),
      )
      .mockResolvedValueOnce(response({ ...review(), id: 'import-new' }));
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport();
    choosePdf(target);
    target.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Start a new import'),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    const original = calls[0]?.[1].body as FormData;
    expect(original.get('newImport')).toBeNull();
    const originalRequestId = original.get('requestId');
    [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Start a new import'))
      ?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const replacement = calls[1]?.[1].body as FormData;
    expect(replacement.get('newImport')).toBe('true');
    expect(replacement.get('requestId')).not.toBe(originalRequestId);
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Review proposed changes.'),
    );
  });
  it('starts a fresh generation from an applied receipt without removing the selected PDF', async () => {
    const applied = { ...review(), status: 'applied' as const };
    const processing = {
      ...review(),
      id: 'import-new',
      status: 'processing' as const,
      progress: 'queued' as const,
      entries: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(applied))
      .mockResolvedValueOnce(response(processing));
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport();
    choosePdf(target);
    [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Upload and review'))
      ?.click();
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Selected changes were applied.'),
    );
    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    const original = calls[0]?.[1].body as FormData;
    expect(original.get('file')).toBeInstanceOf(File);
    expect(original.get('newImport')).toBeNull();
    const originalRequestId = original.get('requestId');
    [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Start a new import'))
      ?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const replacement = calls[1]?.[1].body as FormData;
    expect(replacement.get('file')).toBeInstanceOf(File);
    expect(replacement.get('newImport')).toBe('true');
    expect(replacement.get('requestId')).not.toBe(originalRequestId);
    expect(
      calls.every(
        ([url, options]) =>
          url === '/api/admin/resume-import' && options?.method === 'POST',
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Waiting for processing to start'),
    );
  });
  it('sends only the supported requestId field when retrying processing', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      expect(Object.keys(payload)).toEqual(['requestId']);
      expect(payload.requestId).toEqual(expect.any(String));
      return response(review());
    });
    vi.stubGlobal('fetch', fetchMock);
    const target = mountImport({
      ...review(),
      status: 'failed',
      error: 'Retry needed',
    });
    [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Retry processing'))
      ?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(target.textContent).toContain('Review proposed changes.'),
    );
  });
});
