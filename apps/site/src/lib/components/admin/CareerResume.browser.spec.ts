// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CareerResume from './CareerResume.svelte';
import { data } from './career-resume-fixture';

const mocks = vi.hoisted(() => ({ enhance: vi.fn() }));
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
vi.mock('$app/forms', () => ({ enhance: mocks.enhance }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});
beforeEach(() => {
  mocks.enhance.mockReset();
  mocks.enhance.mockReturnValue({ destroy: () => {} });
});
function setup(resumeData = data) {
  component = mount(CareerResume, {
    target: document.body,
    props: { data: resumeData },
  });
  flushSync();
}
async function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
  await tick();
}
function visibilityCompletion() {
  const call = mocks.enhance.mock.calls.find(
    ([node]) =>
      node instanceof HTMLFormElement &&
      node.getAttribute('action') === '?/visibility',
  );
  expect(call).toBeDefined();
  const submit = call?.[1] as (input: { cancel: () => void }) => unknown;
  const completion = submit({ cancel: vi.fn() });
  expect(typeof completion).toBe('function');
  return completion as (input: {
    result: { type: string; data?: Record<string, unknown> };
    update: () => Promise<void>;
  }) => Promise<void>;
}

describe('Resume section tabs', () => {
  it('reveals experience previews, related bullets and hidden records only on demand', async () => {
    setup();
    expect(document.body.textContent).not.toContain('Staff Engineer');
    await click('#resume-tab-experience');
    expect(document.querySelector('#resume-panel-details')).toBeNull();
    expect(document.body.textContent).toContain('Staff Engineer · Northstar');
    expect(document.body.textContent).toContain('Canonical experience summary');
    expect(document.body.textContent).not.toContain(
      'Short achievement preview',
    );
    expect(document.body.textContent).not.toContain('Hidden experience body');
    expect(
      document.querySelector('a[href="/admin/experiences"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('a[href="/admin/achievements"]'),
    ).not.toBeNull();
    expect(document.querySelector('#resume-hidden-other')).not.toBeNull();
    await click('#resume-children-raw-experience');
    expect(document.body.textContent).toContain('Short achievement preview');
    expect(document.body.textContent).not.toContain('Full achievement body');
    await click('#resume-hidden-experience');
    expect(document.body.textContent).toContain('Hidden experience body');
    expect(
      document.querySelector('form[action="?/visibility"]'),
    ).not.toBeNull();
  });

  it('groups role duties by their section heading and keeps project bullets nested below the project', async () => {
    const nested = structuredClone(data);
    nested.sections.push(
      {
        key: 'projects',
        label: 'Projects',
        href: '/admin/projects',
        fields: [],
        records: [
          {
            id: 'project-1',
            values: {},
            presentation: {
              title: 'Customer portal',
              context: 'Staff Engineer · Northstar',
              preview: 'A real project.',
              inResume: true,
              parentExperienceId: 'raw-experience',
              kind: 'Project',
            },
          },
        ],
      },
      {
        key: 'duties',
        label: 'Responsibilities',
        href: '/admin/duties',
        fields: [],
        records: [
          {
            id: 'duty-1',
            values: {},
            presentation: {
              title: 'Delivery',
              dutySectionTitle: 'Delivery',
              context: 'Staff Engineer · Northstar',
              preview: 'Built services.',
              inResume: true,
              parentExperienceId: 'raw-experience',
              kind: 'Responsibility',
            },
          },
          {
            id: 'duty-2',
            values: {},
            presentation: {
              title: 'Delivery',
              dutySectionTitle: 'Delivery',
              context: 'Staff Engineer · Northstar',
              preview: 'Mentored engineers.',
              inResume: true,
              parentExperienceId: 'raw-experience',
              kind: 'Responsibility',
            },
          },
          {
            id: 'project-duty',
            values: {},
            presentation: {
              title: 'Portal work',
              dutySectionTitle: 'Portal work',
              context: 'Customer portal',
              preview: 'Reduced checkout latency.',
              inResume: true,
              parentExperienceId: 'raw-experience',
              parentProjectId: 'project-1',
              kind: 'Responsibility',
            },
          },
        ],
      },
    );
    setup(nested);
    await click('#resume-tab-experience');
    await click('#resume-children-raw-experience');
    expect(document.querySelectorAll('.duty-section h3')).toHaveLength(2);
    expect(document.body.textContent).toContain('Built services.');
    expect(document.body.textContent).toContain('Mentored engineers.');
    const project = Array.from(document.querySelectorAll('.related-row')).find(
      (row) => row.textContent?.includes('Customer portal'),
    );
    expect(project).toBeDefined();
    expect(
      project?.nextElementSibling?.classList.contains('project-children'),
    ).toBe(true);
    expect(project?.nextElementSibling?.textContent).toContain(
      'Reduced checkout latency.',
    );
  });

  it('shows accumulated skill evidence with quoted source and distinct usage dates', async () => {
    const withEvidence = structuredClone(data);
    withEvidence.sections.push({
      key: 'skillGroups',
      label: 'Skill groups',
      href: '/admin/skill-groups',
      fields: [],
      records: [
        {
          id: 'group-1',
          values: {},
          presentation: {
            title: 'Platform engineering',
            context: '',
            preview: 'TypeScript',
            inResume: true,
            kind: 'Skill group',
            evidence: [
              {
                proposalExperienceId: 'proposal-1',
                experienceId: 'raw-experience',
                role: 'Staff Engineer',
                company: 'Northstar',
                roleStartDate: '2020-01',
                roleEndDate: '2024-01',
                usage: 'Built services.',
                depth: 'hands_on',
                quote: 'Built a TypeScript service.',
                page: 2,
                startDate: '2022-02',
                endDate: '2022-09',
              },
            ],
          },
        },
      ],
    });
    setup(withEvidence);
    await click('#resume-tab-skills');
    const evidence = document.querySelector('.skill-evidence');
    expect(evidence?.textContent).toContain('Evidence from roles (1)');
    expect(evidence?.textContent).toContain('Staff Engineer — Northstar');
    expect(evidence?.textContent).toContain('Built a TypeScript service.');
    expect(evidence?.textContent).toContain(
      'Explicit usage dates: 2022-02 – 2022-09',
    );
    expect(evidence?.textContent).toContain('Role context: 2020-01 – 2024-01');
    expect(evidence?.textContent).not.toContain('years of experience');
  });

  it('supports keyboard selection and focus across Details, Experience and Skills', async () => {
    setup();
    const details = document.querySelector<HTMLButtonElement>(
      '#resume-tab-details',
    )!;
    details.focus();
    details.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await tick();
    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe('resume-tab-experience'),
    );
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    await tick();
    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe('resume-tab-skills'),
    );
    expect(document.querySelector('#resume-panel-skills')).not.toBeNull();
    expect(document.querySelector('a[href="/admin/skills"]')).not.toBeNull();
    expect(document.querySelector('#resume-panel-experience')).toBeNull();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    await tick();
    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe('resume-tab-details'),
    );
  });

  it('shows visibility action success and failure feedback without exposing an inline editor', async () => {
    setup();
    await visibilityCompletion()({
      result: {
        type: 'success',
        data: { ok: true, message: 'Summary hidden.' },
      },
      update: vi.fn(async () => {}),
    });
    expect(document.body.textContent).toContain('Summary hidden.');
    expect(document.querySelector('#resume-inline-editor')).toBeNull();

    await visibilityCompletion()({
      result: { type: 'failure', data: { error: 'Visibility failed.' } },
      update: vi.fn(async () => {}),
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Visibility failed.',
    );
  });
});
