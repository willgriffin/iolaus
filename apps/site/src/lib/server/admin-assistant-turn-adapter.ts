import { createHash, randomUUID } from 'node:crypto';
import type { AIMessage, TokenUsage } from '@happyvertical/ai';
import { sendAgentReply } from '@happyvertical/smrt-chat/internal/agent-runtime';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  type AdminAssistantGovernedTurnInput,
  type AdminAssistantSendResult,
  AdminAssistantThreadNotFoundError,
  AdminAssistantUnavailableError,
  getAdminAssistantChat,
  listAdminAssistantMessages,
  requireAdminAssistantThread,
  serializeAdminAssistantMessage,
} from './admin-assistant-chat.js';
import {
  actualAssistantSpendMicros,
  estimatedAssistantSpendMicros,
  resolveAdminAssistantAiClient,
  resolveAdminAssistantTurnConfig,
} from './admin-assistant-turn-config.js';
import {
  type AdminAssistantTurnIdentity,
  createAdminAssistantTurnStore,
} from './admin-assistant-turn-store.js';
import {
  AiUsageRefusedError,
  assertAiEnabled,
  reserveAiUserSpend,
} from './ai-usage-guard.js';
import { getRequestScopedSmrtOptions } from './smrt.js';
import {
  requireCandidateWorkspaceSubject,
  withVerifiedWorkspaceSubject,
} from './workspace-subject.js';

const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CODEPOINTS = 12_000;
const MAX_ASSISTANT_REPLY_CODEPOINTS = 12_000;

const SYSTEM_PROMPT = [
  'You are Iolaus’s administrative assistant.',
  'Help the signed-in person understand and navigate the application.',
  'You have no tools and cannot submit applications, alter records, or claim an action completed.',
  'State uncertainty plainly and ask a focused follow-up when information is missing.',
].join(' ');

export class AdminAssistantRequestConflictError extends Error {
  constructor() {
    super('This request ID was already used for different assistant input.');
  }
}

export class AdminAssistantTurnTerminalError extends Error {
  constructor(readonly code: 'blocked' | 'failed') {
    super(
      code === 'blocked'
        ? 'The assistant session has reached its configured spending limit.'
        : 'This assistant request already ended without a reply. Send a new request to try again.',
    );
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function codepoints(value: string): number {
  return Array.from(value).length;
}

function boundedHistory(
  messages: Awaited<ReturnType<typeof listAdminAssistantMessages>>,
  currentContent: string,
): AIMessage[] {
  const selected: AIMessage[] = [];
  let remaining = MAX_HISTORY_CODEPOINTS - codepoints(currentContent);
  for (const message of messages.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    if (
      (message.role !== 'assistant' && message.role !== 'user') ||
      !message.content.trim() ||
      remaining <= 0
    ) {
      continue;
    }
    const content = Array.from(message.content).slice(-remaining).join('');
    if (!content) continue;
    selected.unshift({ content, role: message.role });
    remaining -= codepoints(content);
  }
  return selected;
}

function estimatedTokens(messages: AIMessage[]): number {
  return Math.ceil(
    messages.reduce((total, message) => {
      const content =
        typeof message.content === 'string' ? message.content : '';
      return total + codepoints(content);
    }, 0) / 4,
  );
}

function providerRequestId(response: unknown, fallback: string): string {
  const record = response as Record<string, unknown>;
  for (const key of ['providerRequestId', 'requestId', 'id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim())
      return candidate.trim();
  }
  return fallback;
}

function providerErrorCode(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim())
      return code.trim().slice(0, 120);
  }
  return 'provider_error';
}

function usageParts(usage: TokenUsage | undefined): {
  completionTokens: number;
  promptTokens: number;
} {
  return {
    completionTokens:
      typeof usage?.completionTokens === 'number' &&
      Number.isSafeInteger(usage.completionTokens) &&
      usage.completionTokens >= 0
        ? usage.completionTokens
        : 0,
    promptTokens:
      typeof usage?.promptTokens === 'number' &&
      Number.isSafeInteger(usage.promptTokens) &&
      usage.promptTokens >= 0
        ? usage.promptTokens
        : 0,
  };
}

function requirePersistedId(
  record: { id: string | null | undefined },
  label: string,
): string {
  const id = record.id?.trim();
  if (!id) throw new AdminAssistantUnavailableError();
  return id;
}

async function configuredDatabase() {
  return await resolveDatabase(getRequestScopedSmrtOptions().db as never);
}

async function replayResult(
  input: AdminAssistantGovernedTurnInput,
  ids: { assistantMessageId: string | null; userMessageId: string | null },
): Promise<AdminAssistantSendResult> {
  const messages = await listAdminAssistantMessages(
    input,
    requirePersistedId(input.thread, 'thread'),
  );
  const byId = new Map(messages.map((message) => [message.id, message]));
  const userMessage = ids.userMessageId
    ? byId.get(ids.userMessageId)
    : undefined;
  const assistantMessage = ids.assistantMessageId
    ? byId.get(ids.assistantMessageId)
    : undefined;
  return {
    inProgress: !userMessage || !assistantMessage,
    ...(userMessage ? { userMessage } : {}),
    ...(assistantMessage ? { assistantMessage } : {}),
    ...(userMessage && assistantMessage ? { messages } : {}),
  };
}

/**
 * Runs one explicit, configured assistant turn. The reservation happens before
 * transcript/provider work; provider execution is deliberately outside the
 * short database transaction. A duplicate request is replayed or reported as
 * in progress, never submitted a second time.
 */
export async function runConfiguredAdminAssistantTurn(
  input: AdminAssistantGovernedTurnInput,
): Promise<AdminAssistantSendResult> {
  assertAiEnabled();
  const threadId = requirePersistedId(input.thread, 'thread');
  const agentSessionId = requirePersistedId(input.session, 'session');
  const roomId = input.session.chatRoomId?.trim();
  if (!roomId) throw new AdminAssistantUnavailableError();
  const config = resolveAdminAssistantTurnConfig();
  if (!config) throw new AdminAssistantUnavailableError();
  const client = await resolveAdminAssistantAiClient(config);
  if (!client) throw new AdminAssistantUnavailableError();

  const history = boundedHistory(
    await listAdminAssistantMessages(input, threadId),
    input.content,
  );
  const messages: AIMessage[] = [
    { content: SYSTEM_PROMPT, role: 'system' },
    ...history,
    { content: input.content, role: 'user' },
  ];
  const inputTokens = estimatedTokens(messages);
  if (inputTokens > config.maxInputTokens) {
    throw new AdminAssistantTurnTerminalError('blocked');
  }
  const reservedSpendMicros = estimatedAssistantSpendMicros(
    config,
    inputTokens,
  );
  if (reservedSpendMicros > config.turnSpendLimitMicros) {
    throw new AdminAssistantTurnTerminalError('blocked');
  }

  const identity: AdminAssistantTurnIdentity = {
    agentSessionId,
    clientRequestId: input.clientRequestId,
    contentHash: contentHash(input.content),
    profileId: input.subject.profileId,
    tenantId: input.subject.tenantId,
    threadId,
    userId: input.subject.userId,
  };
  const requestId = randomUUID();
  const store = createAdminAssistantTurnStore(await configuredDatabase());
  const reservation = await store.reserve({
    ...identity,
    estimatedInputTokens: inputTokens,
    maxOutputTokens: config.maxOutputTokens,
    model: config.model,
    profile: client.profile,
    requestId,
    reservedSpendMicros,
    sessionSpendLimitMicros: config.sessionSpendLimitMicros,
    turnSpendLimitMicros: config.turnSpendLimitMicros,
  });
  if (reservation.kind === 'conflict')
    throw new AdminAssistantRequestConflictError();
  if (reservation.kind === 'completed') {
    return await replayResult(input, reservation.turn);
  }
  if (reservation.kind === 'in_progress') return { inProgress: true };
  if (reservation.kind === 'blocked' || reservation.kind === 'failed') {
    throw new AdminAssistantTurnTerminalError(reservation.kind);
  }

  // The per-session limit above still applies; the per-user cap is the
  // account-wide budget shared with every other hosted AI feature.
  let userSpend: Awaited<ReturnType<typeof reserveAiUserSpend>>;
  try {
    userSpend = await reserveAiUserSpend({
      feature: 'admin-assistant',
      micros: reservedSpendMicros,
      requestId,
      subject: {
        tenantId: input.subject.tenantId,
        userId: input.subject.userId,
      },
    });
  } catch (refusal) {
    await store.fail(
      identity,
      reservation.turn.id,
      refusal instanceof AiUsageRefusedError ? refusal.code : 'ai_refused',
      {
        accountingBasis: 'actual',
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualSpendMicros: 0,
      },
    );
    throw refusal;
  }

  let providerInvoked = false;
  let providerUsage: TokenUsage | undefined;
  try {
    const userMessage = await input.chat.sendMessage({
      actorProfileId: input.subject.profileId,
      agentSessionId,
      content: input.content,
      roomId,
      tenantId: input.subject.tenantId,
      threadId,
    });
    await store.markRunning(
      identity,
      reservation.turn.id,
      requirePersistedId(userMessage, 'user message'),
    );
    providerInvoked = true;
    const response = await client.aiClient.chat(messages, {
      maxTokens: config.maxOutputTokens,
      model: config.model,
      reasoning: { effort: 'none', maxTokens: 0 },
      timeout: client.timeout,
      toolChoice: 'none',
      usageTags: { feature: 'admin-assistant' },
      user: reservation.turn.requestId,
    });
    providerUsage = response.usage;
    if (response.toolCalls?.length) {
      throw Object.assign(
        new Error('Assistant responses may not contain tool calls.'),
        {
          code: 'unexpected_tool_call',
        },
      );
    }
    const content = response.content.trim();
    if (!content || codepoints(content) > MAX_ASSISTANT_REPLY_CODEPOINTS) {
      throw Object.assign(
        new Error('Assistant returned an invalid response.'),
        {
          code: 'invalid_response',
        },
      );
    }
    const fresh = await withVerifiedWorkspaceSubject(
      input.subject,
      async (subject) => {
        const verifiedAssistant = await getAdminAssistantChat(
          requireCandidateWorkspaceSubject(subject),
        );
        const verifiedAgentSessionId = requirePersistedId(
          verifiedAssistant.session,
          'session',
        );
        if (verifiedAgentSessionId !== agentSessionId) {
          throw new AdminAssistantThreadNotFoundError();
        }
        await requireAdminAssistantThread(verifiedAssistant, threadId);
        return {
          assistant: verifiedAssistant,
          message: await sendAgentReply(verifiedAssistant.chat, {
            agentSessionId: verifiedAgentSessionId,
            content,
            kind: 'assistant',
            tenantId: verifiedAssistant.subject.tenantId,
            threadId,
          }),
        };
      },
    );
    const usage = usageParts(response.usage);
    const accounting = actualAssistantSpendMicros(
      config,
      response.usage,
      reservation.turn.reservedSpendMicros,
    );
    await userSpend?.settle(accounting.spendMicros, accounting.basis);
    await store.complete(identity, reservation.turn.id, {
      accountingBasis: accounting.basis,
      actualInputTokens: usage.promptTokens,
      actualOutputTokens: usage.completionTokens,
      actualSpendMicros: accounting.spendMicros,
      assistantMessageId: requirePersistedId(
        fresh.message,
        'assistant message',
      ),
      providerRequestId: providerRequestId(
        response,
        reservation.turn.requestId,
      ),
    });
    const serializedUser = serializeAdminAssistantMessage(userMessage);
    const serializedAssistant = serializeAdminAssistantMessage(fresh.message);
    return {
      assistantMessage: serializedAssistant,
      inProgress: false,
      messages: [serializedUser, serializedAssistant],
      userMessage: serializedUser,
    };
  } catch (cause) {
    const accounting = providerInvoked
      ? actualAssistantSpendMicros(
          config,
          providerUsage,
          reservation.turn.reservedSpendMicros,
        )
      : { basis: 'actual' as const, spendMicros: 0 };
    const usage = usageParts(providerUsage);
    if (providerInvoked)
      await userSpend?.settle(accounting.spendMicros, accounting.basis);
    else await userSpend?.release();
    await store.fail(identity, reservation.turn.id, providerErrorCode(cause), {
      accountingBasis: accounting.basis,
      actualInputTokens: usage.promptTokens,
      actualOutputTokens: usage.completionTokens,
      actualSpendMicros: accounting.spendMicros,
    });
    throw cause;
  }
}
