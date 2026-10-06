// @vitest-environment happy-dom
import type { SubmitFunction } from '@sveltejs/kit';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CandidateSkillDiscovery from './CandidateSkillDiscovery.svelte';

const mocks = vi.hoisted(() => ({
  submits: new Map<string, SubmitFunction>(),
}));
vi.mock('$app/forms', () => ({
  enhance: (node: HTMLFormElement, submit: SubmitFunction) => {
    const key = `${node.getAttribute('action')}:${new FormData(node).get('id') ?? ''}`;
    mocks.submits.set(key, submit);
    return { destroy: () => mocks.submits.delete(key) };
  },
}));
let target: HTMLElement;
let component: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  mocks.submits.clear();
});
async function start() {
  component = mount(CandidateSkillDiscovery, {
    target,
    props: {
      snapshot: {
        revision: 'snapshot',
        status: 'partial',
        canonicalSkills: [],
        scope: {
          candidateEvidenceCount: 5,
          vocabularyCount: 20,
          assessedCount: 10,
          remainingCount: 10,
          description: 'Career evidence only',
        },
        proposals: [
          {
            id: 'direct',
            revision: 'direct-rev',
            label: 'TS',
            canonicalLabel: 'TypeScript',
            classification: 'direct',
            status: 'pending',
            evidence: [
              {
                id: 'e1',
                title: 'Platform project',
                text: 'Shipped TypeScript.',
              },
            ],
            confidence: 0.95,
          },
          {
            id: 'intro',
            revision: 'intro-rev',
            label: 'Python',
            canonicalLabel: 'Python',
            classification: 'introductory',
            status: 'pending',
            evidence: [
              {
                id: 'e2',
                title: 'Verified note',
                text: 'Only dabbled in Python.',
              },
            ],
            confidence: 0.93,
          },
          {
            id: 'unknown',
            revision: 'unknown-rev',
            label: 'Java',
            canonicalLabel: 'Java',
            classification: 'unknown',
            status: 'pending',
            evidence: [],
            confidence: null,
          },
        ],
      },
    },
  });
  flushSync();
  await tick();
}
function actionForm(buttonLabel: string) {
  const button = [...target.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === buttonLabel,
  );
  const form = button?.closest('form');
  if (!form) throw new Error(`Missing form for ${buttonLabel}`);
  return form;
}
describe('skill discovery progressive mobile review', () => {
  it('uses only exact proposal locators and preserves introductory confirmation meaning', async () => {
    await start();
    const direct = new FormData(actionForm('Add skill'));
    expect([...direct.entries()]).toEqual([
      ['id', 'direct'],
      ['expectedRevision', 'direct-rev'],
    ]);
    const intro = new FormData(actionForm('Add as introductory'));
    expect([...intro.entries()]).toEqual([
      ['id', 'intro'],
      ['expectedRevision', 'intro-rev'],
    ]);
    expect(
      target.querySelector(
        'article[aria-labelledby="skill-unknown"] form[action="?/confirm"]',
      ),
    ).toBeNull();
    expect(target.querySelector('details')?.textContent).toContain(
      'Shipped TypeScript.',
    );
  });
  it('locks repeated submission during pending discovery and restores controls on transport failure', async () => {
    await start();
    const form = actionForm('Continue skill discovery');
    const submit = mocks.submits.get(
      `${form.getAttribute('action')}:${new FormData(form).get('id') ?? ''}`,
    );
    if (!submit) throw new Error('Missing enhance handler');
    const finish = await submit({ cancel: vi.fn() } as never);
    flushSync();
    expect(
      [...target.querySelectorAll('button')].every((button) => button.disabled),
    ).toBe(true);
    const cancel = vi.fn();
    await submit({ cancel } as never);
    expect(cancel).toHaveBeenCalledOnce();
    if (typeof finish !== 'function')
      throw new Error('Missing progressive response handler');
    await finish({ result: { type: 'error' }, update: vi.fn() } as never);
    flushSync();
    expect(target.querySelector('[role=alert]')?.textContent).toContain(
      'Your proposals remain available',
    );
    expect(
      actionForm('Add as introductory').querySelector('button')?.disabled,
    ).toBe(false);
  });
  it('updates native action failure without resetting review forms', async () => {
    await start();
    const submit = mocks.submits.get('?/confirm:direct');
    if (!submit) throw new Error('Missing enhance handler');
    const finish = await submit({ cancel: vi.fn() } as never);
    const update = vi.fn(async () => {});
    if (typeof finish !== 'function') throw new Error('Missing handler');
    await finish({
      result: {
        type: 'failure',
        status: 409,
        data: { error: 'Evidence changed' },
      },
      update,
    } as never);
    expect(update).toHaveBeenCalledWith({ reset: false });
    flushSync();
    expect(target.querySelectorAll('article')).toHaveLength(3);
  });
});
