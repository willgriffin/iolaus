// @vitest-environment happy-dom

import type { SubmitFunction } from '@sveltejs/kit';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScreeningQuestionsEditor from './ScreeningQuestionsEditor.svelte';

const mocks = vi.hoisted(() => ({
  submit: undefined as SubmitFunction | undefined,
}));
vi.mock('$app/forms', () => ({
  enhance: (_node: HTMLFormElement, submit: SubmitFunction) => {
    mocks.submit = submit;
    return { destroy() {} };
  },
}));
const question = {
  id: 'q1',
  text: 'Does the posting allow remote work?',
  kind: 'source' as const,
  importance: 'preference' as const,
  desiredAnswer: 'yes' as const,
  weight: 3,
  active: true,
  revision: 'a'.repeat(64),
};
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
beforeEach(() => {
  mocks.submit = undefined;
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
});
async function start(
  invalidQuestions: {
    id: string;
    label: string;
    errorCode: 'invalid_question_rule';
    revision: string;
  }[] = [],
) {
  component = mount(ScreeningQuestionsEditor, {
    target,
    props: {
      data: {
        questions: [question],
        questionSetFingerprint: 'set',
        invalidQuestions,
        suggestions: [{ ...question, importance: 'preference' }],
      },
    },
  });
  flushSync();
}
async function click(label: string) {
  const button = [...target.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  )!;
  button.click();
  await tick();
  flushSync();
  return button;
}

describe('Screening Questions mobile progressive editor', () => {
  it('shows malformed saved questions and repairs or deletes only through their opaque native locator', async () => {
    await start([
      {
        id: 'invalid-q',
        label: 'Saved custom question',
        errorCode: 'invalid_question_rule',
        revision: 'opaque-native-cas',
      },
    ]);
    expect(target.querySelector('[role=alert]')?.textContent).toContain(
      'invalid',
    );
    await click('Repair question');
    await tick();
    flushSync();
    const form = target.querySelector<HTMLFormElement>(
      'form[aria-label="Edit screening question"]',
    )!;
    expect(new FormData(form).get('id')).toBe('invalid-q');
    expect(new FormData(form).get('expectedRevision')).toBe(
      'opaque-native-cas',
    );
    expect(new FormData(form).get('text')).toBe('');
    expect(target.querySelector('form[action="?/delete"]')).not.toBeNull();
    await click('Cancel');
    expect(document.activeElement?.id).toBe('repair-question-invalid-q');
  });

  it('replaces one preview with a focused editor, exposes explicit controls and cancels without saving', async () => {
    await start();
    await click('Edit question');
    expect(target.querySelectorAll('textarea')).toHaveLength(1);
    expect(document.activeElement?.id).toBe('screening-question-text');
    expect(
      target.querySelectorAll('form[aria-label="Edit screening question"]'),
    ).toHaveLength(1);
    const form = target.querySelector<HTMLFormElement>(
      'form[aria-label="Edit screening question"]',
    )!;
    expect(new FormData(form).get('expectedRevision')).toBe(question.revision);
    expect(
      form.querySelector('select[name=desiredAnswer]')?.textContent,
    ).toContain('No');
    expect(
      form.querySelector('select[name=importance]')?.textContent,
    ).toContain('Must-have');
    expect(
      target.querySelector<HTMLButtonElement>('#add-screening-question')
        ?.disabled,
    ).toBe(true);
    await click('Cancel');
    expect(target.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(
      document.getElementById('edit-question-q1'),
    );
  });
  it('keeps a rejected save draft open and closes only after an actual successful result', async () => {
    await start();
    await click('Edit question');
    const form = target.querySelector<HTMLFormElement>(
      'form[aria-label="Edit screening question"]',
    )!;
    // The latest enhancement belongs to Delete; invoke the same canonical submit handler.
    const callback = await mocks.submit!({
      cancel: vi.fn(),
      formElement: form,
      formData: new FormData(form),
      action: new URL('http://localhost/?/save'),
      controller: new AbortController(),
      submitter: null,
    });
    if (typeof callback !== 'function')
      throw new Error('Expected submit callback.');
    const update = vi.fn(async () => {});
    await callback({
      result: {
        type: 'failure',
        status: 409,
        data: { ok: false, error: 'Question changed. Reload before saving.' },
      },
      update,
      formElement: form,
      formData: new FormData(form),
      action: new URL('http://localhost/?/save'),
    });
    flushSync();
    expect(target.querySelector('[role=alert]')?.textContent).toContain(
      'Question changed',
    );
    expect(target.querySelector('textarea')).not.toBeNull();
    const retry = await mocks.submit!({
      cancel: vi.fn(),
      formElement: form,
      formData: new FormData(form),
      action: new URL('http://localhost/?/save'),
      controller: new AbortController(),
      submitter: null,
    });
    if (typeof retry !== 'function')
      throw new Error('Expected retry callback.');
    await retry({
      result: {
        type: 'success',
        status: 200,
        data: { ok: true, message: 'Screening question saved.' },
      },
      update,
      formElement: form,
      formData: new FormData(form),
      action: new URL('http://localhost/?/save'),
    });
    await tick();
    flushSync();
    expect(target.querySelector('textarea')).toBeNull();
    expect(target.querySelector('[role=status]')?.textContent).toContain(
      'saved',
    );
  });
  it('opens a suggestion as an unsaved editable preference', async () => {
    await start();
    await click('Edit suggestion');
    const form = target.querySelector<HTMLFormElement>(
      'form[aria-label="Edit screening question"]',
    )!;
    expect(new FormData(form).get('id')).toBe('');
    expect(new FormData(form).get('importance')).toBe('preference');
    await click('Cancel');
    expect(target.querySelector('textarea')).toBeNull();
  });
});
