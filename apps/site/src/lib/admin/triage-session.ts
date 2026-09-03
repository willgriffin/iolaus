/**
 * Triage session policy (issue #425).
 *
 * Triage is for working through *unseen* opportunities quickly, at low
 * commitment: one keystroke per card, no confirmations, and no scorekeeping.
 * The deck deliberately shows the operator **no counts** — not a position, not
 * a remaining total, not a session tally. A backlog in the thousands is
 * discouraging as a number and useless as a decision input: the only thing that
 * matters is the card in hand. The queue still prefetches and refills; it
 * simply never says so.
 *
 * Everything here is pure, so the policy is unit-testable and the view keeps
 * only the wiring.
 */

/**
 * Cards fetched per refill, and the low-water mark that triggers one.
 *
 * Three, not five (issue #452). The deck shows one card at a time and refills
 * once fewer than two are in hand, so the fourth and fifth cards of a window
 * buy a little extra runway and are paid for on the first paint — the one read
 * the operator actually waits on. This must not exceed the server's
 * `TRIAGE_QUEUE_SIZE`: the action clamps to it, and a clamped window would
 * read as a short window, which the refill treats as end-of-queue.
 */
export const TRIAGE_PREFETCH_SIZE = 3;
export const TRIAGE_PREFETCH_THRESHOLD = 2;

/**
 * The rating each verdict records when the operator has not set one.
 *
 * A verdict is a rating in everything but name, and leaving the column empty
 * throws that signal away: the shortlist sorts by it, and so does every later
 * pass over the backlog. So Nope writes a low one and Dig deeper a high one —
 * but only ever as a *default*. A rating the owner set by hand is a finer
 * judgement than a button press and always wins; Later records nothing at all,
 * because passing on a card is not an opinion about it.
 */
export const TRIAGE_REJECT_RATING = 2;
export const TRIAGE_DIG_DEEPER_RATING = 8;

/**
 * The rating to post for a verdict, given the rating the card already carries.
 *
 * `existing` is the value from the record — which the star row writes to before
 * the verdict does, so a rating set in this session counts as the owner's.
 */
export function triageVerdictRating(
  existing: number | null,
  verdict: 'digDeeper' | 'reject',
): number {
  if (existing !== null && Number.isFinite(existing)) return existing;
  return verdict === 'reject' ? TRIAGE_REJECT_RATING : TRIAGE_DIG_DEEPER_RATING;
}

/**
 * Where the next window of the queue starts.
 *
 * The server queue is every *undecided* row, and the advance is optimistic: a
 * card leaves the deck before its write commits, so until it does the server
 * still counts it as undecided and still serves it at the front. `skipped`
 * steps past the rows the operator passed on; `pending` steps past the rows
 * whose verdict is still in the air. Without the second term a deck emptied
 * faster than its writes commit re-reads the window it just decided, filters
 * every row out as already served, and strands itself on an empty queue.
 */
export function triageRefillOffset(skipped: number, pending: number): number {
  return Math.max(0, skipped) + Math.max(0, pending);
}

/** One window of the queue, as the deck received it. */
export interface TriageRefillWindow {
  /** Rows this session had not served before, out of `received`. */
  fresh: number;
  /** Rows the read asked for. */
  limit: number;
  /** Optimistic writes still in flight when the read was issued. */
  pending: number;
  /** Rows the window came back with, before already-served rows are dropped. */
  received: number;
}

export interface TriageRefillOutcome {
  /** The queue has nothing further for this session; stop prefetching. */
  atEnd: boolean;
  /** Nothing usable came back yet: ask again once the writes in flight land. */
  retryAfterWrites: boolean;
}

/**
 * What one window means for the session.
 *
 * A short window is only the end of the queue when nothing is still in flight:
 * an offset that stepped past uncommitted rows can overshoot rows this session
 * has not seen, and `atEnd` never goes false again. And a window that came back
 * entirely already-served while writes were in the air is not an empty backlog
 * — it is a read that raced its own decisions, so the deck asks once more once
 * those decisions have landed rather than reporting nothing left to look at.
 */
export function triageRefillOutcome(
  window: TriageRefillWindow,
): TriageRefillOutcome {
  const atEnd = window.pending === 0 && window.received < window.limit;
  return {
    atEnd,
    retryAfterWrites: !atEnd && window.fresh === 0 && window.pending > 0,
  };
}

/**
 * Whether the deck may say "Nothing left to look at".
 *
 * That sentence is a claim about the backlog, and a read that failed says
 * nothing about it: rendering the empty panel beside a load error asserts the
 * queue is both broken and finished. A failure stays a failure, with a retry.
 */
export function triageDeckShowsEmpty(state: {
  hasCard: boolean;
  loadError: string;
  loading: boolean;
}): boolean {
  return !state.loading && !state.hasCard && state.loadError === '';
}

/**
 * How the deck orders the queue: best match first, or most recently posted
 * first. Two choices and no more — this is a chooser above a card, not the
 * list's full sort menu — and both map onto sorts the shared filter model
 * already supports.
 */
export const TRIAGE_SORTS = ['score', 'newest'] as const;

export type TriageSort = (typeof TRIAGE_SORTS)[number];

export const DEFAULT_TRIAGE_SORT: TriageSort = 'score';

/** Operator-facing labels for the header's segmented control. */
export const TRIAGE_SORT_LABELS: Record<TriageSort, string> = {
  newest: 'Newest',
  score: 'Match %',
};

/** Where the viewer's last sort choice is remembered. */
export const TRIAGE_SORT_STORAGE_KEY = 'iolaus.admin.triage.sort';

/** Deep-link parameter for the deck's ordering. */
export const TRIAGE_SORT_URL_PARAM = 'triageSort';

/** Coerce a stored, deep-linked, or inherited sort onto the two offered. */
export function normalizeTriageSort(value: unknown): TriageSort {
  return (
    TRIAGE_SORTS.find((offered) => offered === value) ?? DEFAULT_TRIAGE_SORT
  );
}

/** Deep link that opens the triage deck over the opportunity list. */
/**
 * The session a queue read belongs to, or `null` while the deck may not read.
 *
 * Open, filter and ordering are the session boundary: a change to any of them
 * is a new deck, and the cards in hand were chosen by the old one.
 *
 * `sortReady` is what makes the first read the only read (issue #452). The
 * remembered ordering lives in `localStorage`, which does not exist until the
 * component has hydrated; a deck that started a session against the default
 * and restarted it a tick later issued two `?/triageQueue` reads on every
 * open — the second one even when the stored preference *was* the default, and
 * on production the operator waited through both. Returning `null` until the
 * preference has been read means no window is ever fetched for an ordering the
 * chooser does not yet show.
 */
export function triageSessionKey(options: {
  open: boolean;
  search: string;
  sort: TriageSort;
  sortReady: boolean;
}): string | null {
  if (!options.sortReady) return null;
  return `${options.open}:${options.search}:${options.sort}`;
}

export const TRIAGE_URL_PARAM = 'triage';

/**
 * Whether a list URL asks for the deck to be open.
 *
 * `/admin/opportunities?triage=1[&triageSort=newest][&filters]` is the deep
 * link, and the redirect from the retired standalone route lands on it, so a
 * bookmark still opens the deck over the list it belongs to.
 */
export function isTriageDeepLink(params: URLSearchParams): boolean {
  return params.get(TRIAGE_URL_PARAM) === '1';
}

/**
 * Where closing the deck leaves the operator.
 *
 * A deep-linked session has `?triage=1` in the URL: dropping it (and the
 * ordering that rode with it) re-runs the route, which refreshes the list as a
 * side effect. A session opened from the toolbar never touched the URL, so
 * there is nothing to navigate to and the list is refreshed in place
 * instead — `null` says so.
 */
export function triageCloseHref(url: URL): string | null {
  if (!url.searchParams.has(TRIAGE_URL_PARAM)) return null;
  const next = new URL(url);
  next.searchParams.delete(TRIAGE_URL_PARAM);
  next.searchParams.delete(TRIAGE_SORT_URL_PARAM);
  return `${next.pathname}${next.search}`;
}

/**
 * Whether the deck's keyboard shortcuts are live.
 *
 * They belong to the deck alone: while the dialog is closed, the list
 * underneath owns the keyboard.
 */
export function triageDeckAcceptsKeys(state: { open: boolean }): boolean {
  return state.open;
}
