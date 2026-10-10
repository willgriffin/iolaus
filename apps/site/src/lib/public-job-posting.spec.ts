import { expect, it } from 'vitest';
import { jsonLdScript, publicJobPosting } from './public-job-posting.js';
import { publicOpportunityDetailSchema } from './public-opportunity-contract.js';

const posting = publicOpportunityDetailSchema.parse({
  id: 'test',
  title: 'Engineer </script><img src=x>',
  normalized_title: 'Engineer',
  company: { id: 'company', name: 'Public company', slug: 'company' },
  location: { text: '', countries: ['CA'], remote: true, timezones: [] },
  seniority: 'senior',
  function: 'engineering',
  employment_type: 'full-time',
  work_mode: 'remote',
  skills: { required: [], preferred: [] },
  compensation: {
    currency: 'CAD',
    min: 100000,
    max: 150000,
    period: 'year',
    equity: null,
    source: 'posted',
  },
  posted_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z',
  expires_at: null,
  analysis_version: 'opportunity-analysis/v1',
  source_content_version: 1,
  posting_url: 'https://example.org/job',
  url: '/opportunities/test',
  summary_bullets: ['Build useful software'],
  requirements: [],
  eligibility: {
    remote: true,
    countries: ['CA'],
    regions: [],
    timezones: [],
    flags: 0,
    workAuthorization: { required: [], sponsorship: 'unknown' },
  },
});
it('uses posted values, has no invented expiry and encodes script-breaking content', () => {
  const data = publicJobPosting(posting, 'https://jobgeni.us');
  expect(data).not.toHaveProperty('validThrough');
  expect(data).toMatchObject({
    description: 'Build useful software',
    employmentType: 'FULL_TIME',
    url: 'https://jobgeni.us/opportunities/test',
    baseSalary: {
      currency: 'CAD',
      value: { unitText: 'YEAR', minValue: 100000 },
    },
  });
  const script = jsonLdScript(data);
  expect(script).not.toContain('</script><img');
  expect(JSON.parse(script.slice(script.indexOf('>') + 1, -9)).title).toBe(
    posting.title,
  );
});
it('omits missing optional dates and unposted salary', () => {
  const data = publicJobPosting(
    { ...posting, posted_at: null, compensation: null },
    'https://jobgeni.us',
  );
  expect(data).not.toHaveProperty('datePosted');
  expect(data).not.toHaveProperty('baseSalary');
});
