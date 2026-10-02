import { describe, expect, it, vi } from 'vitest';
import {
  isSmartRecruitersPostingUrl,
  resolveSmartRecruitersPosting,
} from './smartrecruiters-posting-details';

const url = new URL(
  'https://jobs.smartrecruiters.com/Experian/744000143870909-gen-ai-software-engineer-senior',
);
// Official API shape observed 2026-10-02; posting prose shortened/paraphrased.
function fixture() {
  return {
    id: '744000143870909',
    name: 'Gen AI Software Engineer Senior',
    company: { name: 'Experian', identifier: 'Experian' },
    active: true,
    visibility: 'PUBLIC',
    postingUrl:
      'https://jobs.smartrecruiters.com/Experian/744000144609430-gen-ai-software-engineer-senior',
    location: {
      city: 'Heredia',
      region: 'Heredia',
      country: 'cr',
      fullLocation: 'Heredia, Heredia, Costa Rica',
      remote: false,
      hybrid: true,
    },
    customField: [{ fieldLabel: 'Role Type', valueLabel: 'Hybrid' }],
    releasedDate: '2026-08-20T17:51:45.870Z',
    typeOfEmployment: { id: 'permanent', label: 'Full-time' },
    jobAd: {
      sections: {
        companyDescription: {
          title: 'Company Description',
          text: '<p>Experian builds data and technology products for businesses worldwide.</p>',
        },
        jobDescription: {
          title: 'Job Description',
          text: '<p>Develop automation workflows for onboarding, transactions, and reporting. Integrate generative AI, language models, agent frameworks, vector databases, and retrieval tools. Partner with product and operations teams, test and document systems, and maintain reliable distributed automation.</p>',
        },
        qualifications: {
          title: 'Qualifications',
          text: '<p>Computer science degree or related experience. Python proficiency, TypeScript or JavaScript knowledge, and practical experience with cloud platforms, APIs, language models, and retrieval systems.</p>',
        },
        additionalInformation: {
          title: 'Additional Information',
          text: '<p>This is a fully remote job opportunity. #LI-Remote</p>',
        },
      },
    },
  };
}
function plainText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() : '';
}
function fetchPayload(value: unknown = fixture()) {
  return vi.fn(async () => Response.json(value));
}

describe('official SmartRecruiters detail capture', () => {
  it('captures substantive identity-bound public details with original posting provenance', async () => {
    const fetchImpl = fetchPayload();
    const result = await resolveSmartRecruitersPosting(
      url,
      fetchImpl,
      plainText,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.smartrecruiters.com/v1/companies/Experian/postings/744000143870909',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      status: 'resolved',
      provider: 'smartrecruiters',
      canonicalUrl: url.toString(),
      externalId: '744000143870909',
      companyName: 'Experian',
      title: 'Gen AI Software Engineer Senior',
      employmentType: 'full_time',
      locations: ['Heredia, Heredia, Costa Rica'],
      workMode: 'unknown',
    });
    if (result.status !== 'resolved')
      throw new Error('Expected a verified public source capture.');
    expect(result.descriptionRaw).toContain('Develop automation workflows');
    expect(result.descriptionRaw).toContain('Qualifications');
    expect(result.descriptionRaw).toContain('fully remote');
    expect(result.locationNotes).toContain(
      'structured Hybrid; posting says fully remote',
    );
    expect(result.postedAt?.toISOString()).toBe('2026-08-20T17:51:45.870Z');
    expect(result.sourceEvidence).toMatchObject({
      active: true,
      visibility: 'PUBLIC',
      requestedPostingUrl: url.toString(),
      apiPostingUrl: fixture().postingUrl,
      remote: false,
      hybrid: true,
    });
    for (const field of [
      'visaOrEorPossible',
      'relocationSupported',
      'workRights',
      'salaryMin',
      'salaryMax',
    ])
      expect(result).not.toHaveProperty(field);
  });
  it.each([
    'http://jobs.smartrecruiters.com/Experian/744000143870909-job',
    'https://jobs.smartrecruiters.com.attacker.test/Experian/744000143870909-job',
    'https://jobs.smartrecruiters.com/Experian',
    'https://credential@jobs.smartrecruiters.com/Experian/744000143870909-job',
  ])('does not fetch an unsupported or unbound URL: %s', async (postingUrl) => {
    const candidate = new URL(postingUrl);
    const fetchImpl = fetchPayload();
    expect(isSmartRecruitersPostingUrl(candidate)).toBe(false);
    expect(
      (await resolveSmartRecruitersPosting(candidate, fetchImpl, plainText))
        .status,
    ).toBe('unsupported');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    'id',
    'company',
  ])('refuses a mismatched %s identity rather than importing another posting', async (field) => {
    const payload = fixture();
    if (field === 'id') payload.id = '744000999999999';
    else payload.company.identifier = 'DifferentEmployer';
    expect(
      (
        await resolveSmartRecruitersPosting(
          url,
          fetchPayload(payload),
          plainText,
        )
      ).status,
    ).toBe('unsupported');
  });
  it.each([
    { active: false, visibility: 'PUBLIC', expected: 'not_found' },
    { active: true, visibility: 'PRIVATE', expected: 'not_found' },
    { active: undefined, visibility: 'PUBLIC', expected: 'unsupported' },
    { active: true, visibility: undefined, expected: 'unsupported' },
    { active: true, visibility: 'FUTURE_PUBLIC', expected: 'unsupported' },
  ])('does not manufacture currentness from $active / $visibility', async ({
    active,
    visibility,
    expected,
  }) => {
    const payload = { ...fixture(), active, visibility };
    expect(
      (
        await resolveSmartRecruitersPosting(
          url,
          fetchPayload(payload),
          plainText,
        )
      ).status,
    ).toBe(expected);
  });
  it('refuses a generic placeholder without a meaningful job description', async () => {
    const payload = fixture();
    payload.jobAd.sections.jobDescription.text = '<p>See careers.</p>';
    const result = await resolveSmartRecruitersPosting(
      url,
      fetchPayload(payload),
      plainText,
    );
    expect(result.status).toBe('unsupported');
    expect(result).not.toHaveProperty('descriptionRaw');
  });
  it('keeps missing optional fields and unknown employment types unknown', async () => {
    const payload = fixture() as Record<string, unknown>;
    payload.location = {};
    payload.typeOfEmployment = { label: 'Future type' };
    payload.releasedDate = 'invalid';
    const jobAd = payload.jobAd as { sections: Record<string, unknown> };
    delete jobAd.sections.qualifications;
    delete jobAd.sections.additionalInformation;
    const result = await resolveSmartRecruitersPosting(
      url,
      fetchPayload(payload),
      plainText,
    );
    expect(result).toMatchObject({
      status: 'resolved',
      locations: [],
      postedAt: null,
    });
    if (result.status !== 'resolved')
      throw new Error(
        'Expected known public body with optional metadata absent.',
      );
    expect(result.qualifications).toBeUndefined();
    expect(result.employmentType).toBeUndefined();
  });
  it.each([
    404, 410, 503,
  ])('handles upstream HTTP %s without fabricating a source body', async (status) => {
    const result = await resolveSmartRecruitersPosting(
      url,
      vi.fn(async () => new Response('', { status })),
      plainText,
    );
    expect(result.status).toBe(status === 503 ? 'unsupported' : 'not_found');
    expect(result).not.toHaveProperty('descriptionRaw');
  });
  it.each([
    'malformed',
    'network',
  ])('handles an upstream %s capture failure as unknown', async (failure) => {
    const fetchImpl = vi.fn(async () => {
      if (failure === 'network') throw new Error('Network unavailable');
      return new Response('{invalid', { status: 200 });
    });
    expect(
      (await resolveSmartRecruitersPosting(url, fetchImpl, plainText)).status,
    ).toBe('unsupported');
  });
});
