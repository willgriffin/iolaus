import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { getAdminResource } from '$lib/admin/resources';
import OpportunityReviewPanel from './OpportunityReviewPanel.svelte';

describe('OpportunityReviewPanel evidence', () => {
  it('renders uncertain evidence separately from confirmed gaps', () => {
    const resource = getAdminResource('opportunities');
    if (!resource) throw new Error('Expected opportunities resource fixture');
    const { body } = render(OpportunityReviewPanel, {
      props: {
        record: {
          id: 'opp-1',
          evidenceMatrix: [
            { requirement: 'TypeScript', status: 'supported' },
            { requirement: 'PostgreSQL', status: 'uncertain' },
            { requirement: 'Kubernetes', status: 'gap' },
          ],
        },
        referenceOptions: {},
        resource,
      },
    });

    expect(body).toContain('>Supported</span>');
    expect(body).toContain('>Uncertain</span>');
    expect(body).toContain('>Gap</span>');
  });
});
