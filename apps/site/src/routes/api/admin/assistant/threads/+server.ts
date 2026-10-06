import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
  createAdminAssistantThread,
  getAdminAssistantChat,
  listAdminAssistantThreads,
} from '$lib/server/admin-assistant-chat.js';
import { isAdminAssistantEnabled } from '$lib/server/admin-assistant-config.js';
import {
  requireCandidateWorkspaceSubject,
  WorkspaceSubjectError,
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject.js';

const MAX_THREAD_TITLE_CODEPOINTS = 120;

function requireEnabled(): void {
  if (!isAdminAssistantEnabled()) {
    throw error(404, 'Assistant is unavailable.');
  }
}

function codepointSlice(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

function titleFrom(body: unknown): string {
  const candidate =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).title
      : undefined;
  if (typeof candidate !== 'string') throw error(400, 'title is required.');
  const title = candidate.trim();
  if (!title) throw error(400, 'title is required.');
  if (Array.from(title).length > MAX_THREAD_TITLE_CODEPOINTS) {
    throw error(
      400,
      `title must be ${MAX_THREAD_TITLE_CODEPOINTS} characters or fewer.`,
    );
  }
  return codepointSlice(title, MAX_THREAD_TITLE_CODEPOINTS);
}

async function withAssistant<T>(
  locals: App.Locals,
  operation: (
    assistant: Awaited<ReturnType<typeof getAdminAssistantChat>>,
  ) => Promise<T>,
): Promise<T> {
  try {
    const subject = requireCandidateWorkspaceSubject(
      workspaceSubjectFromLocals(locals),
    );
    return await withVerifiedWorkspaceSubject(
      subject,
      async (verified) =>
        await operation(
          await getAdminAssistantChat(
            requireCandidateWorkspaceSubject(verified),
          ),
        ),
    );
  } catch (cause) {
    if (cause instanceof WorkspaceSubjectError) {
      throw error(cause.status, cause.message);
    }
    throw cause;
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  requireEnabled();
  return json({
    items: await withAssistant(locals, listAdminAssistantThreads),
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  requireEnabled();
  const title = titleFrom(await request.json().catch(() => null));
  return json(
    await withAssistant(locals, (assistant) =>
      createAdminAssistantThread(assistant, title),
    ),
    { status: 201 },
  );
};
