import type { PublicOpportunityDetail } from './public-opportunity-contract.js';
/** Structured metadata repeats posted facts only; no invented expiry or salary. */
export function publicJobPosting(
  opportunity: PublicOpportunityDetail,
  origin: string,
) {
  const salary = opportunity.compensation;
  const units: Record<string, string> = {
    hour: 'HOUR',
    day: 'DAY',
    week: 'WEEK',
    month: 'MONTH',
    year: 'YEAR',
  };
  const employment: Record<string, string> = {
    'full-time': 'FULL_TIME',
    'part-time': 'PART_TIME',
    contract: 'CONTRACTOR',
    contractor: 'CONTRACTOR',
    temporary: 'TEMPORARY',
    internship: 'INTERN',
  };
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: opportunity.title,
    description: opportunity.summary_bullets.join('\n'),
    url: new URL(opportunity.url, origin).href,
    ...(opportunity.posted_at ? { datePosted: opportunity.posted_at } : {}),
    ...(opportunity.expires_at ? { validThrough: opportunity.expires_at } : {}),
    ...(opportunity.company
      ? {
          hiringOrganization: {
            '@type': 'Organization',
            name: opportunity.company.name,
          },
        }
      : {}),
    ...(employment[opportunity.employment_type]
      ? { employmentType: employment[opportunity.employment_type] }
      : {}),
    ...(opportunity.location.remote === true
      ? {
          jobLocationType: 'TELECOMMUTE',
          applicantLocationRequirements: opportunity.location.countries.map(
            (name) => ({ '@type': 'Country', name }),
          ),
        }
      : opportunity.location.countries.length
        ? {
            jobLocation: opportunity.location.countries.map(
              (addressCountry) => ({
                '@type': 'Place',
                address: { '@type': 'PostalAddress', addressCountry },
              }),
            ),
          }
        : {}),
    ...(salary &&
    salary.currency &&
    units[salary.period] &&
    (salary.min !== null || salary.max !== null)
      ? {
          baseSalary: {
            '@type': 'MonetaryAmount',
            currency: salary.currency,
            value: {
              '@type': 'QuantitativeValue',
              unitText: units[salary.period],
              ...(salary.min !== null ? { minValue: salary.min } : {}),
              ...(salary.max !== null ? { maxValue: salary.max } : {}),
            },
          },
        }
      : {}),
  };
}
export function jsonLdScript(value: unknown) {
  return `<script type="application/ld+json">${JSON.stringify(value).replaceAll('<', '\\u003c')}</script>`;
}
