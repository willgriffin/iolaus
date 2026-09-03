<script lang="ts">
import { onMount, tick } from 'svelte';
import type { Experience, Profile, Skills } from '../types';
import {
  buildSystemPrompt,
  createSession,
  type DetectedAI,
  detectBuiltInAI,
} from '../utils/ai';

interface Props {
  open: boolean;
  onClose: () => void;
  profile: Profile;
  experience: Experience;
  skills: Skills;
}

const { open, onClose, profile, experience, skills }: Props = $props();

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

let detected = $state<DetectedAI | null>(null);
let session = $state<AISession | null>(null);
let messages = $state<ChatMessage[]>([]);
let input = $state('');
let busy = $state(false);
let error = $state<string | null>(null);

let scrollRef = $state<HTMLDivElement>();
let inputRef = $state<HTMLInputElement>();

onMount(() => {
  detectBuiltInAI().then((d) => {
    detected = d;
  });
});

$effect(() => {
  if (!open || !detected || session) return;
  let cancelled = false;
  (async () => {
    try {
      const sys = buildSystemPrompt(profile, experience, skills);
      const s = await createSession(detected, sys);
      if (!cancelled) session = s;
    } catch (e) {
      if (!cancelled) error = (e as Error).message || String(e);
    }
  })();
  return () => {
    cancelled = true;
  };
});

$effect(() => {
  if (open) {
    setTimeout(() => inputRef?.focus(), 100);
  }
});

$effect(() => {
  // Track messages/busy for autoscroll
  void messages;
  void busy;
  if (scrollRef) {
    tick().then(() => {
      if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
    });
  }
});

async function send(text?: string) {
  const q = (text ?? input).trim();
  if (!q || !session || busy) return;
  input = '';
  error = null;
  messages = [
    ...messages,
    { role: 'user', content: q },
    { role: 'assistant', content: '', streaming: true },
  ];
  busy = true;
  try {
    const stream = session.promptStreaming?.(q);
    if (stream && (stream as AsyncIterable<string>)[Symbol.asyncIterator]) {
      let acc = '';
      for await (const chunk of stream as AsyncIterable<string>) {
        if (chunk.startsWith(acc) && chunk.length >= acc.length) {
          acc = chunk;
        } else {
          acc += chunk;
        }
        messages = [
          ...messages.slice(0, -1),
          { role: 'assistant', content: acc, streaming: true },
        ];
      }
      messages = [
        ...messages.slice(0, -1),
        { role: 'assistant', content: acc },
      ];
    } else {
      const answer = await session.prompt(q);
      messages = [
        ...messages.slice(0, -1),
        { role: 'assistant', content: answer },
      ];
    }
  } catch (e) {
    error = (e as Error).message || String(e);
    messages = messages.slice(0, -1);
  } finally {
    busy = false;
  }
}

const SUGGESTIONS = [
  "What's your strongest technical area?",
  "Tell me about a hard system you've built.",
  'How do you use AI in your workflow?',
  'Why should we hire you?',
];

const firstName = $derived(profile.name.split(' ')[0].toLowerCase());

function onSubmit(e: SubmitEvent) {
  e.preventDefault();
  send();
}
</script>

{#if open}
  <button
    type="button"
    class="interview-scrim"
    onclick={onClose}
    aria-label="Close interview overlay"
  ></button>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <aside class="interview-panel" role="dialog" aria-label="Interview candidate">
    <header class="interview-head">
      <div>
        <div class="interview-title">Interview · {profile.name}</div>
        <div class="interview-sub">
          Ask anything about the resume. Answers run locally in your browser.
        </div>
      </div>
      <button class="interview-close" onclick={onClose} aria-label="Close">×</button>
    </header>

    <div class="interview-scroll" bind:this={scrollRef}>
      {#if !detected}
        <div class="interview-empty">
          <div class="interview-empty-mark">⛯</div>
          <div>Checking for Chrome's built-in AI…</div>
        </div>
      {:else if !session && !error}
        <div class="interview-empty">
          <div class="interview-empty-mark">⛯</div>
          <div>Loading model — first run may take a moment.</div>
        </div>
      {/if}

      {#if session && messages.length === 0}
        <div class="interview-empty">
          <div class="interview-empty-mark">⌘</div>
          <div class="interview-empty-title">Ready when you are.</div>
          <div class="interview-empty-blurb">Try a starter question, or type your own.</div>
          <div class="interview-suggestions">
            {#each SUGGESTIONS as s (s)}
              <button class="interview-suggest" onclick={() => send(s)}>{s}</button>
            {/each}
          </div>
        </div>
      {/if}

      {#each messages as m, i (i)}
        <div class={`msg msg-${m.role}`}>
          <div class="msg-role">{m.role === 'user' ? 'you' : firstName}</div>
          <div class="msg-body">
            {#if m.content}
              {m.content}
            {:else if m.streaming}
              <span class="msg-cursor">▊</span>
            {/if}
            {#if m.streaming && m.content}
              <span class="msg-cursor">▊</span>
            {/if}
          </div>
        </div>
      {/each}

      {#if error}
        <div class="interview-error">⚠ {error}</div>
      {/if}
    </div>

    <form class="interview-form" onsubmit={onSubmit}>
      <input
        bind:this={inputRef}
        type="text"
        placeholder={session ? 'Ask a question…' : 'Loading…'}
        value={input}
        disabled={!session || busy}
        oninput={(e) => (input = (e.currentTarget as HTMLInputElement).value)}
      />
      <button type="submit" disabled={!session || !input.trim() || busy}>
        {busy ? '…' : 'Ask'}
      </button>
    </form>
    <div class="interview-foot">
      Powered by Chrome's on-device <code>window.ai</code>. No data leaves your machine.
    </div>
  </aside>
{/if}
