import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { CandidateSkillDiscoverySnapshot } from '$lib/candidate-skill-discovery';
import CandidateSkillDiscovery from './CandidateSkillDiscovery.svelte';

vi.mock('$app/forms', () => ({ enhance: vi.fn() }));
const proposal = {
  id: 'p1',
  revision: 'revision-1',
  label: 'JS',
  canonicalLabel: 'JavaScript',
  classification: 'direct' as const,
  status: 'pending' as const,
  evidence: [
    {
      id: 'project-1',
      title: 'Shipped project',
      text: 'Built the production platform.',
    },
  ],
  confidence: 0.95,
};
const snapshot: CandidateSkillDiscoverySnapshot = {
  revision: 'snapshot',
  status: 'complete',
  canonicalSkills: ['TypeScript'],
  proposals: [proposal],
  scope: {
    candidateEvidenceCount: 10,
    vocabularyCount: 40,
    assessedCount: 20,
    remainingCount: 20,
    description: 'Bounded career evidence discovery.',
  },
};
const html = (value = snapshot, form = {}) =>
  render(CandidateSkillDiscovery, { props: { snapshot: value, form } }).body;
describe('skill discovery review surface', () => {
  it('shows direct evidence, canonical alias, scope and separate confirmation', () => {
    const body = html();
    expect(body).toContain('href="/admin/career"');
    expect(body).not.toContain('href="/admin/resume"');
    for (const text of [
      'Direct experience',
      'JavaScript',
      'JS → JavaScript',
      'Shipped project',
      'Built the production platform.',
      '20 of 40',
      'does not publish',
      'Add skill',
      'Dismiss proposal',
    ])
      expect(body).toContain(text);
    expect(body).toContain('action="?/discover"');
    expect(body).toContain('action="?/confirm"');
    expect(body).toContain('value="revision-1"');
    expect(body).not.toContain('name="canonicalLabel"');
    expect(body).not.toContain('name="evidence"');
  });
  it('keeps introductory limitation and never offers confirmation for unknown or duplicates', () => {
    const body = html({
      ...snapshot,
      proposals: [
        { ...proposal, classification: 'introductory' },
        { ...proposal, id: 'p2', classification: 'unknown' },
        { ...proposal, id: 'p3', status: 'duplicate' },
      ],
    });
    expect(body).toContain('Add as introductory');
    expect(body).toContain('Unknown — evidence not established');
    expect(body).toContain('No duplicate will be added.');
    expect((body.match(/action="\?\/confirm"/g) ?? []).length).toBe(1);
    expect(body).not.toContain('>Add skill<');
  });
  it('makes stale discovery visible and disables confirmation', () => {
    const body = html({ ...snapshot, status: 'stale' });
    expect(body).toContain('Run discovery again before confirming');
    expect(body).toMatch(/type="submit"[^>]*disabled/);
  });
  it('shows confirmation feedback and updated proposal snapshot', () => {
    const body = html(snapshot, {
      ok: true,
      message: 'Confirmed privately.',
      snapshot: {
        ...snapshot,
        proposals: [{ ...proposal, status: 'confirmed' }],
      },
    });
    expect(body).toContain('role="status"');
    expect(body).toContain('Confirmed privately.');
    expect(body).not.toContain('action="?/confirm"');
  });
  it('explains partial continuation, complete state and empty initial state without claims', () => {
    expect(html({ ...snapshot, status: 'partial' })).toContain(
      'Continue skill discovery',
    );
    expect(html()).toContain('Discovery complete');
    expect(
      html({
        ...snapshot,
        proposals: [
          { ...proposal, label: 'TypeScript', canonicalLabel: 'typescript' },
        ],
      }),
    ).not.toContain('Alias:');
    expect(html({ ...snapshot, status: 'partial' })).toContain(
      'Remaining skills have not been assessed',
    );
    expect(html({ ...snapshot, status: 'idle', proposals: [] })).toContain(
      'No discovery run yet',
    );
  });
});
