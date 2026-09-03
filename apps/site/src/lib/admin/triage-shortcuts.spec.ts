import { describe, expect, it } from 'vitest';
import {
  isEditableTriageTarget,
  TRIAGE_SHORTCUTS,
  triageShortcutFor,
} from './triage-shortcuts';

function element(
  tagName: string,
  attributes: Record<string, string> = {},
  isContentEditable = false,
) {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    isContentEditable,
    tagName,
  } as unknown as EventTarget;
}

describe('triageShortcutFor', () => {
  it('maps the documented nope, later, dig-deeper, and utility keys', () => {
    const cases: [string, string][] = [
      ['ArrowLeft', 'reject'],
      ['h', 'reject'],
      ['x', 'reject'],
      ['ArrowRight', 'digDeeper'],
      ['l', 'digDeeper'],
      ['d', 'digDeeper'],
      [' ', 'skip'],
      ['Spacebar', 'skip'],
      ['s', 'skip'],
      ['z', 'undo'],
      ['v', 'verify'],
      ['o', 'open'],
    ];
    for (const [key, action] of cases) {
      expect(triageShortcutFor({ key })).toBe(action);
    }
  });

  it('leaves the retired apply keys unmapped', () => {
    // Apply is not reachable from triage any more; ↓/j must not resurrect it
    // as some other verdict by accident.
    expect(triageShortcutFor({ key: 'ArrowDown' })).toBeNull();
    expect(triageShortcutFor({ key: 'j' })).toBeNull();
  });

  it('accepts upper-case letters from a caps-locked keyboard', () => {
    expect(triageShortcutFor({ key: 'H' })).toBe('reject');
    expect(triageShortcutFor({ key: 'Z' })).toBe('undo');
  });

  it('ignores unmapped keys', () => {
    expect(triageShortcutFor({ key: 'ArrowUp' })).toBeNull();
    expect(triageShortcutFor({ key: 'Enter' })).toBeNull();
    expect(triageShortcutFor({ key: 'k' })).toBeNull();
    expect(triageShortcutFor({ key: 'q' })).toBeNull();
    expect(triageShortcutFor({ key: '' })).toBeNull();
  });

  it('ignores modified chords so browser and OS shortcuts still work', () => {
    expect(triageShortcutFor({ key: 'l', metaKey: true })).toBeNull();
    expect(triageShortcutFor({ key: 'l', ctrlKey: true })).toBeNull();
    expect(triageShortcutFor({ key: 'l', altKey: true })).toBeNull();
    // A shifted letter is a capital, not a decision.
    expect(triageShortcutFor({ key: 'L', shiftKey: true })).toBeNull();
  });

  it('ignores auto-repeat so a held key cannot decide a run of cards', () => {
    expect(triageShortcutFor({ key: 'ArrowRight', repeat: true })).toBeNull();
  });

  it('leaves Space to a focused button instead of skipping the card', () => {
    // Clicking Verify or a rating star leaves that button focused, so the
    // Space that follows is the operator pressing it again.
    for (const tag of ['BUTTON', 'A', 'SUMMARY']) {
      expect(triageShortcutFor({ key: ' ', target: element(tag) })).toBeNull();
    }
    expect(
      triageShortcutFor({
        key: ' ',
        target: element('DIV', { role: 'button' }),
      }),
    ).toBeNull();
  });

  it('still routes the letter and arrow keys with a button focused', () => {
    // Standing every shortcut down would strand the keyboard flow after each
    // mouse click; a button consumes Space, not `l` or an arrow.
    expect(triageShortcutFor({ key: 'l', target: element('BUTTON') })).toBe(
      'digDeeper',
    );
    expect(
      triageShortcutFor({ key: 'ArrowLeft', target: element('BUTTON') }),
    ).toBe('reject');
  });

  it('still skips on Space away from any control', () => {
    expect(triageShortcutFor({ key: ' ', target: element('DIV') })).toBe(
      'skip',
    );
  });

  it('never fires while the operator is typing into a control', () => {
    expect(
      triageShortcutFor({ key: 'v', target: element('INPUT') }),
    ).toBeNull();
    expect(
      triageShortcutFor({ key: 'd', target: element('TEXTAREA') }),
    ).toBeNull();
    expect(
      triageShortcutFor({ key: 'l', target: element('SELECT') }),
    ).toBeNull();
    expect(
      triageShortcutFor({
        key: 'z',
        target: element('DIV', {}, true),
      }),
    ).toBeNull();
    expect(
      triageShortcutFor({
        key: 'h',
        target: element('DIV', { role: 'textbox' }),
      }),
    ).toBeNull();
    // A plain, non-editable target still acts.
    expect(triageShortcutFor({ key: 'h', target: element('DIV') })).toBe(
      'reject',
    );
  });
});

describe('isEditableTriageTarget', () => {
  it('tolerates a null or non-element target', () => {
    expect(isEditableTriageTarget(null)).toBe(false);
    expect(isEditableTriageTarget({} as EventTarget)).toBe(false);
  });
});

describe('TRIAGE_SHORTCUTS', () => {
  it('documents exactly the actions the mapper can produce', () => {
    const documented = new Set(TRIAGE_SHORTCUTS.map((entry) => entry.action));
    expect(documented).toEqual(
      new Set(['digDeeper', 'open', 'reject', 'skip', 'undo', 'verify']),
    );
  });

  it('lists the three verdicts first, in deck order', () => {
    expect(TRIAGE_SHORTCUTS.slice(0, 3).map((entry) => entry.action)).toEqual([
      'reject',
      'skip',
      'digDeeper',
    ]);
  });
});
