import { describe, expect, it, vi } from 'vitest';
import { createAdminAssistantTransport } from './assistant-transport';

const thread = {
  id: 'owned',
  title: 'Chat',
  isResolved: false,
  messageCount: 0,
};
describe('admin assistant same-origin transport', () => {
  it('uses cookie-authenticated owned endpoints without browser authority fields', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/messages'))
        return Response.json(
          init?.method === 'POST' ? { inProgress: true } : { items: [] },
        );
      return Response.json(
        init?.method === 'POST' ? thread : { items: [thread] },
      );
    });
    const transport = createAdminAssistantTransport(fetcher as typeof fetch);
    expect(await transport.listThreads()).toEqual([thread]);
    expect(await transport.createThread('Chat')).toEqual(thread);
    expect(await transport.loadMessages('owned/a')).toEqual([]);
    const input = {
      threadId: 'owned/a',
      content: 'Hello',
      clientRequestId: 'same-retry',
    };
    await transport.sendMessage(input);
    await transport.sendMessage(input);
    const sends = fetcher.mock.calls.filter(
      ([, init]) => init?.body && String(init.body).includes('same-retry'),
    );
    expect(sends).toHaveLength(2);
    expect(sends[0]?.[0]).toBe(
      '/api/admin/assistant/threads/owned%2Fa/messages',
    );
    expect(sends[0]?.[1]?.body).toBe(sends[1]?.[1]?.body);
    expect(JSON.parse(String(sends[0]?.[1]?.body))).toEqual({
      content: 'Hello',
      clientRequestId: 'same-retry',
    });
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.credentials).toBe('same-origin');
      expect(init?.headers ?? {}).not.toHaveProperty('Authorization');
    }
  });
  it.each([
    401, 403, 404, 503,
  ])('shows server refusal at HTTP %s without creating a substitute reply', async (status) => {
    const fetcher = vi.fn(async () =>
      Response.json({ message: 'Unavailable' }, { status }),
    );
    await expect(
      createAdminAssistantTransport(fetcher).listThreads(),
    ).rejects.toThrow('Unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    {},
    { items: 'bad' },
  ])('rejects malformed thread lists %j', async (payload) => {
    await expect(
      createAdminAssistantTransport(async () =>
        Response.json(payload),
      ).listThreads(),
    ).rejects.toThrow(/Invalid assistant/);
  });
  it('does not claim attachment support or send files', async () => {
    const fetcher = vi.fn();
    const transport = createAdminAssistantTransport(fetcher);
    await expect(
      transport.uploadAttachment(new File(['private'], 'resume.txt')),
    ).rejects.toThrow('Attachments are not available');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
