/**
 * Keyboard mapping for the one-at-a-time opportunity triage view (issue #425).
 *
 * This is a pure function of the event shape so the policy — which keys act,
 * and when a keystroke belongs to the operator's typing rather than to triage
 * — is unit-testable without a DOM, and the view keeps only the wiring.
 */

/**
 * The deck has three verdicts and three utilities. There is no `apply`: triage
 * decides what deserves a deeper look, and an application is started from the
 * shortlist or the opportunity's own record page.
 */
export type TriageShortcutAction =
  | 'digDeeper'
  | 'open'
  | 'reject'
  | 'skip'
  | 'undo'
  | 'verify';

/** The subset of `KeyboardEvent` the mapper reads. */
export interface TriageKeyEvent {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  target?: EventTarget | null;
}

/**
 * Documented mapping, also rendered as the view's on-screen legend. The three
 * verdicts come first and in deck order — left, middle, right — so the legend
 * reads in the same order as the buttons under the card.
 */
export const TRIAGE_SHORTCUTS = [
  { action: 'reject', hint: '← / h / x', label: 'Nope' },
  { action: 'skip', hint: 'space / s', label: 'Later' },
  { action: 'digDeeper', hint: '→ / l / d', label: 'Dig deeper' },
  { action: 'undo', hint: 'z', label: 'Undo' },
  { action: 'verify', hint: 'v', label: 'Verify posting' },
  { action: 'open', hint: 'o', label: 'Open posting' },
] as const satisfies readonly {
  action: TriageShortcutAction;
  hint: string;
  label: string;
}[];

const KEY_ACTIONS = new Map<string, TriageShortcutAction>([
  ['arrowleft', 'reject'],
  ['h', 'reject'],
  ['x', 'reject'],
  ['arrowright', 'digDeeper'],
  ['l', 'digDeeper'],
  ['d', 'digDeeper'],
  [' ', 'skip'],
  ['spacebar', 'skip'],
  ['s', 'skip'],
  ['z', 'undo'],
  ['v', 'verify'],
  ['o', 'open'],
]);

const EDITABLE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
/** Controls the browser activates with Space or Enter. */
const ACTIVATABLE_TAGS = new Set(['A', 'BUTTON', 'SUMMARY']);
const ACTIVATABLE_ROLES = new Set(['button', 'link', 'menuitem']);
const ACTIVATION_KEYS = new Set([' ', 'spacebar', 'enter']);
const EDITABLE_ROLES = new Set([
  'combobox',
  'searchbox',
  'spinbutton',
  'textbox',
]);

function tagOf(target: EventTarget | null): string {
  if (!target || typeof target !== 'object') return '';
  const { tagName } = target as { tagName?: string };
  return typeof tagName === 'string' ? tagName.toUpperCase() : '';
}

function roleOf(target: EventTarget | null): string {
  if (!target || typeof target !== 'object') return '';
  const element = target as { getAttribute?: (name: string) => string | null };
  const role = element.getAttribute?.('role');
  return typeof role === 'string' ? role.toLowerCase() : '';
}

/**
 * True when the keystroke is being typed into a control — the rating field,
 * review notes, the preflight-override reason. Triage must never steal those
 * keys, and a decision must never be triggered by typing a note.
 */
export function isEditableTriageTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const { isContentEditable } = target as { isContentEditable?: boolean };
  if (isContentEditable === true) return true;
  if (EDITABLE_TAGS.has(tagOf(target))) return true;
  return EDITABLE_ROLES.has(roleOf(target));
}

/**
 * True when the keystroke is the one the focused control activates with.
 *
 * Clicking a triage button leaves it focused, so a following Space is the
 * operator re-pressing that button — not a Skip. Only the activation keys
 * stand down: the letter and arrow shortcuts have no meaning to a button, and
 * stealing them back would strand the keyboard flow after every mouse click.
 */
export function isTriageActivationKey(
  key: string,
  target: EventTarget | null,
): boolean {
  if (!ACTIVATION_KEYS.has(key.toLowerCase())) return false;
  return (
    ACTIVATABLE_TAGS.has(tagOf(target)) || ACTIVATABLE_ROLES.has(roleOf(target))
  );
}

/**
 * The triage action a keystroke requests, or `null` when triage should not
 * handle it. Modified chords (browser and OS shortcuts), auto-repeat, and
 * keystrokes aimed at an editable control are all deliberately ignored;
 * `Shift` alone is ignored too, so a shifted letter is not a decision.
 */
export function triageShortcutFor(
  event: TriageKeyEvent,
): TriageShortcutAction | null {
  if (event.repeat) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (isEditableTriageTarget(event.target ?? null)) return null;
  if (typeof event.key !== 'string' || event.key === '') return null;
  if (isTriageActivationKey(event.key, event.target ?? null)) return null;
  return KEY_ACTIONS.get(event.key.toLowerCase()) ?? null;
}
