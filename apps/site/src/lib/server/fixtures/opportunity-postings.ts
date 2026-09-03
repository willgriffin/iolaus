export const repeatedBoilerplatePosting = `
Senior Platform Engineer
Apply now
Apply now
Privacy Policy
Location: Remote - Canada

Responsibilities
Build reliable distributed services.
Build reliable distributed services.
Own production operations.

Qualifications -
8+ years of backend engineering experience.
Strong TypeScript and PostgreSQL skills.

Compensation
CAD $180k - $220k per year
Benefits
Health coverage and four weeks vacation.
`;

export const malformedHeadingPosting = `
Staff Software Engineer
ABOUT THE ROLE
Help build a greenfield product for customers worldwide.
WHAT YOU'LL DO -
Design APIs and mentor engineers.
REQUIREMENTS —
10+ years software engineering experience.
Where you'll work:
Hybrid in Calgary, Alberta
`;

export const compensationLocationVariants = [
  {
    expected: { currency: 'USD', salaryMax: 190_000, salaryMin: 150_000 },
    text: 'Location: Remote (US)\nSalary: $150k–$190k per year',
  },
  {
    expected: { currency: 'CAD', hourlyMax: 110, hourlyMin: 90 },
    text: 'Work from Canada\nCompensation: CAD 90 - 110 per hour',
  },
  {
    expected: { currency: 'USD', salaryMax: 205_000, salaryMin: 160_000 },
    text: 'Remote in the United States\nPay range: $160,000 - $205,000 per year',
  },
] as const;

export function longPosting(sectionCount = 120): string {
  return Array.from({ length: sectionCount }, (_, index) =>
    [
      index % 2 === 0 ? 'Responsibilities' : 'Qualifications',
      `${index + 1}. ${'Detailed relevant posting content '.repeat(45)}`,
    ].join('\n'),
  ).join('\n');
}
