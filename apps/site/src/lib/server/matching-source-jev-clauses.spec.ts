import { describe, expect, it } from 'vitest';
import { matchingSourceJevClauseSpans } from './matching-source-jev-clauses.js';

it('keeps exact role-overview and explicit qualifications available for independent phase review', () => {
  const description =
    'We’re looking for a full-stack engineer authorized to work in Canada. You’ll work with the platform lead and maintain internal services.';
  expect(
    matchingSourceJevClauseSpans(description).map(({ quote }) => quote),
  ).toEqual([
    'We’re looking for a full-stack engineer authorized to work in Canada',
    'You’ll work with the platform lead and maintain internal services.',
  ]);
});

describe('JEV exact mixed-clause candidates', () => {
  it.each([
    [
      'Architect reliable, performant backends and APIs; familiarity with AWS (Lambda, ECS/Fargate, API Gateway, RDS/DynamoDB, S3, CloudFront, Cognito, etc.) is important. AWS Bedrock and AWS CloudTrail experience is a plus.',
      [
        'Architect reliable, performant backends and APIs',
        'familiarity with AWS (Lambda, ECS/Fargate, API Gateway, RDS/DynamoDB, S3, CloudFront, Cognito, etc.) is important',
        'AWS Bedrock and AWS CloudTrail experience is a plus.',
      ],
    ],
    [
      'Implement logging, monitor performance, and ship production-quality code. Datadog and Sentry experience is a plus.',
      [
        'Implement logging, monitor performance, and ship production-quality code',
        'Datadog and Sentry experience is a plus.',
      ],
    ],
    [
      'TypeScript is required; familiarity with Go is optional.',
      ['TypeScript is required', 'familiarity with Go is optional.'],
    ],
    [
      'Build and maintain APIs; Candidates must be authorized to work in Canada. No visa sponsorship.',
      [
        'Build and maintain APIs',
        'Candidates must be authorized to work in Canada',
        'No visa sponsorship.',
      ],
    ],
    [
      'Three years of React experience are required; Go is preferred.',
      ['Three years of React experience are required', 'Go is preferred.'],
    ],
  ])('keeps exact, ordered and complete mixed clause slices: %s', (input, expected) => {
    const spans = matchingSourceJevClauseSpans(input);
    expect(spans.map(({ quote }) => quote)).toEqual(expected);
    for (const [index, span] of spans.entries()) {
      expect(input.slice(span.start, span.end)).toBe(span.quote);
      const next = spans[index + 1];
      if (next) {
        expect(next.start).toBeGreaterThan(span.end);
        expect(input.slice(span.end, next.start)).toMatch(/^[.;]\s*$/u);
      }
    }
  });

  it('preserves nested examples, quotes, abbreviations, decimals and qualified tool names', () => {
    const first =
      'Build the v2.1 Node.js API, e.g. use U.S. dates (see [schema {examples: "a; b. Example"}])';
    const second =
      'Experience with the “Run. Jump; Return” feature is preferred.';
    const input = `${first}. ${second}`;
    const spans = matchingSourceJevClauseSpans(input);
    expect(spans.map(({ quote }) => quote)).toEqual([first, second]);
    expect(spans[1]?.start).toBe(first.length + 2);
  });

  it('reports UTF-16 offsets without accepting malformed Unicode', () => {
    const first = 'Build a 🚀 status badge';
    const second = 'Knowledge of alerting is preferred.';
    const input = `${first}; ${second}`;
    const spans = matchingSourceJevClauseSpans(input);
    expect(spans[1]).toEqual({
      start: first.length + 2,
      end: input.length,
      quote: second,
    });
    expect(spans[1]?.start).not.toBe([...first].length + 2);
    expect(
      spans
        .slice()
        .reverse()
        .map(({ start }) => start),
    ).not.toEqual(spans.map(({ start }) => start));
    expect(
      matchingSourceJevClauseSpans(
        'Build a \ud800 badge; Knowledge of alerting is preferred.',
      ),
    ).toEqual([]);
  });

  it.each([
    'Experience with either Python; Go is required.',
    'Python is required; or Go is sufficient.',
    'Experience with Python or; Go is required.',
    'Python is required; unless Go is available.',
    'Python is required unless you know Go; AWS experience is optional.',
    'You must work onsite; except during holidays.',
    'Do not use Python; Go is required.',
    'Build APIs; not Ruby.',
    '3 years of Python experience; Go experience.',
    'Three years of Python experience; Go experience.',
    'Python is required; alternatively, Go is accepted.',
    'Python is required; Go is accepted as an alternative.',
    'Python is required; only in production is it necessary.',
    'At least 3 years of experience with: Python; Go is required.',
    'Experience with Python; in production.',
    'Build APIs; including a public SDK.',
    'Build APIs; for use by candidates only.',
    'Build APIs; ; Go is optional.',
    '; Build APIs; Go is optional.',
    'Build APIs; Go is optional;',
    'Build APIs (including SDK; Go is optional.',
    'Build APIs [with {nested] braces}; Go is optional.',
    'Build APIs “with examples; Go is optional.',
    'Build APIs "with examples; Go is optional.',
    'Build APIs. lower-case fragment; Go is optional.',
    'Build APIs? Go is optional; AWS is optional.',
    'Build APIs... Go is optional.',
    'Build APIs; Go is optional; AWS is optional; Cloudflare is optional; Sentry is optional.',
    'Build APIs without new context.',
    `Build ${'🚀'.repeat(225)}; Go is optional.`,
  ])('refuses incomplete, coupled, malformed, or overbound splits: %s', (input) => {
    expect(matchingSourceJevClauseSpans(input)).toEqual([]);
  });
});
