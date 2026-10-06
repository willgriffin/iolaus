<script lang="ts">
import {
  createToaster,
  Modal,
  ToastViewport,
} from '@happyvertical/smrt-ui/feedback';
import ExternalLink from '@lucide/svelte/icons/external-link';
import Heart from '@lucide/svelte/icons/heart';
import Star from '@lucide/svelte/icons/star';
import X from '@lucide/svelte/icons/x';
import { untrack } from 'svelte';
import { deserialize } from '$app/forms';
import type { AdminRecord } from '$lib/admin/dock';
import {
  TRIAGE_SWIPE_MAX_TILT_DEG,
  TRIAGE_SWIPE_THRESHOLD_PX,
  type TriageDrag,
  triageDragTransform,
  triageReleaseVerdict,
  triageSwipeProgress,
} from '$lib/admin/triage-gestures';
import type { TriagePreflight } from '$lib/admin/triage-preflight';
import {
  TRIAGE_PREFETCH_SIZE,
  TRIAGE_PREFETCH_THRESHOLD,
  triageDeckAcceptsKeys,
  triageDeckShowsEmpty,
  triageRefillOffset,
  triageRefillOutcome,
  triageSessionKey,
  triageVerdictRating,
} from '$lib/admin/triage-session';
import {
  isEditableTriageTarget,
  type TriageShortcutAction,
  triageShortcutFor,
} from '$lib/admin/triage-shortcuts';
import { getNumber, getString } from '$lib/opportunity-filters';
import OpportunityTriageCard from './OpportunityTriageCard.svelte';

/**
 * The triage deck, as a modal over the opportunity list (issue #425).
 *
 * The list is the context and owns the filter; this dialog is a session over
 * the undecided rows that filter selects. It lives inside the admin shell's
 * stacking context as a native `<dialog>` — the shell's left nav and right dock
 * are not something to break out of with a viewport-fixed bar, so the three
 * verdicts live in the dialog's own footer instead.
 *
 * The working model is: unseen items, quickly, at low commitment.
 *
 * - **No numbers.** No position, no remaining count, no session tally. The deck
 *   just keeps going. A backlog in the thousands is discouraging as a number and
 *   useless as a decision input; the card in hand is the whole job. The queue
 *   prefetches and refills underneath, silently.
 * - **Low commitment.** Nothing is ever forced. **Later** is the cheap default,
 *   Esc and the close button leave at any point with no confirmation, and every
 *   verdict up to that point is already recorded per card.
 * - **Low friction.** No confirm dialogs anywhere; the advance is optimistic and
 *   the next card is on screen before the previous write returns. Undo stays
 *   available.
 *
 * Three verdicts, and nothing else:
 *
 * - **Nope** (left) records `reject` through `?/reviewOpportunity`.
 * - **Later** (middle) records nothing; the card stays undecided and the queue
 *   steps past it.
 * - **Dig deeper** (right) records `maybe` through `?/digDeeper`, which also
 *   queues the opportunity intelligence job, one posting check, and a
 *   company-research task.
 *
 * The two verdicts also carry a rating, so a decision leaves the signal the
 * shortlist and every later pass sort by — unless the record already carries
 * one, which always wins. The card shows neither the rating nor the posting
 * check; both ride on the verdict.
 *
 * Applying happens on the shortlist (`review=maybe`, score first) or the record
 * page; there is no apply path in this deck.
 */

/** Only the most recent entry is ever offered, but keep a bounded history. */
const UNDO_STACK_LIMIT = 10;

/** The list route owns the queue read and every decision action. */
const LIST_PATH = '/admin/opportunities';

/** The deck, in screen order: left, middle, right. */
const DECK_ACTIONS = [
  { action: 'reject', hint: '← / h / x', label: 'Nope', tone: 'nope' },
  { action: 'skip', hint: 'space / s', label: 'Later', tone: 'later' },
  { action: 'digDeeper', hint: '→ / l / d', label: 'Dig deeper', tone: 'dig' },
] as const satisfies readonly {
  action: TriageShortcutAction;
  hint: string;
  label: string;
  tone: string;
}[];

const DEEP_DIVE_LABELS: Record<string, string> = {
  intelligence: 'Intelligence',
  research: 'Company research',
  verify: 'Posting check',
};

type DeepDiveStep = { message: string; name: string; status: string };

type UndoEntry = {
  label: string;
  record: AdminRecord;
  snapshot: Record<string, string>;
};

let {
  open = $bindable(false),
  candidateSkills = [],
  search = '',
  singleOpportunity = null,
  onClose,
  onDecision,
}: {
  /** Whether the deck is on screen. Owned by the list. */
  open?: boolean;
  candidateSkills?: string[];
  /** The list's current filter query string; the queue is seeded from it. */
  search?: string;
  /** A server-loaded list record reviewed alone, without reading the queue. */
  singleOpportunity?: AdminRecord | null;
  /** Called on Esc and the close button. */
  onClose?: () => void;
  /** Fired only after a single-opportunity review write succeeds. */
  onDecision?: (opportunityId: string) => void;
} = $props();

/** Cards in hand, oldest first; the head is the card on screen. */
let queue = $state<AdminRecord[]>(
  untrack(() => (singleOpportunity ? [singleOpportunity] : [])),
);
/**
 * How many cards the operator passed on. Skipped rows stay undecided, so they
 * stay in the server queue — the offset steps past exactly this many of them.
 * It is queue bookkeeping, never shown.
 */
let skipped = $state(0);
/** Verdicts recorded this session. Also bookkeeping: the refill reads it. */
let decided = $state(0);
let loading = $state(false);
let loadError = $state('');
let undoStack = $state<UndoEntry[]>([]);
/** Blocks only the actions that need the card *in hand* — undo and verify. */
let busy = $state(false);
/**
 * Transient notices go through the shared smrt-ui toaster rather than a strip
 * over the card: a verdict should not leave a sentence sitting on the next
 * posting. Errors stay up longer; confirmations get out of the way.
 */
const toasts = createToaster();
function notify(text: string, tone: 'error' | 'info' = 'info'): void {
  toasts.show({
    duration: tone === 'error' ? 6000 : 2200,
    message: text,
    variant: tone,
  });
}
/** What the last dig-deeper actually queued, shown as a strip under the head. */
let deepDive = $state<DeepDiveStep[]>([]);
/** Preflight verdicts recorded in this session, layered over the queue read. */
let preflights = $state<Record<string, TriagePreflight | null>>({});
/**
 * The review reason, seeded from the card in hand. An undecided opportunity can
 * already carry notes, and `updateOpportunityReview` overwrites the column with
 * whatever is posted, so an empty box would silently destroy them.
 */
let notes = $state('');
let notesCardId = '';

/** Ids already served in this session, so a refill never re-serves a card. */
let servedIds = new Set<string>();
/** In-flight writes by opportunity id, so undo lands after the write it undoes. */
let writes = new Map<string, Promise<unknown>>();
let sessionKey = '';
/**
 * Bumped by every session start. A read in flight was issued against the filter
 * and ordering of the session that asked for it, so when a restart supersedes
 * that session the read's window, its `atEnd`, and its error must be dropped
 * rather than landing in the deck the operator is now looking at.
 */
let sessionToken = 0;
let refilling = false;
/**
 * True once a window came back short: everything the filter still has for this
 * session is in hand, so the prefetch stops asking. Decisions only remove rows
 * from the queue, so this never goes false again inside a session.
 */
let atEnd = false;
/**
 * Bumped when a refill that raced its own optimistic writes has to be retried.
 * It is part of the prefetch's key, so re-arming the guard is one more operator
 * step rather than a loop: only a landed write can bump it.
 */
let refillTick = $state(0);
/**
 * The operator state the last refill was issued for. An optimistic decision
 * may not have committed when the next window is read, so the same rows can
 * come back and be filtered out as already served; without this the prefetch
 * would re-ask for them in a loop.
 */
let lastRefillKey = '';

/**
 * Where the deck puts the initial focus.
 *
 * `showModal()` focuses the first focusable descendant of the dialog. An inert
 * anchor takes focus instead, so every documented key works from the moment the
 * deck opens rather than triggering the close button.
 */
let focusAnchor = $state<HTMLDivElement | null>(null);

$effect(() => {
  if (!open) return;
  const anchor = focusAnchor;
  if (!anchor) return;
  // After the dialog's own focusing steps, whichever order the effects ran in.
  const frame = requestAnimationFrame(() => anchor.focus?.());
  return () => cancelAnimationFrame(frame);
});

/** Live drag offsets while a swipe is in progress, or `null` when idle. */
let drag = $state<TriageDrag | null>(null);
let dragPointerId: number | null = null;
let dragOriginX = 0;
let dragOriginY = 0;
/**
 * Set from `prefers-reduced-motion` after hydration. The card never moves for
 * an operator who asked for stillness; the swipe still commits, because the
 * motion is decoration and the verdict is not.
 */
let reducedMotion = $state(false);

const current = $derived<AdminRecord | null>(queue[0] ?? null);
const lastUndo = $derived(undoStack.at(-1) ?? null);
const dragTransform = $derived(
  triageDragTransform(drag ?? { dx: 0, dy: 0 }, {
    maxTilt: TRIAGE_SWIPE_MAX_TILT_DEG,
    reducedMotion,
    threshold: TRIAGE_SWIPE_THRESHOLD_PX,
  }),
);
/** Signed `[-1, 1]`: which verdict the drag in hand is arming, and how far. */
const dragProgress = $derived(
  drag ? triageSwipeProgress(drag, TRIAGE_SWIPE_THRESHOLD_PX) : 0,
);
const deckStyle = $derived(
  drag
    ? `transform: translate3d(${dragTransform.translate}px, 0, 0) rotate(${dragTransform.rotate}deg);`
    : '',
);
const exhausted = $derived(
  triageDeckShowsEmpty({ hasCard: current !== null, loadError, loading }),
);

/**
 * The queue read is the list state verbatim. The list is the only filter and
 * sort owner, so a salary-ascending list triages salary-ascending too.
 */
const queueSearch = $derived(search);

function str(record: AdminRecord, key: string): string {
  return getString(record, key);
}

/**
 * Open and close are the session boundary: a fresh open starts a fresh session
 * against whatever filter the list is showing now.
 */
$effect(() => {
  const key = `${triageSessionKey({ open, search })}:${singleOpportunity ? str(singleOpportunity, 'id') : 'queue'}`;
  if (key === sessionKey) return;
  sessionKey = key;
  if (open) startSession();
});

/** A drag never survives the dialog: closing mid-swipe records nothing. */
$effect(() => {
  if (!open) resetDrag();
});

/** Lock the page behind the dialog; the deck body does its own scrolling. */
$effect(() => {
  if (!open) return;
  const { body } = document;
  const previous = body.style.overflow;
  body.style.overflow = 'hidden';
  return () => {
    body.style.overflow = previous;
  };
});

$effect(() => {
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (!query) return;
  reducedMotion = query.matches;
  const onChange = (event: MediaQueryListEvent) => {
    reducedMotion = event.matches;
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
});

$effect(() => {
  const id = current ? str(current, 'id') : '';
  if (id === notesCardId) return;
  notesCardId = id;
  // Reset only the modal body when the role changes, never the page behind it.
  const body = focusAnchor?.closest<HTMLElement>('.modal__body');
  if (body) body.scrollTop = 0;
  notes = current ? str(current, 'humanReviewNotes') : '';
});

/** Keep a card ahead of the operator, so the deck never waits on a fetch. */
$effect(() => {
  if (!open || singleOpportunity || loading || atEnd) return;
  if (queue.length >= TRIAGE_PREFETCH_THRESHOLD) return;
  const key = refillKey();
  if (key === lastRefillKey) return;
  lastRefillKey = key;
  void refill();
});

/** One refill per operator step: a decision, a pass, or a landed retry. */
function refillKey(): string {
  return `${skipped}:${decided}:${refillTick}`;
}

function startSession(): void {
  // Claim the deck: any read still in flight belongs to the session this one
  // replaces, and releasing the latch lets this session issue its own.
  sessionToken += 1;
  refilling = false;
  queue = singleOpportunity ? [singleOpportunity] : [];
  busy = false;
  loading = false;
  skipped = 0;
  decided = 0;
  undoStack = [];
  deepDive = [];
  preflights = {};
  toasts.clear();
  loadError = '';
  servedIds = new Set();
  writes = new Map();
  atEnd = singleOpportunity !== null;
  refillTick = 0;
  lastRefillKey = '0:0:0';
  if (!singleOpportunity) void refill();
}

/**
 * Read one window of the queue through the list route's own action, so the
 * deck has no page load of its own and no second query language: the action
 * hands `loadTriageQueue` the list's filter parameters verbatim.
 */
async function refill(): Promise<void> {
  if (singleOpportunity || refilling) return;
  refilling = true;
  loading = true;
  const token = sessionToken;
  // The rows whose verdict is still in the air. The server still counts them as
  // undecided and still serves them at the front, so the read has to step past
  // them — and a window read over them cannot be trusted to mean end-of-queue.
  const pending = [...writes.values()];
  try {
    const body = new FormData();
    body.set('search', queueSearch);
    body.set('offset', String(triageRefillOffset(skipped, pending.length)));
    body.set('limit', String(TRIAGE_PREFETCH_SIZE));
    const response = await fetch(`${LIST_PATH}?/triageQueue`, {
      body,
      headers: { 'x-sveltekit-action': 'true' },
      method: 'POST',
    });
    const result = deserialize(await response.text());
    // A restart while this read was in flight: the window it carries was chosen
    // by the ordering the operator has already left behind.
    if (token !== sessionToken) return;
    if (result.type !== 'success') {
      loadError = 'The triage queue could not be loaded.';
      return;
    }
    const data = (result.data ?? {}) as {
      candidates?: AdminRecord[];
      preflights?: Record<string, TriagePreflight | null>;
    };
    loadError = '';
    const received = data.candidates ?? [];
    preflights = { ...preflights, ...(data.preflights ?? {}) };
    const fresh = received.filter((record) => {
      const id = getString(record, 'id');
      return id !== '' && !servedIds.has(id);
    });
    for (const record of fresh) servedIds.add(getString(record, 'id'));
    queue = [...queue, ...fresh];
    const outcome = triageRefillOutcome({
      fresh: fresh.length,
      limit: TRIAGE_PREFETCH_SIZE,
      pending: pending.length,
      received: received.length,
    });
    atEnd = outcome.atEnd;
    if (outcome.retryAfterWrites) void retryOnceWritesLand(pending, token);
  } catch {
    if (token === sessionToken)
      loadError = 'The triage queue could not be loaded.';
  } finally {
    // The latch and the spinner belong to whichever session owns the deck now.
    if (token === sessionToken) {
      loading = false;
      refilling = false;
    }
  }
}

/**
 * Ask for another window once the decisions that raced this one have landed.
 * Bounded by the writes in hand: only an operator decision creates a write, so
 * this can never spin on its own.
 */
async function retryOnceWritesLand(
  pending: readonly Promise<unknown>[],
  token: number,
): Promise<void> {
  await Promise.allSettled(pending);
  if (token === sessionToken) refillTick += 1;
}

/**
 * A failed queue read is not an empty queue. The prefetch fires once per
 * operator step, so a transport failure would otherwise never be retried —
 * this is that step, and it keys the guard itself so it cannot loop.
 */
function retryQueue(): void {
  if (loading) return;
  loadError = '';
  lastRefillKey = refillKey();
  void refill();
}

/**
 * Post one action and hand back what it returned, or `null` when it failed.
 * The payload matters: `verifyPosting` answers with the preflight verdict the
 * card has to show, and `digDeeper` answers with what it queued.
 */
async function post(
  action: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  try {
    const response = await fetch(`${LIST_PATH}?/${action}`, {
      body,
      headers: { 'x-sveltekit-action': 'true' },
      method: 'POST',
    });
    const result = deserialize(await response.text());
    if (result.type === 'success') {
      const data = (result.data ?? {}) as Record<string, unknown>;
      if (data.status === 'error') {
        notify(
          typeof data.message === 'string'
            ? data.message
            : 'The decision could not be recorded.',
          'error',
        );
        return null;
      }
      return data;
    }
    notify(
      result.type === 'error'
        ? (result.error?.message ?? 'The decision could not be recorded.')
        : 'The decision could not be recorded.',
      'error',
    );
    return null;
  } catch {
    notify('The decision could not be recorded.', 'error');
    return null;
  }
}

function snapshotOf(record: AdminRecord): Record<string, string> {
  const rating = getNumber(record, 'humanRating');
  return {
    humanRating: rating === null ? '' : String(rating),
    humanReviewNotes: str(record, 'humanReviewNotes'),
    humanReviewStatus: str(record, 'humanReviewStatus'),
    opportunityId: str(record, 'id'),
  };
}

function pushUndo(entry: UndoEntry): void {
  undoStack = [...undoStack, entry].slice(-UNDO_STACK_LIMIT);
}

function stepsFrom(result: Record<string, unknown>): DeepDiveStep[] {
  const raw = Array.isArray(result.steps) ? result.steps : [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const step = entry as Record<string, unknown>;
    return [
      {
        message: typeof step.message === 'string' ? step.message : '',
        name: typeof step.name === 'string' ? step.name : '',
        status: typeof step.status === 'string' ? step.status : '',
      },
    ];
  });
}

/** Drop the head of the queue and put the next card on screen immediately. */
function advance(): void {
  queue = queue.slice(1);
}

/** A write that failed puts its card back, at the end, with the reason shown. */
function restore(record: AdminRecord): void {
  queue = [...queue, record];
  decided = Math.max(0, decided - 1);
  undoStack = undoStack.filter(
    (entry) => str(entry.record, 'id') !== str(record, 'id'),
  );
}

/**
 * Record a verdict without waiting for it. The card advances first — one
 * keypress per card, no spinner between cards — and a write that fails puts
 * its card back rather than silently losing it.
 */
function decide(verdict: 'digDeeper' | 'reject'): void {
  const record = current;
  if (!record) return;
  if (singleOpportunity) {
    void decideSingleOpportunity(record, verdict);
    return;
  }
  const snapshot = snapshotOf(record);
  const id = snapshot.opportunityId;
  const label = str(record, 'title') || 'untitled opportunity';
  const reviewNotes = notes;
  // A verdict is a rating in everything but name — unless the operator gave a
  // finer one on the star row, in which case that is what gets written.
  const rating = String(
    triageVerdictRating(getNumber(record, 'humanRating'), verdict),
  );

  advance();
  decided += 1;
  pushUndo({
    label: `Undo ${verdict === 'reject' ? 'nope' : 'dig deeper'} — ${label}`,
    record,
    snapshot,
  });
  deepDive = [];
  notify(
    verdict === 'reject'
      ? 'Nope. Recorded as rejected.'
      : 'Shortlisted as maybe. The deep dive is queued.',
  );

  const write = (async () => {
    const result =
      verdict === 'reject'
        ? await post('reviewOpportunity', {
            humanRating: rating,
            humanReviewNotes: reviewNotes,
            humanReviewStatus: 'reject',
            opportunityId: id,
          })
        : await post('digDeeper', {
            humanRating: rating,
            humanReviewNotes: reviewNotes,
            opportunityId: id,
          });
    if (!result) {
      restore(record);
      return;
    }
    if (verdict !== 'digDeeper') return;
    const steps = stepsFrom(result);
    const verdictPreflight = (result.preflight ??
      null) as TriagePreflight | null;
    if (verdictPreflight) {
      preflights = { ...preflights, [id]: verdictPreflight };
    }
    const failed = steps.filter((step) => step.status === 'error');
    // The queue steps report late, after the card has already advanced, so the
    // strip is about the decision just taken rather than the card on screen.
    deepDive = steps;
    if (failed.length > 0) {
      notify(
        `${label}: shortlisted as maybe, but ${failed.length} follow-up ${failed.length === 1 ? 'step' : 'steps'} failed.`,
        'error',
      );
    }
  })().finally(() => {
    if (writes.get(id) === write) writes.delete(id);
  });
  writes.set(id, write);
}

/** A one-record review stays open until its write has actually succeeded. */
async function decideSingleOpportunity(
  record: AdminRecord,
  verdict: 'digDeeper' | 'reject',
): Promise<void> {
  if (busy) return;
  busy = true;
  const token = sessionToken;
  const id = str(record, 'id');
  const fields = {
    humanRating: String(
      triageVerdictRating(getNumber(record, 'humanRating'), verdict),
    ),
    humanReviewNotes: notes,
    opportunityId: id,
  };
  try {
    const result =
      verdict === 'reject'
        ? await post('reviewOpportunity', {
            ...fields,
            humanReviewStatus: 'reject',
          })
        : await post('digDeeper', fields);
    if (!result) return;
    onDecision?.(id);
    // A late response must not dismiss a different record opened meanwhile.
    if (token === sessionToken && open) close();
  } finally {
    if (token === sessionToken) busy = false;
  }
}

/** The cheap default: record nothing, step past the card, keep moving. */
function later(): void {
  const record = current;
  if (!record) return;
  if (singleOpportunity) {
    close();
    return;
  }
  advance();
  skipped += 1;
  deepDive = [];
  notify('Later. Nothing was recorded.');
}

/**
 * Restore the review fields the last decision replaced. Nothing in this deck
 * creates an application, so an undo is always complete. The optimistic advance
 * means the decision's own write may still be in the air: wait for it, or the
 * restore would land first and be overwritten by the verdict it undoes.
 */
async function undo(): Promise<void> {
  const entry = lastUndo;
  if (!entry || busy) return;
  busy = true;
  try {
    const id = str(entry.record, 'id');
    await writes.get(id)?.catch(() => undefined);
    if (!(await post('reviewOpportunity', entry.snapshot))) return;
    undoStack = undoStack.slice(0, -1);
    if (
      servedIds.has(id) &&
      !queue.some((record) => str(record, 'id') === id)
    ) {
      // The undone card is back in hand, so it no longer counts as handled.
      queue = [entry.record, ...queue];
      decided = Math.max(0, decided - 1);
    }
    deepDive = [];
    notify(
      'Review fields restored. Anything the deep dive already queued keeps running.',
    );
  } finally {
    busy = false;
  }
}

async function verify(): Promise<void> {
  const record = current;
  if (!record || busy) return;
  busy = true;
  try {
    const id = str(record, 'id');
    const result = await post('verifyPosting', { opportunityId: id });
    if (result) {
      const verdict = (result.preflight ?? null) as TriagePreflight | null;
      if (verdict) preflights = { ...preflights, [id]: verdict };
      notify(
        verdict
          ? `Posting preflight recorded: ${verdict.state.replaceAll('_', ' ')}.`
          : 'Posting preflight recorded.',
      );
    }
  } finally {
    busy = false;
  }
}

function openPosting(): void {
  const record = current;
  if (!record) return;
  const url = str(record, 'postingUrl') || str(record, 'applyUrl');
  if (!url) {
    notify('This opportunity has no posting URL.', 'error');
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function handleAction(action: TriageShortcutAction): void {
  if (singleOpportunity && busy) return;
  switch (action) {
    case 'digDeeper':
      decide('digDeeper');
      break;
    case 'reject':
      decide('reject');
      break;
    case 'skip':
      later();
      break;
    case 'undo':
      void undo();
      break;
    case 'verify':
      void verify();
      break;
    case 'open':
      openPosting();
      break;
  }
}

/**
 * The deck's keys belong to the deck. They are inert while the dialog is
 * closed: the list underneath owns the keyboard then.
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  if (!triageDeckAcceptsKeys({ open })) return;
  const action = triageShortcutFor({
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    key: event.key,
    metaKey: event.metaKey,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    target: event.target,
  });
  if (!action) return;
  event.preventDefault();
  handleAction(action);
}

/**
 * A drag that starts on a control, a link, or a scrollable description is that
 * control's own gesture, not a swipe of the deck.
 */
function isDraggableOrigin(target: EventTarget | null): boolean {
  if (isEditableTriageTarget(target)) return false;
  const element = target as Element | null;
  if (!element || typeof element.closest !== 'function') return true;
  return element.closest('a, button, pre, [role="button"]') === null;
}

function startDrag(event: PointerEvent): void {
  if (!current) return;
  if (event.button !== 0 || !event.isPrimary) return;
  if (!isDraggableOrigin(event.target)) return;
  // Capture the pointer so a swipe that strays off the card still reports its
  // move and release here. Without it, leaving the deck mid-drag would strand
  // the card at whatever tilt it had when the pointer left.
  const deck = event.currentTarget as Element | null;
  try {
    deck?.setPointerCapture?.(event.pointerId);
  } catch {
    // Capture is a convenience; a browser that refuses it still swipes.
  }
  dragPointerId = event.pointerId;
  drag = { dx: 0, dy: 0 };
  dragOriginX = event.clientX;
  dragOriginY = event.clientY;
}

function moveDrag(event: PointerEvent): void {
  if (dragPointerId !== event.pointerId || !drag) return;
  drag = { dx: event.clientX - dragOriginX, dy: event.clientY - dragOriginY };
}

function endDrag(event: PointerEvent): void {
  if (dragPointerId !== event.pointerId) return;
  const released = drag;
  dragPointerId = null;
  drag = null;
  if (!released) return;
  const verdict = triageReleaseVerdict(released, {
    // A drag across the facts, the summary, or the requirement lists is a
    // native text selection as much as it is a swipe. The browser collapses any
    // previous selection on pointerdown, so a selection standing here was made
    // by this drag: the operator was reading the card, not deciding on it.
    selectedText: hasTextSelection(),
    threshold: TRIAGE_SWIPE_THRESHOLD_PX,
  });
  if (verdict) handleAction(verdict);
}

/** Whether the drag just released left a text selection behind. */
function hasTextSelection(): boolean {
  try {
    const selection = window.getSelection?.();
    return (
      selection !== null && selection !== undefined && !selection.isCollapsed
    );
  } catch {
    return false;
  }
}

/**
 * Every way a drag can end without a release — `pointercancel`, a lost capture,
 * the dialog closing under it — resets the same way: no verdict, no tilt left
 * behind. A verdict is only ever recorded by `endDrag`.
 */
function cancelDrag(event: PointerEvent): void {
  if (dragPointerId !== event.pointerId) return;
  resetDrag();
}

function resetDrag(): void {
  dragPointerId = null;
  drag = null;
}

/** Esc and the close button are the same exit: leave, and refresh the list. */
function close(): void {
  open = false;
  onClose?.();
}

const shortlistHref = $derived.by(() => {
  const params = new URLSearchParams(search);
  params.set('review', 'maybe');
  params.set('sort', 'score');
  params.set('sortDirection', 'desc');
  return `${LIST_PATH}?${params.toString()}`;
});
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="triage-shell">
  <Modal
    {open}
    size="full"
    closeOnBackdrop={false}
    ariaLabel="Triage opportunities"
    onClose={close}
  >
  {#snippet header()}
    <div class="deck-head">
      {#if current}
        <a class="close" href={`/admin/opportunities/${encodeURIComponent(str(current, 'id'))}`}>
          <ExternalLink size={16} strokeWidth={2.2} /> Open opportunity
        </a>
      {/if}
      <button type="button" class="close" onclick={close} aria-label="Close triage">
        <X size={18} strokeWidth={2.4} /> Close
      </button>
    </div>
  {/snippet}

  <!-- svelte-ignore a11y_autofocus -->
  <div class="focus-anchor" tabindex="-1" autofocus bind:this={focusAnchor}></div>

  <ToastViewport toaster={toasts} position="top-end" />

  {#if loadError}
    <p class="feedback error" role="alert">
      {loadError}
      <button type="button" class="retry" onclick={retryQueue} disabled={loading}>
        Try again
      </button>
    </p>
  {/if}

  {#if deepDive.length > 0}
    <ul class="deep-dive" aria-label="Queued by the last dig deeper">
      {#each deepDive as step}
        <li class={`step ${step.status}`}>
          <strong>{DEEP_DIVE_LABELS[step.name] ?? step.name}</strong>
          <span>{step.message}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if current}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="deck"
      class:dragging={drag !== null}
      style={deckStyle}
      onpointerdown={startDrag}
      onpointermove={moveDrag}
      onpointerup={endDrag}
      onpointercancel={cancelDrag}
      onlostpointercapture={cancelDrag}
    >
      <span class="swipe-hint nope" aria-hidden="true" style={`opacity: ${Math.max(0, -dragProgress)};`}>Nope</span>
      <span class="swipe-hint dig" aria-hidden="true" style={`opacity: ${Math.max(0, dragProgress)};`}>Dig deeper</span>
      <OpportunityTriageCard
        record={current}
        {candidateSkills}
        {busy}
        canUndo={lastUndo !== null}
        undoLabel={lastUndo?.label ?? ''}
        onAction={handleAction}
        bind:notes
      />
    </div>
  {:else if loading}
    <p class="muted loading">Loading the queue…</p>
  {:else if exhausted}
    <div class="empty">
      <h2>Nothing left to look at</h2>
      <p>
        Anything left for later stays undecided and comes back next time.
      </p>
      <div class="empty-actions">
        <button type="button" class="primary" onclick={close}>Close</button>
        <a href={shortlistHref}>Open the shortlist</a>
      </div>
    </div>
  {/if}

  {#snippet footer()}
    <div class="deck-actions">
      {#each DECK_ACTIONS as deckAction}
        <div class={`slot ${deckAction.tone}`}>
          <button
            type="button"
            class={`orb ${deckAction.tone}`}
            disabled={!current || (singleOpportunity !== null && busy)}
            aria-label={deckAction.label}
            title={`${deckAction.label} (${deckAction.hint})`}
            onclick={() => handleAction(deckAction.action)}
          >
            {#if deckAction.action === 'reject'}
              <X size={30} strokeWidth={3} />
            {:else if deckAction.action === 'skip'}
              <Star size={20} strokeWidth={2.6} />
            {:else}
              <Heart size={30} strokeWidth={3} />
            {/if}
          </button>
          <span class="orb-label">{deckAction.label}</span>
          <span class="orb-hint">{deckAction.hint}</span>
        </div>
      {/each}
    </div>
  {/snippet}
  </Modal>
</div>

<style>
  .deck-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 10px 16px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .close {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font-weight: 800;
    cursor: pointer;
  }

  .close:hover,
  .close:focus-visible {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .focus-anchor {
    outline: none;
  }

  .feedback {
    margin: 0 0 10px;
    padding: 8px 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font-size: 13px;
  }

  .feedback.error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    border-color: var(--smrt-color-error);
    color: var(--smrt-color-error);
  }

  .retry {
    min-height: 26px;
    padding: 0 10px;
    border: 1px solid currentcolor;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    font-weight: 800;
    cursor: pointer;
  }

  .retry:disabled {
    cursor: progress;
    opacity: 0.6;
  }

  .deep-dive {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 0 10px;
    padding: 0;
    list-style: none;
  }

  .step {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
  }

  .step strong {
    color: var(--smrt-color-on-surface);
    text-transform: uppercase;
  }

  .step.queued {
    border-color: var(--smrt-color-primary);
  }

  /* Nothing was run: a recorded posting check was still fresh enough to reuse. */
  .step.recent {
    border-style: dashed;
  }

  .step.error {
    border-color: var(--smrt-color-error);
    color: var(--smrt-color-error);
  }

  .deck {
    position: relative;
    touch-action: pan-y;
    transition: transform 160ms ease-out;
  }

  .deck.dragging {
    transition: none;
    cursor: grabbing;
  }

  .swipe-hint {
    position: absolute;
    top: 14px;
    z-index: 2;
    padding: 4px 14px;
    border: 3px solid currentColor;
    border-radius: 8px;
    font-size: 20px;
    font-weight: 900;
    text-transform: uppercase;
    pointer-events: none;
  }

  .swipe-hint.nope {
    right: 18px;
    color: var(--smrt-color-error);
    transform: rotate(12deg);
  }

  .swipe-hint.dig {
    left: 18px;
    color: var(--smrt-color-primary);
    transform: rotate(-12deg);
  }

  .empty {
    display: grid;
    gap: 8px;
    justify-items: start;
    padding: 24px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 10px;
    background: var(--smrt-color-surface);
  }

  .empty h2 {
    margin: 0;
    font: var(--smrt-typography-title-large-font);
  }

  .empty p,
  .muted {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 13px;
  }

  .empty a {
    color: var(--smrt-color-primary);
    font-weight: 800;
  }




  .empty-actions {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .empty-actions .primary {
    min-height: 34px;
    padding: 0 16px;
    border: 1px solid var(--smrt-color-primary);
    border-radius: 8px;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: inherit;
    font-weight: 800;
    cursor: pointer;
  }

  .deck-actions {
    display: flex;
    flex: 1;
    align-items: flex-end;
    justify-content: center;
    gap: clamp(20px, 8vw, 64px);
  }




  .slot {
    display: grid;
    justify-items: center;
    gap: 2px;
  }

  .orb {
    display: grid;
    place-items: center;
    width: 68px;
    height: 68px;
    border: 2px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
    transition: transform 120ms ease-out;
  }

  .orb.later {
    width: 48px;
    height: 48px;
  }

  .orb.nope {
    border-color: var(--smrt-color-error);
    color: var(--smrt-color-error);
  }

  .orb.dig {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .orb:not(:disabled):hover,
  .orb:not(:disabled):focus-visible {
    transform: scale(1.08);
  }

  .orb:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .orb-label {
    color: var(--smrt-color-on-surface);
    font-size: 12px;
    font-weight: 800;
  }

  .orb-hint {
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
  }

  /*
   * `Modal` intentionally has no component class hook. Keep the full-bleed
   * treatment scoped to this deck's wrapper, so other full dialogs retain
   * their desktop-sized presentation.
   *
   * The short, coarse-pointer branch catches phone landscape without changing
   * a desktop's 1280 × 800 dialog.
   */
  @media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
    .triage-shell :global(.modal.modal--full) {
      align-items: stretch;
      justify-content: stretch;
      height: 100vh;
      height: 100dvh;
    }

    .triage-shell :global(.modal--full .modal__container) {
      width: 100vw;
      height: 100vh;
      height: 100dvh;
      max-width: 100vw;
      max-height: 100dvh;
      border-radius: 0;
      box-shadow: none;
    }

    .triage-shell :global(.modal--full .modal__body) {
      min-height: 0;
      padding:
        12px
        max(12px, env(safe-area-inset-right))
        12px
        max(12px, env(safe-area-inset-left));
      overscroll-behavior: contain;
    }

    .triage-shell :global(.modal--full .modal__footer) {
      padding:
        8px
        max(12px, env(safe-area-inset-right))
        max(12px, env(safe-area-inset-bottom))
        max(12px, env(safe-area-inset-left));
    }

    .deck-head {
      gap: 8px;
      padding:
        max(8px, env(safe-area-inset-top))
        max(12px, env(safe-area-inset-right))
        8px
        max(12px, env(safe-area-inset-left));
    }

    .close {
      min-height: 44px;
    }

    .close {
      padding: 0 10px;
    }

    .feedback,
    .deep-dive {
      margin-bottom: 8px;
    }

    .deck-actions {
      gap: clamp(16px, 10vw, 48px);
    }

    .orb {
      width: 56px;
      height: 56px;
    }

    .orb.later {
      width: 44px;
      height: 44px;
    }

    .orb-hint {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .deck,
    .orb {
      transition: none;
    }

    .orb:not(:disabled):hover,
    .orb:not(:disabled):focus-visible {
      transform: none;
    }
  }
</style>
