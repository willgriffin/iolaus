import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { questionScreeningFixture } from '$lib/question-screening-projection.test-support';
import OpportunityQuestionScreening from './OpportunityQuestionScreening.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
describe('Screening Questions result UI', () => {
  it('renders deterministic recommendation, distinct evidence coverage, partial qualifiers and cited evidence', async () => {
    const { body } = render(OpportunityQuestionScreening, {
      props: {
        opportunityId: 'opportunity',
        projection: await questionScreeningFixture(),
        status: 'current',
      },
    });
    expect(body).toContain('Recommendation 40.0%');
    expect(body).toContain('Evidence coverage: 50.0%');
    expect(body).toContain(
      'Partial — attributable evidence with unresolved qualifiers',
    );
    expect(body).toContain('Unknown — evidence not established');
    expect(body).toContain('2 unresolved must-haves');
    expect(body).not.toContain('must-have conflicts.');
    expect(body).toContain('Maintained production APIs.');
    expect(body).toContain('not hiring probability');
    expect(body).toContain('Run screening');
  });
  it('disables Run while its parent is saving a decision without hiding cached results', async () => {
    const { body } = render(OpportunityQuestionScreening, {
      props: {
        opportunityId: 'opportunity',
        projection: await questionScreeningFixture(),
        status: 'current',
        disabled: true,
      },
    });
    const buttons = body.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('disabled');
    expect(body).toContain('Run screening');
    expect(body).toContain('Recommendation 40.0%');
  });
  it('hides stale recommendation and keeps refresh honest', async () => {
    const { body } = render(OpportunityQuestionScreening, {
      props: {
        opportunityId: 'opportunity',
        projection: await questionScreeningFixture(),
        status: 'unknown',
      },
    });
    expect(body).toContain('Screening needs refresh.');
    expect(body).not.toContain('Recommendation 40.0%');
  });
});
