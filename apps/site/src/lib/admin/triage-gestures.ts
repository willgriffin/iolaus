/**
 * Swipe geometry for the one-at-a-time triage deck (issue #425).
 *
 * Pure functions of the drag offsets, so the whole policy — how far is far
 * enough, what counts as horizontal rather than a scroll, how far the card
 * tilts on the way — is unit-testable without a pointer, a card, or a DOM. The
 * view keeps only the pointer wiring.
 *
 * Swipes are a convenience: the buttons and the keyboard remain the primary
 * path, and both are unaffected by everything here.
 */

/** Horizontal travel, in CSS pixels, that commits a swipe. */
export const TRIAGE_SWIPE_THRESHOLD_PX = 110;

/**
 * A drag shorter than this is a tap, not a swipe. Below it the card does not
 * even tilt, so a click on the card never wobbles it.
 */
export const TRIAGE_SWIPE_MIN_TRAVEL_PX = 8;

/**
 * How much more horizontal than vertical the travel must be to count as a
 * swipe. A mostly-vertical drag is the operator scrolling the posting.
 */
export const TRIAGE_SWIPE_DOMINANCE = 1.5;

/** Tilt, in degrees, at (and past) the commit threshold. */
export const TRIAGE_SWIPE_MAX_TILT_DEG = 9;

export interface TriageDrag {
  /** Horizontal travel from the pointer-down origin; right is positive. */
  dx: number;
  /** Vertical travel from the pointer-down origin; down is positive. */
  dy: number;
}

/** The verdict a drag would commit, or `null` while it commits nothing. */
export type TriageSwipeVerdict = 'digDeeper' | 'reject';

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * True while a drag is horizontal enough to be a swipe rather than a scroll.
 * A drag with no vertical travel at all is horizontal by definition.
 */
export function isHorizontalTriageDrag(drag: TriageDrag): boolean {
  const dx = Math.abs(finite(drag.dx));
  const dy = Math.abs(finite(drag.dy));
  if (dx < TRIAGE_SWIPE_MIN_TRAVEL_PX) return false;
  return dy === 0 || dx >= dy * TRIAGE_SWIPE_DOMINANCE;
}

/**
 * The verdict a released drag commits: right is "dig deeper", left is "nope",
 * and anything short of the threshold — or not horizontal enough — is `null`,
 * which the view treats as "snap the card back and record nothing".
 */
export function triageSwipeVerdict(
  drag: TriageDrag,
  threshold: number = TRIAGE_SWIPE_THRESHOLD_PX,
): TriageSwipeVerdict | null {
  if (!isHorizontalTriageDrag(drag)) return null;
  const dx = finite(drag.dx);
  const limit = Math.max(1, Math.abs(finite(threshold)));
  if (Math.abs(dx) < limit) return null;
  return dx > 0 ? 'digDeeper' : 'reject';
}

/**
 * The verdict a *released* drag commits.
 *
 * A left-button drag across the card's copy is a native text selection as much
 * as it is a swipe, and the pointer alone cannot tell them apart: the same
 * 110px that arms a verdict selects a line of the fit panel or a row of the
 * facts. A drag that left a selection behind is the operator reading the card,
 * not deciding on it, so it commits nothing — the swipe stays available
 * everywhere the drag selected no text.
 */
export function triageReleaseVerdict(
  drag: TriageDrag,
  options: { selectedText: boolean; threshold?: number },
): TriageSwipeVerdict | null {
  if (options.selectedText) return null;
  return triageSwipeVerdict(drag, options.threshold);
}

/**
 * Signed commit progress in `[-1, 1]`: how close the drag in hand is to
 * committing, and in which direction. The view fades the matching hint in with
 * it, so the operator can see the verdict arm before letting go.
 */
export function triageSwipeProgress(
  drag: TriageDrag,
  threshold: number = TRIAGE_SWIPE_THRESHOLD_PX,
): number {
  if (!isHorizontalTriageDrag(drag)) return 0;
  const limit = Math.max(1, Math.abs(finite(threshold)));
  const ratio = finite(drag.dx) / limit;
  return Math.max(-1, Math.min(1, ratio));
}

export interface TriageDragTransform {
  /** Degrees of tilt; `0` under reduced motion. */
  rotate: number;
  /** Horizontal offset to paint; `0` under reduced motion. */
  translate: number;
}

/**
 * How to paint a drag in progress. `reducedMotion` flattens the card
 * completely — the swipe still commits, it just does not move — because the
 * motion is decoration and the verdict is not.
 */
export function triageDragTransform(
  drag: TriageDrag,
  options: {
    maxTilt?: number;
    reducedMotion?: boolean;
    threshold?: number;
  } = {},
): TriageDragTransform {
  const still = { rotate: 0, translate: 0 };
  if (options.reducedMotion) return still;
  if (!isHorizontalTriageDrag(drag)) return still;
  const maxTilt = Math.abs(
    finite(options.maxTilt ?? TRIAGE_SWIPE_MAX_TILT_DEG),
  );
  return {
    rotate: triageSwipeProgress(drag, options.threshold) * maxTilt,
    translate: finite(drag.dx),
  };
}
