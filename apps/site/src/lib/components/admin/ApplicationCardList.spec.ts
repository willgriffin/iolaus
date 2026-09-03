import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ApplicationCardList from './ApplicationCardList.svelte';

describe('ApplicationCardList refresh failures', () => {
  it('keeps cached cards visible while exposing a retryable refresh error', () => {
    const { body } = render(ApplicationCardList, {
      props: {
        error: 'Unable to refresh applications.',
        onRetry: () => undefined,
        records: [
          {
            id: 'application-1',
            opportunityTitle: 'Platform engineer',
            status: 'draft',
          },
        ],
      },
    });

    expect(body).toContain('Platform engineer');
    expect(body).toContain('Unable to refresh applications.');
    expect(body).toContain('Try again');
  });
});
