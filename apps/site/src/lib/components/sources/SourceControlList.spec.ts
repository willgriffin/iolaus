import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import SourceControlList from './SourceControlList.svelte';

describe('SourceControlList', () => {
  it('renders friendly root-source controls and hides derived sources', () => {
    const { body } = render(SourceControlList, {
      props: {
        records: [
          {
            id: 'root-1',
            isActive: true,
            name: 'OpenAI careers',
            provider: 'ashby',
            sourceRole: 'root',
            type: 'company_careers',
            url: 'https://jobs.ashbyhq.com/openai',
          },
          {
            id: 'derived-1',
            name: 'A posting-derived record',
            parentSourceId: 'root-1',
            sourceRole: 'posting_derived',
          },
          {
            id: 'root-2',
            isActive: false,
            name: 'Another careers board',
            sourceRole: 'root',
          },
        ],
      },
    });

    expect(body).toContain('Your job sources');
    expect(body).toContain('OpenAI careers');
    expect(body).toContain('Ashby');
    expect(body).toContain('Activate');
    expect(body).toContain('Deactivate');
    expect(body).toContain('Pull now');
    expect(body).toContain('Edit');
    expect(body).toContain('View opportunities');
    expect(body).toContain('Add a job source');
    expect(body).not.toContain('A posting-derived record');
    expect(body).not.toContain('idempotency');
    expect(body).not.toContain('invitation');
  });

  it('shows a friendly empty state when no root source exists', () => {
    const { body } = render(SourceControlList, { props: { records: [] } });

    expect(body).toContain('Start with a job source');
    expect(body).toContain('Add a job source');
  });

  it('only makes web addresses clickable', () => {
    const { body } = render(SourceControlList, {
      props: {
        records: [
          {
            id: 'unsafe-root',
            isActive: true,
            name: 'Unsafe address',
            sourceRole: 'root',
            url: 'javascript:alert(1)',
          },
        ],
      },
    });

    expect(body).toContain('No careers-board address saved yet.');
    expect(body).not.toContain('javascript:');
  });
});
