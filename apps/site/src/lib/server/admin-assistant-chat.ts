import {
  type AgentSession,
  type ChatMessage,
  ChatService,
  type ChatThread,
} from '@happyvertical/smrt-chat';
import { getRequestScopedSmrtOptions } from './smrt.js';
import {
  type CandidateWorkspaceSubject,
  requireCandidateWorkspaceSubject,
} from './workspace-subject.js';

export const ADMIN_ASSISTANT_AGENT_ID = 'iolaus_admin_assistant';
const ADMIN_ASSISTANT_SESSION_KEY_PREFIX = 'admin-assistant';
const MAX_THREAD_COUNT = 50;

export type AdminAssistantThreadSummary = {
  id: string;
  title: string;
  isResolved: boolean;
  messageCount: number;
  lastMessageAt: string | null;
};

export type AdminAssistantMessage = {
  id: string;
  threadId: string;
  content: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string;
  clientRequestId?: string;
};

export type AdminAssistantSendResult = {
  inProgress: boolean;
  userMessage?: AdminAssistantMessage;
  assistantMessage?: AdminAssistantMessage;
  messages?: AdminAssistantMessage[];
};

export type AdminAssistantChat = {
  chat: ChatService;
  session: AgentSession;
  subject: CandidateWorkspaceSubject;
};

export type AdminAssistantGovernedTurnInput = AdminAssistantChat & {
  clientRequestId: string;
  content: string;
  thread: ChatThread;
};

/**
 * This boundary is responsible for one atomic, durable reservation keyed by
 * the exact verified subject, thread, clientRequestId, and canonical message
 * fingerprint before it writes either a user or agent message. A retry returns
 * the original outcome or inProgress; it must never execute a second provider
 * turn.
 */
export type AdminAssistantGovernedTurnAdapter = {
  /**
   * The adapter owns the one governed model turn. It must write the user turn
   * through `chat.sendMessage` with the verified subject's tenant, room,
   * profile, thread, and session; agent replies remain on SMRT's internal
   * agent-reply bridge. Browser input never supplies those fields.
   */
  run(
    input: AdminAssistantGovernedTurnInput,
  ): Promise<AdminAssistantSendResult>;
};

export class AdminAssistantUnavailableError extends Error {
  constructor() {
    super('The assistant provider is not configured.');
  }
}

/** Returned for both a missing thread and a thread outside this profile's room. */
export class AdminAssistantThreadNotFoundError extends Error {
  constructor() {
    super('Admin assistant thread was not found.');
  }
}

function sessionKey(subject: CandidateWorkspaceSubject): string {
  return [
    ADMIN_ASSISTANT_SESSION_KEY_PREFIX,
    subject.tenantId,
    subject.userId,
    subject.profileId,
  ].join(':');
}

function requireRoomId(session: AgentSession): string {
  const roomId = session.chatRoomId?.trim();
  if (!roomId) throw new Error('Admin assistant session has no chat room.');
  return roomId;
}

function requirePersistedId(
  record: { id: string | null | undefined },
  label: string,
): string {
  const id = record.id?.trim();
  if (!id)
    throw new Error(`Admin assistant ${label} is missing its persisted ID.`);
  return id;
}

function requireCreatedAt(message: ChatMessage): Date {
  const createdAt = message.created_at;
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new Error(
      'Admin assistant message is missing its creation timestamp.',
    );
  }
  return createdAt;
}

function requireAssistantSession(
  session: AgentSession,
  subject: CandidateWorkspaceSubject,
): void {
  if (
    !session.isActive() ||
    session.agentId !== ADMIN_ASSISTANT_AGENT_ID ||
    session.tenantId !== subject.tenantId ||
    session.participantProfileId !== subject.profileId ||
    session.getSessionKey() !== sessionKey(subject)
  ) {
    throw new Error('Admin assistant session is outside this workspace.');
  }
  requireRoomId(session);
}

function safeRole(value: unknown): AdminAssistantMessage['role'] {
  return value === 'user' ||
    value === 'assistant' ||
    value === 'system' ||
    value === 'tool'
    ? value
    : 'system';
}

function metadata(message: ChatMessage): Record<string, unknown> {
  try {
    return message.getMetadata();
  } catch {
    return {};
  }
}

export function serializeAdminAssistantMessage(
  message: ChatMessage,
): AdminAssistantMessage {
  const threadId = message.threadId?.trim();
  if (!threadId) {
    throw new Error('Admin assistant messages must belong to a thread.');
  }
  const requestId = metadata(message).clientRequestId;
  return {
    id: requirePersistedId(message, 'message'),
    threadId,
    content: message.content,
    role: safeRole(message.role),
    createdAt: requireCreatedAt(message).toISOString(),
    ...(typeof requestId === 'string' && requestId.length > 0
      ? { clientRequestId: requestId }
      : {}),
  };
}

export function serializeAdminAssistantThread(
  thread: ChatThread,
): AdminAssistantThreadSummary {
  return {
    id: requirePersistedId(thread, 'thread'),
    title: thread.title,
    isResolved: thread.isResolved,
    messageCount: thread.messageCount,
    lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
  };
}

/**
 * Creates or retrieves the one profile-scoped administrative assistant
 * session. Chat schema creation belongs to normal migrations; this never
 * calls ChatService.initialize() from a request.
 */
export async function getAdminAssistantChat(
  subjectInput: CandidateWorkspaceSubject,
): Promise<AdminAssistantChat> {
  const subject = requireCandidateWorkspaceSubject(subjectInput);
  const chat = await ChatService.create({
    db: getRequestScopedSmrtOptions().db,
    tenantId: subject.tenantId,
  });
  const created = await chat.createAgentSession({
    tenantId: subject.tenantId,
    agentId: ADMIN_ASSISTANT_AGENT_ID,
    actorProfileId: subject.profileId,
    allowedTools: [],
    sessionKey: sessionKey(subject),
  });
  requireAssistantSession(created.session, subject);

  // This session is intentionally plain chat until a separately governed
  // provider adapter is activated. Refreshing an existing session keeps the
  // persisted offer gate fail-closed.
  const session = await chat.updateAgentSessionConfig({
    agentSessionId: requirePersistedId(created.session, 'session'),
    actorProfileId: subject.profileId,
    tenantId: subject.tenantId,
    allowedTools: [],
  });
  requireAssistantSession(session, subject);
  return { chat, session, subject };
}

export async function listAdminAssistantThreads(
  assistant: AdminAssistantChat,
): Promise<AdminAssistantThreadSummary[]> {
  requireAssistantSession(assistant.session, assistant.subject);
  const threads = await assistant.chat.listRoomThreads({
    roomId: requireRoomId(assistant.session),
    actorProfileId: assistant.subject.profileId,
    tenantId: assistant.subject.tenantId,
  });
  return threads
    .sort(
      (left, right) =>
        (right.lastMessageAt?.getTime() ?? 0) -
        (left.lastMessageAt?.getTime() ?? 0),
    )
    .slice(0, MAX_THREAD_COUNT)
    .map(serializeAdminAssistantThread);
}

export async function createAdminAssistantThread(
  assistant: AdminAssistantChat,
  title: string,
): Promise<AdminAssistantThreadSummary> {
  requireAssistantSession(assistant.session, assistant.subject);
  const thread = await assistant.chat.startThread({
    tenantId: assistant.subject.tenantId,
    roomId: requireRoomId(assistant.session),
    actorProfileId: assistant.subject.profileId,
    title,
  });
  return serializeAdminAssistantThread(thread);
}

export async function requireAdminAssistantThread(
  assistant: AdminAssistantChat,
  threadId: string,
): Promise<ChatThread> {
  requireAssistantSession(assistant.session, assistant.subject);
  const thread = await assistant.chat.getThread({
    tenantId: assistant.subject.tenantId,
    threadId,
  });
  if (!thread || thread.roomId !== requireRoomId(assistant.session)) {
    throw new AdminAssistantThreadNotFoundError();
  }
  return thread;
}

export async function listAdminAssistantMessages(
  assistant: AdminAssistantChat,
  threadId: string,
): Promise<AdminAssistantMessage[]> {
  await requireAdminAssistantThread(assistant, threadId);
  const messages = await assistant.chat.getThreadMessages({
    tenantId: assistant.subject.tenantId,
    threadId,
    actorProfileId: assistant.subject.profileId,
    limit: 100,
  });
  return messages.map(serializeAdminAssistantMessage);
}

export async function sendAdminAssistantMessage(
  assistant: AdminAssistantChat,
  input: {
    adapter?: AdminAssistantGovernedTurnAdapter;
    clientRequestId: string;
    content: string;
    threadId: string;
  },
): Promise<AdminAssistantSendResult> {
  const thread = await requireAdminAssistantThread(assistant, input.threadId);
  const turn = {
    ...assistant,
    clientRequestId: input.clientRequestId,
    content: input.content,
    thread,
  };
  if (input.adapter) return await input.adapter.run(turn);
  // This dynamic boundary keeps the chat room/session facade importable for
  // feature-off requests and isolated chat tests. The adapter itself refuses
  // to write a transcript or call a provider until its dedicated model and
  // accounting configuration are complete.
  const { runConfiguredAdminAssistantTurn } = await import(
    './admin-assistant-turn-adapter.js'
  );
  return await runConfiguredAdminAssistantTurn(turn);
}
