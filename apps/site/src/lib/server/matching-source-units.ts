import type { MatchingSourceText } from './matching-source-extraction-contract.js';

export const MATCHING_SOURCE_DESCRIPTION_LIMIT = 40_000;

export const hasAnalysisPII = (text: string): boolean =>
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\s().-]*){9,}/i.test(text);

/** Segment captured text without changing offsets into its raw source. */
export function matchingDescriptionUnits(raw: string) {
  const masked = raw
    .slice(0, MATCHING_SOURCE_DESCRIPTION_LIMIT)
    .replace(
      /<[^<>\n]+>/gu,
      (tag) =>
        (/^<\/?(?:p|li|div|h[1-6]|section|ul|ol|br)\b/iu.test(tag)
          ? '\n'
          : ' ') + ' '.repeat(tag.length - 1),
    )
    .replace(/&nbsp;/gu, ' '.repeat(6));
  const units: Array<{
    text: string;
    start: number;
    end: number;
    quote: string;
  }> = [];
  for (const match of masked.matchAll(/[^\r\n]+/gu)) {
    const full = match[0];
    const text = full.replace(/^\s*(?:[-*•]\s+)?/u, '').trimEnd();
    if (!text) continue;
    const start = match.index + full.indexOf(text);
    const end = start + text.length;
    units.push({ text, start, end, quote: raw.slice(start, end) });
  }
  return units;
}

export const MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT = 200;

/** Public captured source only. IDs and offsets belong to the host. */
export function matchingSourceSemanticUnits(source: MatchingSourceText) {
  const units = [
    ...(source.title.trim()
      ? [
          {
            id: 'title',
            field: 'title' as const,
            quote: source.title,
            start: 0,
            end: source.title.length,
          },
        ]
      : []),
    ...(source.location.trim()
      ? [
          {
            id: 'location',
            field: 'location' as const,
            quote: source.location,
            start: 0,
            end: source.location.length,
          },
        ]
      : []),
    ...matchingDescriptionUnits(source.description).map(
      ({ quote, start, end }, index) => ({
        id: `d${index + 1}`,
        field: 'description' as const,
        quote,
        start,
        end,
      }),
    ),
  ];
  if (
    source.description.length > MATCHING_SOURCE_DESCRIPTION_LIMIT ||
    !units.some(({ field }) => field === 'description') ||
    units.length > MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT
  )
    throw new Error(
      'Public source exceeds the semantic interpretation bounds.',
    );
  return units;
}
