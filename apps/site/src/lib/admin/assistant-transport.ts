import type {
  AssistantMessage,
  AssistantSendMessageResult,
  AssistantThreadSummary,
  AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';

/** Same-origin cookie authentication. All session ownership is resolved by the server. */
export function createAdminAssistantTransport(
  fetchImpl: typeof fetch = fetch,
): AssistantTransport {
  const base = '/api/admin/assistant/threads';
  async function request<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(url, {
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        typeof payload?.message === 'string'
          ? payload.message
          : 'Assistant is unavailable.',
      );
    }
    if (!payload || typeof payload !== 'object')
      throw new Error('Invalid assistant response.');
    return payload as T;
  }
  return {
    async listThreads() {
      const payload = await request<{ items: AssistantThreadSummary[] }>(base);
      if (!Array.isArray(payload.items))
        throw new Error('Invalid assistant thread list.');
      return payload.items;
    },
    createThread: (title) => request<AssistantThreadSummary>(base, { title }),
    async loadMessages(threadId) {
      const payload = await request<{ items: AssistantMessage[] }>(
        `${base}/${encodeURIComponent(threadId)}/messages`,
      );
      if (!Array.isArray(payload.items))
        throw new Error('Invalid assistant messages.');
      return payload.items;
    },
    sendMessage: ({ threadId, content, clientRequestId }) =>
      request<AssistantSendMessageResult>(
        `${base}/${encodeURIComponent(threadId)}/messages`,
        { content, clientRequestId },
      ),
    async uploadAttachment() {
      throw new Error('Attachments are not available in this assistant.');
    },
  };
}
