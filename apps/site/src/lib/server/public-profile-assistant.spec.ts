import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  shared: vi.fn(() => true),
}));
vi.mock('./public-profile-service', () => ({
  getPublicProfile: mocks.profile,
}));
vi.mock('./app-config', () => ({ isSharedHosted: mocks.shared }));

import { publicProfileApiSchema } from '$lib/public-profile-api-contract';
import { publicProfileApiResponse } from './public-profile-api';
import {
  ASSISTANT_LIMITS,
  AssistantHttpError,
  allowedOrigins,
  answerPublicProfileChat,
  assistantCorsHeaders,
  assistantErrorResponse,
  assistantInstructions,
  assistantPreflightResponse,
  liveVoiceCalls,
  openPublicProfileVoice,
  profileContext,
  publicAssistantEnabled,
  publicVoiceEnabled,
  resetPublicAssistantState,
  sseFrames,
} from './public-profile-assistant';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../docs/public-profile-api/synthetic-profile.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const handle = fixture.handle as string;
const SITE = 'https://portfolio.example';
const current = () => ({
  handle,
  revisionId: 'private-revision-id',
  publishedAt: fixture.revisionCreatedAt,
  snapshot: { version: 1, ...structuredClone(fixture.profile) },
});
const enable = (voice = false) => {
  vi.stubEnv('IOLAUS_PUBLIC_PROFILES_ENABLED', 'true');
  vi.stubEnv('IOLAUS_PUBLIC_ASSISTANT_ENABLED', 'true');
  vi.stubEnv('IOLAUS_PUBLIC_ASSISTANT_ORIGINS', `${SITE}, https://two.example`);
  if (voice) vi.stubEnv('IOLAUS_PUBLIC_ASSISTANT_OPENAI_API_KEY', 'sk-test');
};
const chatRequest = (
  body: unknown,
  init: { origin?: string | null; type?: string } = {},
) =>
  new Request(`https://api.example/api/public/v1/profiles/${handle}/chat`, {
    method: 'POST',
    headers: {
      ...(init.origin === null ? {} : { origin: init.origin ?? SITE }),
      'content-type': init.type ?? 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const offer =
  'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const voiceRequest = (body: string = offer, type = 'application/sdp') =>
  new Request(`https://api.example/api/public/v1/profiles/${handle}/voice`, {
    method: 'POST',
    headers: { origin: SITE, 'content-type': type },
    body,
  });
const read = (response: Response) => response.text();
const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error) => (error instanceof AssistantHttpError ? error.status : 500),
  );

beforeEach(() => {
  mocks.profile.mockReset();
  mocks.profile.mockResolvedValue(current());
  mocks.shared.mockReturnValue(true);
  resetPublicAssistantState();
});
afterEach(() => vi.unstubAllEnvs());

describe('public profile assistant gating and CORS', () => {
  it('is off unless shared hosting, public profiles and the assistant flag agree', () => {
    expect(publicAssistantEnabled()).toBe(false);
    vi.stubEnv('IOLAUS_PUBLIC_PROFILES_ENABLED', 'true');
    expect(publicAssistantEnabled()).toBe(false);
    vi.stubEnv('IOLAUS_PUBLIC_ASSISTANT_ENABLED', 'true');
    expect(publicAssistantEnabled()).toBe(true);
    expect(publicVoiceEnabled()).toBe(false);
    vi.stubEnv('IOLAUS_PUBLIC_ASSISTANT_OPENAI_API_KEY', 'sk-test');
    expect(publicVoiceEnabled()).toBe(true);
    mocks.shared.mockReturnValue(false);
    expect(publicAssistantEnabled()).toBe(false);
  });

  it('answers only allow-listed browser origins and never wildcards', () => {
    enable();
    expect([...allowedOrigins()]).toEqual([SITE, 'https://two.example']);
    const headers = assistantCorsHeaders(chatRequest({}));
    expect(headers['access-control-allow-origin']).toBe(SITE);
    expect(headers['access-control-allow-methods']).toBe('POST, OPTIONS');
    expect(headers.vary).toBe('origin');
    expect(() =>
      assistantCorsHeaders(chatRequest({}, { origin: 'https://evil.example' })),
    ).toThrow(AssistantHttpError);
    const serverToServer = assistantCorsHeaders(
      chatRequest({}, { origin: null }),
    );
    expect(serverToServer['access-control-allow-origin']).toBeUndefined();
    expect(serverToServer['cache-control']).toBe('no-store');
    vi.stubEnv(
      'IOLAUS_PUBLIC_ASSISTANT_ORIGINS',
      'javascript:alert(1), not a url',
    );
    expect(allowedOrigins().size).toBe(0);
  });

  it('exposes the call-length header to allow-listed browsers', () => {
    enable();
    expect(
      assistantCorsHeaders(chatRequest({}))['access-control-expose-headers'],
    ).toBe('x-voice-seconds');
  });

  it('preflight answers the typed 404 while disabled or for a bad handle, before any origin decision', async () => {
    const evil = chatRequest({}, { origin: 'https://evil.example' });
    for (const kind of ['chat', 'voice'] as const) {
      expect(
        assistantPreflightResponse(handle, chatRequest({}), kind).status,
      ).toBe(404);
      expect(assistantPreflightResponse(handle, evil, kind).status).toBe(404);
    }
    enable();
    expect(
      assistantPreflightResponse(handle, chatRequest({}), 'chat').status,
    ).toBe(204);
    expect(
      assistantPreflightResponse('../x', chatRequest({}), 'chat').status,
    ).toBe(404);
    expect(assistantPreflightResponse(handle, evil, 'chat').status).toBe(403);
    // Voice preflight needs the voice key too.
    expect(
      assistantPreflightResponse(handle, chatRequest({}), 'voice').status,
    ).toBe(404);
    enable(true);
    const ok = assistantPreflightResponse(handle, chatRequest({}), 'voice');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('describes both endpoints in the OpenAPI document', () => {
    const openapi = JSON.parse(
      readFileSync(
        new URL(
          '../../../../../docs/public-profile-api/openapi.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    for (const kind of ['chat', 'voice']) {
      const item = openapi.paths[`/api/public/v1/profiles/{handle}/${kind}`];
      expect(item?.post).toBeDefined();
      expect(item?.options).toBeDefined();
      expect(Object.keys(item.post.responses)).toEqual(
        expect.arrayContaining(['403', '404', '429', '503']),
      );
    }
    expect(
      openapi.paths['/api/public/v1/profiles/{handle}/chat'].post.responses[
        '200'
      ].content['text/event-stream'],
    ).toBeDefined();
    expect(
      openapi.paths['/api/public/v1/profiles/{handle}/voice'].post.responses[
        '201'
      ].headers['x-voice-seconds'],
    ).toBeDefined();
    expect(openapi.components.schemas.AssistantError).toBeDefined();
  });

  it('typed errors never leak internals', async () => {
    const response = assistantErrorResponse(new Error('db password wrong'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: {
        code: 'ASSISTANT_UNAVAILABLE',
        message: 'Assistant unavailable.',
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('advertises chat and voice links only while enabled', async () => {
    let payload = await (await publicProfileApiResponse(handle)).json();
    expect(payload.links).toEqual({
      profile: `/people/${handle}`,
      pdf: `/people/${handle}/resume.pdf`,
    });
    enable();
    payload = await (await publicProfileApiResponse(handle)).json();
    expect(payload.links.chat).toBe(`/api/public/v1/profiles/${handle}/chat`);
    expect(payload.links.voice).toBeUndefined();
    enable(true);
    payload = await (await publicProfileApiResponse(handle)).json();
    expect(payload.links.voice).toBe(`/api/public/v1/profiles/${handle}/voice`);
    expect(publicProfileApiSchema.safeParse(payload).success).toBe(true);
    expect(
      publicProfileApiSchema.safeParse({
        ...payload,
        links: { ...payload.links, chat: 'https://evil.example/chat' },
      }).success,
    ).toBe(false);
  });
});

describe('grounding', () => {
  it('renders the published snapshot as bounded plain text and nothing else', () => {
    const text = profileContext(fixture.profile);
    expect(text).toContain(`Name: ${fixture.profile.name}`);
    for (const job of fixture.profile.experience)
      expect(text).toContain(`${job.role} at ${job.company}`);
    expect(text).not.toContain('tenantId');
    const long = {
      ...fixture.profile,
      summary: 'x'.repeat(ASSISTANT_LIMITS.contextChars + 500),
    };
    expect(profileContext(long).length).toBeLessThanOrEqual(
      ASSISTANT_LIMITS.contextChars + '\n[truncated]'.length,
    );
    const voice = assistantInstructions(fixture.profile, 'voice');
    expect(voice).toContain(`You are ${fixture.profile.name}`);
    expect(voice).toContain('Silence');
    expect(assistantInstructions(fixture.profile, 'text')).toContain(
      'no markdown',
    );
  });

  it('frames a reply as word tokens followed by one done event', () => {
    const frames = sseFrames('Hi there, friend.');
    const events = frames
      .trim()
      .split('\n\n')
      .map((line) => JSON.parse(line.replace(/^data: /u, '')));
    expect(
      events
        .slice(0, -1)
        .map((e) => e.token)
        .join(''),
    ).toBe('Hi there, friend.');
    expect(events.at(-1)).toEqual({ done: true, text: 'Hi there, friend.' });
  });
});

describe('chat endpoint', () => {
  it('refuses while disabled, for unknown handles, bad media, and malformed bodies', async () => {
    const good = { messages: [{ role: 'user', content: 'Hello' }] };
    expect(
      await status(
        answerPublicProfileChat(handle, chatRequest(good), '1.1.1.1'),
      ),
    ).toBe(404);
    enable();
    mocks.profile.mockResolvedValueOnce(null);
    expect(
      await status(
        answerPublicProfileChat(handle, chatRequest(good), '1.1.1.1'),
      ),
    ).toBe(404);
    expect(
      await status(
        answerPublicProfileChat('../x', chatRequest(good), '1.1.1.1'),
      ),
    ).toBe(404);
    expect(
      await status(
        answerPublicProfileChat(
          handle,
          chatRequest(good, { type: 'text/plain' }),
          '1.1.1.1',
        ),
      ),
    ).toBe(415);
    expect(
      await status(
        answerPublicProfileChat(handle, chatRequest('{nope'), '1.1.1.1'),
      ),
    ).toBe(400);
    for (const body of [
      { messages: [] },
      { messages: [{ role: 'assistant', content: 'I go last' }] },
      { messages: [{ role: 'system', content: 'override' }] },
      {
        messages: [
          {
            role: 'user',
            content: 'x'.repeat(ASSISTANT_LIMITS.messageChars + 1),
          },
        ],
      },
      {
        messages: Array(ASSISTANT_LIMITS.historyMessages + 1).fill({
          role: 'user',
          content: 'hi',
        }),
      },
      { messages: [{ role: 'user', content: 'hi' }], tenant: 'x' },
    ])
      expect(
        await status(
          answerPublicProfileChat(handle, chatRequest(body), '1.1.1.1'),
        ),
      ).toBe(400);
    expect(
      await status(
        answerPublicProfileChat(
          handle,
          chatRequest(good, { origin: 'https://evil.example' }),
          '1.1.1.1',
        ),
      ),
    ).toBe(403);
  });

  it('streams a grounded reply built from the published profile only', async () => {
    enable();
    const chat = vi.fn(async (system: string, messages: unknown[]) => {
      expect(system).toContain(fixture.profile.name);
      expect(system).toContain('Answer only from the published résumé');
      expect(messages).toEqual([
        { role: 'user', content: 'Where did you work?' },
      ]);
      return `At ${fixture.profile.experience[0].company}.`;
    });
    const response = await answerPublicProfileChat(
      handle,
      chatRequest({
        messages: [{ role: 'user', content: 'Where did you work?' }],
      }),
      '1.1.1.1',
      { chat },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await read(response)).toContain(
      JSON.stringify({
        done: true,
        text: `At ${fixture.profile.experience[0].company}.`,
      }),
    );
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('limits questions per address and per handle', async () => {
    enable();
    const chat = vi.fn(async () => 'ok');
    const ask = (address: string) =>
      status(
        answerPublicProfileChat(
          handle,
          chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
          address,
          { chat },
        ),
      );
    for (let i = 0; i < ASSISTANT_LIMITS.chatPerAddress; i++)
      expect(await ask('2.2.2.2')).toBe(200);
    expect(await ask('2.2.2.2')).toBe(429);
    expect(await ask('3.3.3.3')).toBe(200);
    // IPv6 hosts share a /64 window.
    expect(await ask('2001:db8:1:2:aaaa::1')).toBe(200);
    for (let i = 1; i < ASSISTANT_LIMITS.chatPerAddress; i++)
      await ask('2001:db8:1:2:bbbb::9');
    expect(await ask('2001:db8:1:2:cccc::3')).toBe(429);
    let sent = chat.mock.calls.length;
    for (let address = 10; sent < ASSISTANT_LIMITS.chatPerHandle; address++) {
      for (
        let i = 0;
        i < ASSISTANT_LIMITS.chatPerAddress &&
        sent < ASSISTANT_LIMITS.chatPerHandle;
        i++
      ) {
        expect(await ask(`10.0.0.${address}`)).toBe(200);
        sent++;
      }
    }
    expect(await ask('9.9.9.9')).toBe(429);
  });
});

describe('voice endpoint', () => {
  it('needs the key, an SDP audio offer and an allowed origin', async () => {
    enable();
    expect(
      await status(openPublicProfileVoice(handle, voiceRequest(), '1.1.1.1')),
    ).toBe(503);
    enable(true);
    expect(
      await status(
        openPublicProfileVoice(
          handle,
          voiceRequest(offer, 'application/json'),
          '1.1.1.1',
        ),
      ),
    ).toBe(415);
    expect(
      await status(
        openPublicProfileVoice(handle, voiceRequest('v=1 nonsense'), '1.1.1.1'),
      ),
    ).toBe(400);
    expect(
      await status(
        openPublicProfileVoice(
          handle,
          voiceRequest(`${offer}${'a'.repeat(ASSISTANT_LIMITS.offerBytes)}`),
          '1.1.1.1',
        ),
      ),
    ).toBe(413);
    mocks.profile.mockResolvedValueOnce(null);
    expect(
      await status(openPublicProfileVoice(handle, voiceRequest(), '1.1.1.1')),
    ).toBe(404);
  });

  it('opens a bounded call with the voice instructions and hangs up on expiry', async () => {
    enable(true);
    vi.useFakeTimers();
    try {
      const createCall = vi.fn(
        async (sdp: string, options: Record<string, unknown>) => {
          expect(sdp).toBe(offer);
          expect(options.apiKey).toBe('sk-test');
          expect(options.maxOutputTokens).toBe(
            ASSISTANT_LIMITS.voiceMaxOutputTokens,
          );
          expect(String(options.instructions)).toContain('Spoken replies');
          return { answer: 'v=0\r\nanswer', callId: 'call-1' };
        },
      );
      const hangup = vi.fn(async () => undefined);
      const response = await openPublicProfileVoice(
        handle,
        voiceRequest(),
        '1.1.1.1',
        {
          createCall: createCall as never,
          hangup: hangup as never,
        },
      );
      expect(response.status).toBe(201);
      expect(response.headers.get('content-type')).toBe('application/sdp');
      expect(await read(response)).toBe('v=0\r\nanswer');
      expect(hangup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(
        ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
      );
      expect(hangup).toHaveBeenCalledWith('call-1', { apiKey: 'sk-test' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a slot reserved until the provider confirms the hang-up', async () => {
    enable(true);
    vi.useFakeTimers();
    try {
      const createCall = vi.fn(async () => ({
        answer: 'v=0',
        callId: 'stuck',
      }));
      let failures = 2;
      const hangup = vi.fn(async () => {
        if (failures-- > 0) throw new Error('provider timeout');
      });
      const deps = { createCall: createCall as never, hangup: hangup as never };
      expect(
        await status(
          openPublicProfileVoice(handle, voiceRequest(), '30.0.0.1', deps),
        ),
      ).toBe(200);
      expect(liveVoiceCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(
        ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
      );
      expect(hangup).toHaveBeenCalledTimes(1);
      // The first hang-up failed: the line is still counted as busy.
      expect(liveVoiceCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(ASSISTANT_LIMITS.hangupRetryMs + 1);
      expect(hangup).toHaveBeenCalledTimes(2);
      expect(liveVoiceCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(ASSISTANT_LIMITS.hangupRetryMs + 1);
      expect(hangup).toHaveBeenCalledTimes(3);
      expect(liveVoiceCalls()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a call the provider no longer knows as ended, and frees a line once retries are spent', async () => {
    enable(true);
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const createCall = vi.fn(async () => ({
        answer: 'v=0',
        callId: `call-${createCall.mock.calls.length}`,
      }));
      // The visitor hung up first: the provider answers 404.
      const gone = vi.fn(async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      });
      expect(
        await status(
          openPublicProfileVoice(handle, voiceRequest(), '40.0.0.1', {
            createCall: createCall as never,
            hangup: gone as never,
          }),
        ),
      ).toBe(200);
      await vi.advanceTimersByTimeAsync(
        ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
      );
      expect(gone).toHaveBeenCalledTimes(1);
      expect(liveVoiceCalls()).toBe(0);
      // A provider that keeps failing does not strand the line forever.
      const broken = vi.fn(async () => {
        throw Object.assign(new Error('upstream'), { status: 502 });
      });
      expect(
        await status(
          openPublicProfileVoice(handle, voiceRequest(), '40.0.0.2', {
            createCall: createCall as never,
            hangup: broken as never,
          }),
        ),
      ).toBe(200);
      await vi.advanceTimersByTimeAsync(
        ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
      );
      for (let i = 1; i < ASSISTANT_LIMITS.hangupRetries; i++) {
        expect(liveVoiceCalls()).toBe(1);
        await vi.advanceTimersByTimeAsync(ASSISTANT_LIMITS.hangupRetryMs + 1);
      }
      expect(broken).toHaveBeenCalledTimes(ASSISTANT_LIMITS.hangupRetries);
      expect(liveVoiceCalls()).toBe(0);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(String(errorLog.mock.calls[0][0])).not.toContain('sk-');
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not spend a handle or address start on a request turned away by busy lines', async () => {
    enable(true);
    vi.useFakeTimers();
    try {
      const createCall = vi.fn(async () => ({
        answer: 'v=0',
        callId: `call-${createCall.mock.calls.length}`,
      }));
      const hangup = vi.fn(async () => undefined);
      const deps = { createCall: createCall as never, hangup: hangup as never };
      const open = (address: string) =>
        status(openPublicProfileVoice(handle, voiceRequest(), address, deps));
      for (let i = 0; i < ASSISTANT_LIMITS.voiceConcurrent; i++)
        expect(await open(`50.0.0.${i}`)).toBe(200);
      // Many retries while the lines are busy...
      for (let i = 0; i < 20; i++) expect(await open('50.0.1.1')).toBe(429);
      await vi.advanceTimersByTimeAsync(
        ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
      );
      // ...cost neither the retrying address nor the handle its starts.
      expect(await open('50.0.1.1')).toBe(200);
      await vi.advanceTimersByTimeAsync(
        ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
      );
      let opened = ASSISTANT_LIMITS.voiceConcurrent + 1;
      for (let i = 0; opened < ASSISTANT_LIMITS.voicePerHandle; i++, opened++) {
        expect(await open(`50.0.2.${i}`)).toBe(200);
        await vi.advanceTimersByTimeAsync(
          ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
        );
      }
      expect(await open('50.0.3.1')).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps concurrent calls and per-address attempts, and cleans up failed setups', async () => {
    enable(true);
    vi.useFakeTimers();
    try {
      const createCall = vi.fn(async () => ({
        answer: 'v=0',
        callId: `call-${createCall.mock.calls.length}`,
      }));
      const hangup = vi.fn(async () => undefined);
      const deps = { createCall: createCall as never, hangup: hangup as never };
      const open = (address: string, d = deps) =>
        status(openPublicProfileVoice(handle, voiceRequest(), address, d));
      for (let i = 0; i < ASSISTANT_LIMITS.voiceConcurrent; i++)
        expect(await open(`6.6.6.${i}`)).toBe(200);
      expect(await open('6.6.6.9')).toBe(429);
      // Expiry frees the lines.
      await vi.advanceTimersByTimeAsync(
        ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
      );
      expect(hangup).toHaveBeenCalledTimes(ASSISTANT_LIMITS.voiceConcurrent);
      for (let i = 0; i < ASSISTANT_LIMITS.voicePerAddress; i++) {
        expect(await open('7.7.7.7')).toBe(200);
        await vi.advanceTimersByTimeAsync(
          ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
        );
      }
      expect(await open('7.7.7.7')).toBe(429);
      // Distinct addresses cannot replenish one handle's starts without bound.
      resetPublicAssistantState();
      for (let i = 0; i < ASSISTANT_LIMITS.voicePerHandle; i++) {
        expect(await open(`20.0.${Math.floor(i / 3)}.${i}`)).toBe(200);
        await vi.advanceTimersByTimeAsync(
          ASSISTANT_LIMITS.voiceSeconds * 1000 + 1,
        );
      }
      expect(await open('21.0.0.1')).toBe(429);
      resetPublicAssistantState();
      const failing = vi.fn(async () => {
        throw new Error('provider down');
      });
      expect(
        await open('8.8.8.8', {
          createCall: failing as never,
          hangup: hangup as never,
        }),
      ).toBe(502);
      // A failed setup releases its admission slot.
      expect(await open('8.8.8.9')).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
