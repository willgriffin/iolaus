import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ApplicationReviewPage from '../../../routes/admin/applications/[id=recordId]/+page.svelte';
import ApplicationOpportunityOverview from './ApplicationOpportunityOverview.svelte';

vi.mock('$app/forms', () => ({
  deserialize: () => ({ type: 'success' }),
  enhance: () => ({ destroy() {} }),
}));
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.unstubAllGlobals();
});

it('shows stored facts and opens the existing modal without any triage side effects', async () => {
  component = mount(ApplicationOpportunityOverview, {
    target,
    props: {
      company: { name: 'Acme' },
      opportunity: {
        id: 'selected',
        title: 'Engineer',
        locations: 'Canada',
        workMode: 'remote',
        salaryMin: 100000,
        salaryMax: 120000,
        currency: 'CAD',
        descriptionSummary: 'Build tools',
        responsibilities: '- Ship software',
        qualifications: '- TypeScript',
        descriptionRaw: 'Original full posting',
        postingUrl: 'https://example.com/role',
      },
    },
  });
  flushSync();
  expect(target.textContent).toContain('Acme');
  expect(target.textContent).toContain('Canada');
  expect(target.textContent).toContain('remote');
  expect(target.textContent).toContain('CAD 100,000–120,000 / year');
  expect(target.textContent).toContain('Ship software');
  expect(target.textContent).toContain('TypeScript');
  target.querySelector<HTMLButtonElement>('button')!.click();
  flushSync();
  const dialog = target.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-label')).toBe(
    'Original opportunity posting',
  );
  expect(dialog.textContent).toContain('Original full posting');
  expect(dialog.textContent).not.toContain('Review notes');
  expect(dialog.querySelector('[aria-label="Nope"]')).toBeNull();
  expect(dialog.querySelector('[aria-label="Dig deeper"]')).toBeNull();
  expect(dialog.textContent).not.toContain('Verify posting');
  expect(dialog.textContent).not.toContain('Run question screening');
  for (const key of ['x', 'l', 's', 'v', 'u', 'ArrowLeft', 'ArrowRight', ' ']) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    flushSync();
    expect(dialog.textContent).toContain('Original full posting');
  }
  const deck = dialog.querySelector('.deck')!;
  const pointer = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: x,
      clientY: 0,
    });
    deck.dispatchEvent(event);
  };
  pointer('pointerdown', 0);
  pointer('pointermove', 350);
  pointer('pointerup', 350);
  flushSync();
  expect(dialog.textContent).toContain('Original full posting');
  expect(fetch).not.toHaveBeenCalled();
  dialog
    .querySelector<HTMLButtonElement>('[aria-label="Close posting"]')!
    .click();
  flushSync();
  expect(target.querySelector('dialog')?.open).toBeFalsy();
});

it('handles an unavailable opportunity without inventing posting facts', () => {
  component = mount(ApplicationOpportunityOverview, {
    target,
    props: { company: null, opportunity: null },
  });
  flushSync();
  expect(target.textContent).toContain('Role not available');
  expect(target.textContent).toContain('Pay not stated');
  expect(target.textContent).toContain('Original posting link not available');
  expect(target.querySelector('button')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('switches material review controls while keeping final approval explicit', () => {
  component = mount(ApplicationReviewPage, {
    target,
    props: {
      data: {
        application: { id: 'application', status: 'awaiting_user' },
        answersEditor: {
          ats: '',
          hasSchema: false,
          questions: [],
          reusableAnswerCount: 0,
        },
        autoSubmit: {
          ats: '',
          hasSchema: false,
          requiredQuestions: [],
          missingRequiredAnswers: [],
        },
        comments: [],
        company: { name: 'Acme' },
        opportunity: { title: 'Engineer' },
        materials: ['packet', 'resume', 'cover_letter', 'answers'].map(
          (materialType) => ({
            materialType,
            label: materialType,
            body: 'Current material',
            href: '',
            materialRecordId: materialType,
            materialRecordType: 'ResumeAsset',
            materialVersion: 'v1',
            path: '',
            pdfHref: '',
            pdfPath: '',
            reviewStatus: 'not_reviewed' as const,
            title: '',
          }),
        ),
        finalApprovalMaterialsCurrent: false,
        preflight: { requiresOverride: false },
        submissionOptions: { methods: [], roles: [] },
        submissionTaskId: '',
      },
    },
  });
  flushSync();
  expect(
    [...target.querySelectorAll('h1, h2, h3')].filter(
      (heading) => heading.textContent === 'Engineer',
    ),
  ).toHaveLength(1);
  const tabs = target.querySelector('.material-tabs')!;
  expect(tabs.querySelector('[aria-current=page]')?.textContent).toBe(
    'Opportunity',
  );
  expect(target.querySelector('[formaction="?/reviewMaterial"]')).toBeNull();
  tabs.querySelectorAll<HTMLButtonElement>('button')[1].click();
  flushSync();
  expect(
    target.querySelector<HTMLInputElement>('[name=materialType]')?.value,
  ).toBe('resume');
  expect(
    target.querySelector('[formaction="?/reviewMaterial"]'),
  ).not.toBeNull();
  expect(
    target.querySelector('[name=finalSubmissionIntent]')?.getAttribute('value'),
  ).toBe('final_submission');
  tabs.querySelectorAll<HTMLButtonElement>('button')[0].click();
  flushSync();
  expect(target.querySelector('[formaction="?/reviewMaterial"]')).toBeNull();
  expect(target.querySelector('[formaction="?/addComments"]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
