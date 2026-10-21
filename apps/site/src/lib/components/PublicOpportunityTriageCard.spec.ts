import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type {
  PublicOpportunity,
  PublicOpportunityDetail,
} from '$lib/public-opportunity-contract';
import PublicOpportunityTriageCard from './PublicOpportunityTriageCard.svelte';

const opportunity: PublicOpportunity = {
  id: 'role-1',
  title: 'Platform engineer',
  normalized_title: 'platform engineer',
  company: { id: 'northwind', name: 'Northwind', slug: 'northwind' },
  location: {
    text: 'Remote — Canada',
    countries: ['CA'],
    remote: true,
    timezones: [],
  },
  seniority: 'senior',
  function: 'engineering',
  employment_type: 'full_time',
  work_mode: 'remote',
  skills: {
    required: [{ slug: 'typescript', label: 'TypeScript' }],
    preferred: [{ slug: 'postgres', label: 'Postgres' }],
  },
  compensation: {
    currency: 'CAD',
    min: 150000,
    max: 180000,
    period: 'year',
    equity: null,
    source: 'posted',
  },
  posted_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  expires_at: null,
  analysis_version: 'v1',
  source_content_version: 1,
  posting_url: 'https://jobs.example.test/role-1',
  url: '/opportunities/role-1',
};

const detail = {
  ...opportunity,
  summary_bullets: [],
  description_text: 'Build dependable systems.\n\nWork closely with product.',
  qualifications_text: 'Five years of backend experience.',
  requirements: [
    {
      hash: 'a',
      text: 'Design APIs.',
      kind: 'must',
      category: 'technical',
      skills: ['typescript'],
    },
  ],
  eligibility: {
    remote: true,
    countries: ['CA'],
    regions: [],
    timezones: [],
    flags: 0,
    workAuthorization: { required: [], sponsorship: 'unknown' },
  },
} as unknown as PublicOpportunityDetail;

function card(props: Record<string, unknown> = {}) {
  return render(PublicOpportunityTriageCard, {
    props: {
      opportunity,
      detail,
      detailState: 'ready',
      onAction: () => undefined,
      ...props,
    },
  }).body;
}

describe('PublicOpportunityTriageCard', () => {
  it('uses the full posting in the deck while retaining public facts and compact skill links', () => {
    const body = card({ selectedSkills: ['typescript'] });

    expect(body).toContain('Platform engineer');
    expect(body).toContain('Remote — Canada');
    expect(body).toContain('CAD 150,000–180,000 / year');
    expect(body).toContain('Build dependable systems.');
    expect(body).toContain('Five years of backend experience.');
    expect(body).toContain('Design APIs.');
    expect(body).toMatch(/class="[^"]*matched/);
    expect(body).toContain('View original posting');
  });

  it('offers a retry when the detail request fails', () => {
    const body = card({
      detail: null,
      detailState: 'error',
      onRetry: () => undefined,
    });

    expect(body).toContain('The full posting could not load.');
    expect(body).toContain('Retry details');
  });
});
