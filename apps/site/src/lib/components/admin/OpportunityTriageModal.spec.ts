import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import OpportunityTriageModal from './OpportunityTriageModal.svelte';

vi.mock('$app/forms', () => ({ deserialize: () => ({ type: 'success' }) }));

function renderModal(props: Record<string, unknown> = {}) {
  return render(OpportunityTriageModal, {
    props: { open: true, search: 'skill=Rust', ...props },
  });
}

describe('OpportunityTriageModal shell', () => {
  it('is a dialog, not a page: no viewport-fixed bar of its own', () => {
    const { body } = renderModal();

    expect(body).toContain('<dialog');
    expect(body).toContain('aria-label="Triage opportunities"');
    // The action bar the shell's docks fought is gone; the verdicts moved into
    // the dialog's own footer.
    expect(body).not.toContain('class="action-bar"');
  });

  it('puts the sort chooser and the close button in the header, and nothing else', () => {
    const { body } = renderModal();

    expect(body).toContain('aria-label="Queue order"');
    expect(body).toContain('Match %');
    expect(body).toContain('Newest');
    expect(body).toContain('aria-label="Close triage"');
  });

  it('shows the operator no counts at all', () => {
    // A backlog in the thousands is discouraging as a number and useless as a
    // decision input: no position, no remaining, no tally, no chunk size.
    const { body } = renderModal();

    expect(body).not.toMatch(/\d+ of \d+/);
    expect(body).not.toContain('Queue empty');
    expect(body).not.toContain('this chunk');
    expect(body).not.toContain('remaining');
  });

  it('offers a plain close when the queue runs out', () => {
    const { body } = renderModal();

    expect(body).toContain('Nothing left to look at');
    expect(body).toMatch(/<button[^>]*class="primary[^"]*"[^>]*>Close</);
  });

  it('keeps the three verdicts and their key hints in the footer', () => {
    const { body } = renderModal();

    expect(body).toContain('Nope');
    expect(body).toContain('Later');
    expect(body).toContain('Dig deeper');
    expect(body).toContain('← / h / x');
    expect(body).toContain('space / s');
    expect(body).toContain('→ / l / d');
  });

  it('takes the initial focus off the header, so the deck keys work at once', () => {
    // `showModal()` focuses the first focusable descendant — the sort chip —
    // and a focused button owns Space, the deck's Later key.
    const { body } = renderModal();

    expect(body).toContain('class="focus-anchor');
    expect(body).toContain('tabindex="-1"');
    expect(body).toContain('autofocus');
  });

  it('offers no apply path anywhere in the deck', () => {
    const { body } = renderModal();

    expect(body).not.toContain('>Apply<');
    expect(body).not.toContain('acceptOpportunity');
  });

  it('links the shortlist the deep dive lands in, carrying the list filters', () => {
    const { body } = renderModal();

    const href = body
      .match(/href="(\/admin\/opportunities\?[^"]*)"/)?.[1]
      ?.replaceAll('&amp;', '&');
    expect(href).toBeDefined();
    const params = new URL(href as string, 'http://localhost').searchParams;
    expect(params.getAll('skill')).toEqual(['Rust']);
    expect(params.get('review')).toBe('maybe');
    expect(params.get('sort')).toBe('score');
    expect(params.get('sortDirection')).toBe('desc');
  });
});
