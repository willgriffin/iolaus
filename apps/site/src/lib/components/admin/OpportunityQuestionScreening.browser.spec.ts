// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aggregateScreeningQuestionAnswers } from '$lib/opportunity-screening-questions';
import { questionScreeningFixture } from '$lib/question-screening-projection.test-support';
import OpportunityQuestionScreening from './OpportunityQuestionScreening.svelte';

const mocks = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({ invalidateAll: mocks.invalidateAll }));
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.unstubAllGlobals();
});
function start() {
  component = mount(OpportunityQuestionScreening, {
    target,
    props: { opportunityId: 'owned-opportunity' },
  });
  flushSync();
}
describe('explicit native question screening run', () => {
  it('makes no automatic calls and refreshes only after native success without changing human decisions', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, reused: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    start();
    expect(fetch).not.toHaveBeenCalled();
    target.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(mocks.invalidateAll).toHaveBeenCalledOnce());
    flushSync();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/admin/opportunities/owned-opportunity/screening-questions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(target.querySelector('[role=status]')?.textContent).toContain(
      'results refreshed',
    );
  });
  it('surfaces native rejection, ends the pending state and permits explicit retry', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Repair the invalid saved question before screening.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    start();
    target.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() =>
      expect(target.querySelector('[role=alert]')?.textContent).toContain(
        'Repair',
      ),
    );
    flushSync();
    expect(target.querySelector<HTMLButtonElement>('button')!.disabled).toBe(
      false,
    );
    expect(mocks.invalidateAll).not.toHaveBeenCalled();
    target.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});

it('shows title-only status without a full score and sends the explicit full-review override', async () => {
  const fetch = vi.fn(
    async (_url: string, _options: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetch);
  const projection = {
    ...(await questionScreeningFixture()),
    answers: [],
    aggregate: aggregateScreeningQuestionAnswers([], []),
    rolePreScreen: {
      title: 'Junior Accountant',
      targetRoles: ['Software engineer'],
      outcome: 'unrelated' as const,
      confidence: 0.99,
    },
  };
  component = mount(OpportunityQuestionScreening, {
    target,
    props: {
      opportunityId: 'owned-opportunity',
      projection,
      status: 'current',
    },
  });
  flushSync();
  expect(target.textContent).toContain('Title outside target roles');
  expect(target.textContent).not.toContain('Evidence coverage:');
  expect(target.textContent).not.toContain('Recommendation 0');
  [...target.querySelectorAll('button')]
    .find((button) =>
      button.textContent?.includes('Run full screening anyway'),
    )!
    .click();
  await vi.waitFor(() => expect(mocks.invalidateAll).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    body: '{"fullReview":true}',
  });
});
