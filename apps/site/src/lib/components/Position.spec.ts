import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Position from './Position.svelte';

const baseProps = {
  filter: { mode: 'or' as const, tags: new Set<string>() },
  groupMap: {},
  search: '',
  skillMap: {},
  toggleTag: () => undefined,
};

describe('Position', () => {
  it('makes project URLs visibly identifiable links', () => {
    const { body } = render(Position, {
      props: {
        ...baseProps,
        position: {
          achievements: [],
          company: 'Example Co.',
          end: 'Present',
          id: 'example-position',
          projects: [
            {
              achievements: [],
              id: 'example-project',
              name: 'Example Project',
              url: 'https://example.com/project',
            },
          ],
          role: 'Engineer',
          start: '2024',
        },
      },
    });

    expect(body).toContain('class="project-link"');
    expect(body).toContain('href="https://example.com/project"');
    expect(body).toContain('project-link-icon');
    expect(body).toContain('aria-hidden="true"');
  });

  it('keeps projects without URLs as plain titles', () => {
    const { body } = render(Position, {
      props: {
        ...baseProps,
        position: {
          achievements: [],
          company: 'Example Co.',
          end: 'Present',
          id: 'example-position',
          projects: [
            {
              achievements: [],
              id: 'example-project',
              name: 'Offline Project',
            },
          ],
          role: 'Engineer',
          start: '2024',
        },
      },
    });

    expect(body).toContain('Offline Project');
    expect(body).not.toContain('class="project-link"');
  });
});
