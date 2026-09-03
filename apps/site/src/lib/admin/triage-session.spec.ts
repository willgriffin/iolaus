import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIAGE_SORT,
  isTriageDeepLink,
  normalizeTriageSort,
  TRIAGE_DIG_DEEPER_RATING,
  TRIAGE_PREFETCH_SIZE,
  TRIAGE_REJECT_RATING,
  TRIAGE_SORT_LABELS,
  TRIAGE_SORTS,
  triageCloseHref,
  triageDeckAcceptsKeys,
  triageDeckShowsEmpty,
  triageRefillOffset,
  triageRefillOutcome,
  triageSessionKey,
  triageVerdictRating,
} from './triage-session';

describe('triage verdict ratings', () => {
  it('writes a low rating for a nope and a high one for a dig deeper', () => {
    // A verdict is a rating in everything but name; leaving the column empty
    // throws away the signal the shortlist and every later pass sort by.
    expect(triageVerdictRating(null, 'reject')).toBe(TRIAGE_REJECT_RATING);
    expect(triageVerdictRating(null, 'digDeeper')).toBe(
      TRIAGE_DIG_DEEPER_RATING,
    );
    expect(TRIAGE_REJECT_RATING).toBe(2);
    expect(TRIAGE_DIG_DEEPER_RATING).toBe(8);
  });

  it('never overwrites a rating the owner set', () => {
    // The star row is a finer judgement than a button press, and it writes to
    // the same column before the verdict does.
    expect(triageVerdictRating(9, 'reject')).toBe(9);
    expect(triageVerdictRating(1, 'digDeeper')).toBe(1);
    // Zero is a rating too, not an absence.
    expect(triageVerdictRating(0, 'reject')).toBe(0);
  });

  it('falls back for a rating that is not a usable number', () => {
    expect(triageVerdictRating(Number.NaN, 'digDeeper')).toBe(
      TRIAGE_DIG_DEEPER_RATING,
    );
  });
});

describe('triage sort', () => {
  it('offers match and recency, and defaults to match', () => {
    expect(TRIAGE_SORTS).toEqual(['score', 'newest']);
    expect(DEFAULT_TRIAGE_SORT).toBe('score');
    expect(TRIAGE_SORT_LABELS.score).toBe('Match %');
    expect(TRIAGE_SORT_LABELS.newest).toBe('Newest');
  });

  it('coerces anything else — including the list own sorts — back to match', () => {
    expect(normalizeTriageSort('newest')).toBe('newest');
    expect(normalizeTriageSort('salary')).toBe('score');
    expect(normalizeTriageSort('best')).toBe('score');
    expect(normalizeTriageSort(undefined)).toBe('score');
  });
});

describe('triage deep link', () => {
  it('opens the deck for ?triage=1 and nothing else', () => {
    expect(isTriageDeepLink(new URLSearchParams('triage=1&skill=Rust'))).toBe(
      true,
    );
    expect(isTriageDeepLink(new URLSearchParams('skill=Rust'))).toBe(false);
    expect(isTriageDeepLink(new URLSearchParams('triage=0'))).toBe(false);
    expect(isTriageDeepLink(new URLSearchParams('triage=yes'))).toBe(false);
  });

  it('closes a deep-linked session by dropping the deck parameters and keeping the filter', () => {
    expect(
      triageCloseHref(
        new URL(
          'http://localhost/admin/opportunities?triage=1&triageSort=newest&skill=Rust',
        ),
      ),
    ).toBe('/admin/opportunities?skill=Rust');
  });

  it('has nowhere to navigate for a session opened from the toolbar', () => {
    // Nothing was written to the URL, so the list is refreshed in place.
    expect(
      triageCloseHref(
        new URL('http://localhost/admin/opportunities?skill=Rust'),
      ),
    ).toBeNull();
  });
});

describe('triage deck keyboard scope', () => {
  it('is inert while the dialog is closed, and live while it is open', () => {
    // The list underneath owns the keyboard: a stray `x` on the list must not
    // reject whatever the deck last had in hand.
    expect(triageDeckAcceptsKeys({ open: false })).toBe(false);
    expect(triageDeckAcceptsKeys({ open: true })).toBe(true);
  });
});

describe('triage refill offset', () => {
  it('steps past the rows passed on and the verdicts still in the air', () => {
    // The advance is optimistic, so a card leaves the deck before its write
    // commits and the server still serves it at the front of the undecided
    // queue. Reading from `skipped` alone re-reads the window just decided.
    expect(triageRefillOffset(0, 0)).toBe(0);
    expect(triageRefillOffset(3, 0)).toBe(3);
    expect(triageRefillOffset(0, 5)).toBe(5);
    expect(triageRefillOffset(3, 2)).toBe(5);
  });

  it('never reads behind the start of the queue', () => {
    expect(triageRefillOffset(-1, -1)).toBe(0);
  });
});

describe('triage refill outcome', () => {
  it('ends the queue on a short window with nothing in flight', () => {
    expect(
      triageRefillOutcome({ fresh: 2, limit: 5, pending: 0, received: 2 }),
    ).toEqual({ atEnd: true, retryAfterWrites: false });
  });

  it('keeps going while a full window comes back', () => {
    expect(
      triageRefillOutcome({ fresh: 5, limit: 5, pending: 0, received: 5 }),
    ).toEqual({ atEnd: false, retryAfterWrites: false });
  });

  it('does not call a short window the end while writes are in flight', () => {
    // An offset that stepped past uncommitted rows can overshoot rows this
    // session has not seen, and `atEnd` never goes false again.
    expect(
      triageRefillOutcome({ fresh: 1, limit: 5, pending: 4, received: 1 }),
    ).toEqual({ atEnd: false, retryAfterWrites: false });
  });

  it('retries a window that came back entirely already-served', () => {
    // The read raced its own decisions: that is not an empty backlog, and
    // reporting "nothing left to look at" here would strand the session.
    expect(
      triageRefillOutcome({ fresh: 0, limit: 5, pending: 5, received: 5 }),
    ).toEqual({ atEnd: false, retryAfterWrites: true });
  });

  it('does not retry once nothing is in flight to wait for', () => {
    expect(
      triageRefillOutcome({ fresh: 0, limit: 5, pending: 0, received: 5 }),
    ).toEqual({ atEnd: false, retryAfterWrites: false });
    expect(
      triageRefillOutcome({ fresh: 0, limit: 5, pending: 0, received: 0 }),
    ).toEqual({ atEnd: true, retryAfterWrites: false });
  });
});

describe('triage empty panel', () => {
  it('says nothing is left only when the queue actually came back empty', () => {
    expect(
      triageDeckShowsEmpty({ hasCard: false, loadError: '', loading: false }),
    ).toBe(true);
  });

  it('never reports an empty queue for a read that failed', () => {
    // Otherwise the deck asserts the backlog is both unreachable and finished.
    expect(
      triageDeckShowsEmpty({
        hasCard: false,
        loadError: 'The triage queue could not be loaded.',
        loading: false,
      }),
    ).toBe(false);
  });

  it('waits for the read in flight before claiming anything', () => {
    expect(
      triageDeckShowsEmpty({ hasCard: false, loadError: '', loading: true }),
    ).toBe(false);
    expect(
      triageDeckShowsEmpty({ hasCard: true, loadError: '', loading: false }),
    ).toBe(false);
  });
});

describe('triageSessionKey', () => {
  const base = {
    open: true,
    search: 'skill=Rust',
    sort: 'score' as const,
    sortReady: true,
  };

  it('names no session until the stored ordering has been read', () => {
    // No key, no session, no `?/triageQueue` read: the deck never fetches a
    // window for an ordering the chooser does not yet show (#452).
    expect(triageSessionKey({ ...base, sortReady: false })).toBeNull();
  });

  it('opens with exactly one session when the stored order is the default', () => {
    // The read happens once the preference is in hand. A stored preference
    // equal to the default produces the same key, so nothing restarts and the
    // first read is the only read.
    const first = triageSessionKey(base);
    const afterDefaultPreference = triageSessionKey({
      ...base,
      sort: DEFAULT_TRIAGE_SORT,
    });

    expect(first).not.toBeNull();
    expect(afterDefaultPreference).toBe(first);
  });

  it('restarts on a different remembered ordering, filter, or open', () => {
    const first = triageSessionKey(base);

    expect(triageSessionKey({ ...base, sort: 'newest' })).not.toBe(first);
    expect(triageSessionKey({ ...base, search: 'skill=Go' })).not.toBe(first);
    expect(triageSessionKey({ ...base, open: false })).not.toBe(first);
  });
});

describe('TRIAGE_PREFETCH_SIZE', () => {
  it('asks for three cards, the size the server serves', async () => {
    const { TRIAGE_QUEUE_SIZE } = await import(
      '../server/opportunity-triage.js'
    );

    expect(TRIAGE_PREFETCH_SIZE).toBe(3);
    // The action clamps the requested limit to the server's window, and the
    // refill reads a short window as end-of-queue, so asking for more than the
    // server serves would end every session after its first window.
    expect(TRIAGE_PREFETCH_SIZE).toBeLessThanOrEqual(TRIAGE_QUEUE_SIZE);
  });
});
