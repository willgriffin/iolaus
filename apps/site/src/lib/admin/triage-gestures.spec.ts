import { describe, expect, it } from 'vitest';
import {
  isHorizontalTriageDrag,
  TRIAGE_SWIPE_MAX_TILT_DEG,
  TRIAGE_SWIPE_MIN_TRAVEL_PX,
  TRIAGE_SWIPE_THRESHOLD_PX,
  triageDragTransform,
  triageReleaseVerdict,
  triageSwipeProgress,
  triageSwipeVerdict,
} from './triage-gestures';

describe('triageSwipeVerdict', () => {
  it('commits dig deeper to the right and nope to the left', () => {
    expect(triageSwipeVerdict({ dx: TRIAGE_SWIPE_THRESHOLD_PX, dy: 0 })).toBe(
      'digDeeper',
    );
    expect(triageSwipeVerdict({ dx: -TRIAGE_SWIPE_THRESHOLD_PX, dy: 0 })).toBe(
      'reject',
    );
  });

  it('commits nothing short of the threshold', () => {
    // A short drag is a mis-grab, not a verdict: the card snaps back.
    expect(
      triageSwipeVerdict({ dx: TRIAGE_SWIPE_THRESHOLD_PX - 1, dy: 0 }),
    ).toBeNull();
    expect(triageSwipeVerdict({ dx: 0, dy: 0 })).toBeNull();
  });

  it('commits nothing for a drag that is really a scroll', () => {
    // Reading the posting on a touch screen drags vertically; that must never
    // decide the card.
    expect(triageSwipeVerdict({ dx: 200, dy: 400 })).toBeNull();
    expect(triageSwipeVerdict({ dx: 0, dy: 600 })).toBeNull();
  });

  it('honours a caller-supplied threshold', () => {
    expect(triageSwipeVerdict({ dx: 40, dy: 0 }, 30)).toBe('digDeeper');
    expect(triageSwipeVerdict({ dx: 40, dy: 0 }, 300)).toBeNull();
  });

  it('tolerates a non-finite offset instead of committing a verdict', () => {
    expect(triageSwipeVerdict({ dx: Number.NaN, dy: 0 })).toBeNull();
    expect(
      triageSwipeVerdict({ dx: Number.POSITIVE_INFINITY, dy: 0 }),
    ).toBeNull();
  });
});

describe('isHorizontalTriageDrag', () => {
  it('ignores travel below the tap threshold so a click never wobbles', () => {
    expect(
      isHorizontalTriageDrag({ dx: TRIAGE_SWIPE_MIN_TRAVEL_PX - 1, dy: 0 }),
    ).toBe(false);
  });

  it('accepts a drag that is dominantly horizontal', () => {
    expect(isHorizontalTriageDrag({ dx: 60, dy: 10 })).toBe(true);
    expect(isHorizontalTriageDrag({ dx: 60, dy: 55 })).toBe(false);
  });
});

describe('triageSwipeProgress', () => {
  it('reports signed progress clamped to the unit range', () => {
    expect(
      triageSwipeProgress({ dx: TRIAGE_SWIPE_THRESHOLD_PX / 2, dy: 0 }),
    ).toBeCloseTo(0.5);
    expect(
      triageSwipeProgress({ dx: TRIAGE_SWIPE_THRESHOLD_PX * 4, dy: 0 }),
    ).toBe(1);
    expect(
      triageSwipeProgress({ dx: -TRIAGE_SWIPE_THRESHOLD_PX * 4, dy: 0 }),
    ).toBe(-1);
  });

  it('reports no progress for a vertical drag', () => {
    expect(triageSwipeProgress({ dx: 10, dy: 300 })).toBe(0);
  });
});

describe('triageDragTransform', () => {
  it('tilts toward the armed verdict, up to the maximum', () => {
    const { rotate, translate } = triageDragTransform({
      dx: TRIAGE_SWIPE_THRESHOLD_PX,
      dy: 0,
    });

    expect(rotate).toBeCloseTo(TRIAGE_SWIPE_MAX_TILT_DEG);
    expect(translate).toBe(TRIAGE_SWIPE_THRESHOLD_PX);
  });

  it('keeps the card still under prefers-reduced-motion', () => {
    // The motion is decoration; the verdict is not, so the swipe still
    // commits — it just does not move the card.
    expect(
      triageDragTransform(
        { dx: TRIAGE_SWIPE_THRESHOLD_PX, dy: 0 },
        { reducedMotion: true },
      ),
    ).toEqual({ rotate: 0, translate: 0 });
    expect(triageSwipeVerdict({ dx: TRIAGE_SWIPE_THRESHOLD_PX, dy: 0 })).toBe(
      'digDeeper',
    );
  });

  it('keeps the card still for a drag it would not commit', () => {
    expect(triageDragTransform({ dx: 2, dy: 0 })).toEqual({
      rotate: 0,
      translate: 0,
    });
    expect(triageDragTransform({ dx: 20, dy: 300 })).toEqual({
      rotate: 0,
      translate: 0,
    });
  });

  it('leaves no tilt behind when a drag is cancelled rather than released', () => {
    // `pointercancel`, a lost pointer capture, and the dialog closing all reset
    // the drag to nothing. The card must sit square again, and the cancelled
    // drag must not read as a verdict.
    expect(triageDragTransform({ dx: 0, dy: 0 })).toEqual({
      rotate: 0,
      translate: 0,
    });
    expect(triageSwipeVerdict({ dx: 0, dy: 0 })).toBeNull();
    expect(triageSwipeProgress({ dx: 0, dy: 0 })).toBe(0);
  });
});

describe('triage release verdict', () => {
  it('commits the swipe when the drag selected no text', () => {
    expect(
      triageReleaseVerdict(
        { dx: TRIAGE_SWIPE_THRESHOLD_PX + 20, dy: 4 },
        { selectedText: false },
      ),
    ).toBe('digDeeper');
    expect(
      triageReleaseVerdict(
        { dx: -(TRIAGE_SWIPE_THRESHOLD_PX + 20), dy: 4 },
        { selectedText: false },
      ),
    ).toBe('reject');
  });

  it('commits nothing when the drag left a text selection behind', () => {
    // Dragging across the fit copy or the facts is a native selection; the same
    // travel that arms a verdict selects a line, and the pointer cannot tell
    // the two apart. Reading the card must never record a decision on it.
    expect(
      triageReleaseVerdict(
        { dx: TRIAGE_SWIPE_THRESHOLD_PX + 20, dy: 4 },
        { selectedText: true },
      ),
    ).toBeNull();
    expect(
      triageReleaseVerdict(
        { dx: -(TRIAGE_SWIPE_THRESHOLD_PX + 20), dy: 4 },
        { selectedText: true },
      ),
    ).toBeNull();
  });

  it('still refuses a short or vertical drag that selected nothing', () => {
    expect(
      triageReleaseVerdict({ dx: 12, dy: 2 }, { selectedText: false }),
    ).toBeNull();
    expect(
      triageReleaseVerdict(
        { dx: TRIAGE_SWIPE_THRESHOLD_PX + 20, dy: 400 },
        { selectedText: false },
      ),
    ).toBeNull();
  });
});
