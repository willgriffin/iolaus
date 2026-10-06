import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
  AdminAssistantThreadNotFoundError,
  AdminAssistantUnavailableError,
  getAdminAssistantChat,
  listAdminAssistantMessages,
  sendAdminAssistantMessage,
} from '$lib/server/admin-assistant-chat.js';
import { isAdminAssistantEnabled } from '$lib/server/admin-assistant-config.js';
import {
  AdminAssistantRequestConflictError,
  AdminAssistantTurnTerminalError,
} from '$lib/server/admin-assistant-turn-adapter.js';
import {
  requireCandidateWorkspaceSubject,
  WorkspaceSubjectError,
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject.js';

const MAX_CLIENT_REQUEST_ID_CODEPOINTS = 160;
const MAX_MESSAGE_CODEPOINTS = 4000;

function requireEnabled(): void {
  if (!isAdminAssistantEnabled()) {
    throw error(404, 'Assistant is unavailable.');
  }
}

function requiredThreadId(value: string | undefined): string {
  const threadId = value?.trim();
  if (!threadId || Array.from(threadId).length > 200) {
    throw error(400, 'threadId is required.');
  }
  return threadId;
}

function bodyFrom(value: unknown): {
  content: string;
  clientRequestId: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw error(400, 'A JSON request body is required.');
  }
  const body = value as Record<string, unknown>;
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const clientRequestId =
    typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';
  if (!content) throw error(400, 'content is required.');
  if (!clientRequestId) throw error(400, 'clientRequestId is required.');
  if (Array.from(content).length > MAX_MESSAGE_CODEPOINTS) {
    throw error(
      400,
      `content must be ${MAX_MESSAGE_CODEPOINTS} characters or fewer.`,
    );
  }
  if (Array.from(clientRequestId).length > MAX_CLIENT_REQUEST_ID_CODEPOINTS) {
    throw error(
      400,
      `clientRequestId must be ${MAX_CLIENT_REQUEST_ID_CODEPOINTS} characters or fewer.`,
    );
  }
  return { content, clientRequestId };
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

export const GET: RequestHandler = async ({ locals, params }) => {
  requireEnabled();
  const threadId = requiredThreadId(params.threadId);
  try {
    return json({
      items: await withAssistant(locals, (assistant) =>
        listAdminAssistantMessages(assistant, threadId),
      ),
    });
  } catch (cause) {
    if (cause instanceof AdminAssistantThreadNotFoundError) {
      throw error(404, cause.message);
    }
    throw cause;
  }
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  requireEnabled();
  const threadId = requiredThreadId(params.threadId);
  const body = bodyFrom(await request.json().catch(() => null));
  try {
    return json(
      await withAssistant(locals, (assistant) =>
        sendAdminAssistantMessage(assistant, {
          clientRequestId: body.clientRequestId,
          content: body.content,
          threadId,
        }),
      ),
    );
  } catch (cause) {
    if (cause instanceof AdminAssistantUnavailableError) {
      return json({ message: cause.message }, { status: 503 });
    }
    if (cause instanceof AdminAssistantRequestConflictError) {
      return json({ message: cause.message }, { status: 409 });
    }
    if (cause instanceof AdminAssistantTurnTerminalError) {
      return json(
        { message: cause.message },
        { status: cause.code === 'blocked' ? 429 : 409 },
      );
    }
    if (cause instanceof AdminAssistantThreadNotFoundError) {
      throw error(404, cause.message);
    }
    throw cause;
  }
};
