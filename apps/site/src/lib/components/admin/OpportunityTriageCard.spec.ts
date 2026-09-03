import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { AdminRecord } from '$lib/admin/dock';
import OpportunityTriageCard from './OpportunityTriageCard.svelte';

function renderCard(record: AdminRecord, props: Record<string, unknown> = {}) {
  return render(OpportunityTriageCard, {
    props: {
      onAction: () => undefined,
      record,
      ...props,
    },
  });
}

describe('OpportunityTriageCard', () => {
  it('renders the posting and the card utilities', () => {
    const { body } = renderCard({
      companyName: 'Northwind',
      descriptionSummary: 'Own the platform.',
      humanRating: 6,
      id: 'opp-1',
      latestScore: 87,
      locations: 'Remote (US)',
      postingUrl: 'https://example.test/jobs/1',
      requiredSkills: 'Rust, Postgres',
      title: 'Staff platform engineer',
    });

    expect(body).toContain('Staff platform engineer');
    expect(body).toContain('Northwind');
    expect(body).toContain('Remote (US)');
    expect(body).toContain('87');
    expect(body).toContain('https://example.test/jobs/1');
    expect(body).toContain('Rust');
    expect(body).toContain('Verify posting');
    expect(body).toContain('Undo');
  });

  it('offers no apply path: the verdicts live in the deck, not on the card', () => {
    const { body } = renderCard({ id: 'opp-1', title: 'Staff engineer' });

    // Triage decides what deserves a deeper look. An application is started
    // from the shortlist or the record page, never from a card.
    expect(body).not.toContain('>Apply</button>');
    expect(body).not.toContain('acceptOpportunity');
    expect(body).not.toContain('preflightOverrideReason');
  });

  it('hides the posting check and the rating: the verdict buttons carry both', () => {
    const { body } = renderCard({
      humanRating: 6,
      id: 'opp-1',
      title: 'Staff platform engineer',
    });

    expect(body).not.toContain('Posting check');
    expect(body).not.toContain('Your rating');
    expect(body).not.toContain('Rate 1 of 10');
    expect(body).not.toContain('6/10');
  });

  it('puts the job description before the summary, skills, and qualifications', () => {
    const { body } = renderCard({
      descriptionRaw: 'We build boring, reliable infrastructure.',
      descriptionSummary: 'Own the platform.',
      id: 'opp-1',
      qualifications: '- 8 years of Rust',
      requiredSkills: 'Rust, Postgres',
      title: 'Staff platform engineer',
    });

    const description = body.indexOf(
      'We build boring, reliable infrastructure.',
    );
    expect(description).toBeGreaterThan(-1);
    expect(description).toBeLessThan(body.indexOf('Own the platform.'));
    expect(description).toBeLessThan(body.indexOf('Rust'));
    expect(description).toBeLessThan(body.indexOf('8 years of Rust'));
  });

  it('stays renderable when the crawl captured nothing but a title', () => {
    const { body } = renderCard({ id: 'opp-2', title: 'Backend engineer' });

    expect(body).toContain('Backend engineer');
    expect(body).toContain('Unknown company');
    expect(body).toContain('Location not stated');
    expect(body).toContain('Not scored');
    expect(body).toContain('No summary captured yet.');
    // No posting URL means no dangling posting link.
    expect(body).not.toContain('View the posting');
  });

  it('falls back to an untitled label and still offers a full-record link', () => {
    const { body } = renderCard({ id: 'opp-3' });

    expect(body).toContain('Untitled opportunity');
    expect(body).toContain('/admin/opportunities/opp-3');
  });

  it('drops the apply caveat now that no decision here creates one', () => {
    const { body } = renderCard({ id: 'opp-4', title: 'Lead' });
    const text = body.replace(/\s+/g, ' ');

    expect(text).toContain('Undo restores the review fields of the last');
    expect(text).not.toContain('cannot remove an application');
  });

  it('documents the remapped keyboard shortcuts on the card', () => {
    const { body } = renderCard({ id: 'opp-5', title: 'Lead' });

    expect(body).toContain('← / h / x');
    expect(body).toContain('→ / l / d');
    expect(body).toContain('space / s');
    expect(body).toContain('Dig deeper');
    expect(body).toContain('Nope');
    expect(body).toContain('Later');
    // The retired apply key must not survive in the legend.
    expect(body).not.toContain('↓ / j');
  });

  it('disables every action while a decision is in flight', () => {
    const { body } = renderCard({ id: 'opp-6', title: 'Lead' }, { busy: true });

    const buttons = body.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.includes('disabled'))).toBe(true);
  });

  it('leaves queue progress to the dialog that owns the queue', () => {
    // The card is only ever about the posting in hand; "n of total" belongs to
    // the triage dialog's header, beside the close button.
    const { body } = renderCard({ id: 'opp-7', title: 'Lead' });

    expect(body).not.toContain('Queue empty');
    expect(body).not.toContain('class="progress');
  });
});
