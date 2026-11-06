type Span = { start: number; end: number };
type QualificationContext = 'professional' | 'production' | null;
type Binding = { years: number | null; context: QualificationContext };
export type MatchingSourceStructurePart = Span &
  Binding & {
    text: string;
    unsupported: boolean;
  };
type StructureKey = 'whole' | 'explicit' | 'list-all' | 'list-any';
export type MatchingSourceStructure = {
  key: StructureKey;
  groups: MatchingSourceStructurePart[][];
};

const lead =
  /^(?:(?:requirements?|qualifications?|required(?: skills| experience| qualifications)?|preferred(?: skills| experience| qualifications)?|optional|nice[- ]to[- ]have)\s*:\s*)?(?:(?:(?:you|candidates?|applicants?)\s+)?(?:must (?:have|possess|demonstrate)|(?:should|need to) have|the role calls for)\s+)?/iu;
const ending =
  /\s+(?:(?:is|are)\s+)?(?:required|preferred|desirable|optional|a plus)(?: but not required)?[.!]?$/iu;
const separator =
  /[()]|,\s*(?:and|or)\b|[,;&]|\b(?:and|or|plus|as well as|along with)\b/giu;
const residual =
  /\b(?:without|unless|except|excluding|instead of|only|at most|up to|more than|less than|exactly|no|not|never|(?:at least )?(?:two|three|four|[2-9]) of|such as|including|for example|a combination of|work authori[sz]ation|citizenship|(?:security )?clearance|work permit|visa|licen[cs]e|background check|residency|degree|certification|fluency|relocat\w*|travel|on[- ]call|time ?zone|weekends?|working hours)\b|\be\.g\.|[<>/]|\band\s*\/\s*or\b/iu;
const yearsPattern = /\b(\d{1,2})\+?\s+years?\b/giu;
const contextPattern =
  /\b(professional|production)(?=\s+(?:hands-on\s+)?experience\b|[- ](?:level|grade)\b)|\bin (production)\b/giu;
const sharedPrefix =
  /^(?:(?:at least |minimum of )?\d{1,2}\+? years? (?:of )?)?(?:professional |production )?(?:hands-on )?experience (?:with|in|using|of) (?:either |one of )?/iu;
const innerChoicePrefix = /^(?:either |one of )/iu;

function trim(quote: string, { start, end }: Span): Span {
  const text = quote.slice(start, end);
  const begin = start + (text.length - text.trimStart().length);
  return { start: begin, end: Math.max(begin, start + text.trimEnd().length) };
}

function stripGroup(quote: string, span: Span) {
  if (quote[span.start] !== '(' || quote[span.end - 1] !== ')') return span;
  let depth = 0;
  for (let offset = span.start; offset < span.end - 1; offset += 1) {
    if (quote[offset] === '(') depth += 1;
    if (quote[offset] === ')') depth -= 1;
    if (depth === 0) return span;
  }
  return trim(quote, { start: span.start + 1, end: span.end - 1 });
}

function split(quote: string, span: Span) {
  const parts: Span[] = [];
  const joins: ('and' | 'or' | 'comma')[] = [];
  let depth = 0;
  let cursor = span.start;
  for (const match of quote.slice(span.start, span.end).matchAll(separator)) {
    const token = match[0].toLowerCase();
    if (token === '(') depth += 1;
    else if (token === ')') depth -= 1;
    else if (depth === 0) {
      const index = span.start + match.index;
      parts.push(trim(quote, { start: cursor, end: index }));
      joins.push(token === ',' ? 'comma' : token.endsWith('or') ? 'or' : 'and');
      cursor = index + token.length;
    }
    if (depth < 0) return null;
  }
  parts.push(trim(quote, { start: cursor, end: span.end }));
  if (
    depth !== 0 ||
    parts.some(({ start, end }) => start >= end) ||
    parts.length > 8
  )
    return null;
  return { parts, joins };
}

function connector(joins: ('and' | 'or' | 'comma')[]) {
  const seen = new Set(joins.filter((join) => join !== 'comma'));
  if (seen.size > 1 || (seen.size && joins.at(-1) === 'comma')) return 'mixed';
  if (seen.has('and')) return 'and';
  if (seen.has('or')) return 'or';
  return joins.length ? 'comma' : 'single';
}

function binding(text: string) {
  const durations = [...text.matchAll(yearsPattern)];
  const contexts = [...text.matchAll(contextPattern)];
  const years = durations[0]?.[1] ? Number(durations[0][1]) : null;
  const raw = (contexts[0]?.[1] ?? contexts[0]?.[2])?.toLowerCase();
  const context: QualificationContext =
    raw === 'professional' || raw === 'production' ? raw : null;
  const unsupported =
    durations.length > 1 ||
    contexts.length > 1 ||
    (years !== null && (years < 1 || years > 80)) ||
    [...text.matchAll(/\b(?:years?|months?|weeks?|decades?)\b/giu)].length !==
      durations.length ||
    /\b\d+(?:[.,]\d+|\s*(?:[-–—]|to)\s*\d+)\+?\s*years?\b/iu.test(text) ||
    residual.test(text);
  return {
    years: unsupported ? null : years,
    context: unsupported ? null : context,
    unsupported,
  };
}

function makeStructure(
  quote: string,
  key: StructureKey,
  spans: Span[][],
  shared: Binding | null,
): MatchingSourceStructure {
  const groups = spans.map((parts) =>
    parts.map((span) => {
      const text = quote.slice(span.start, span.end);
      const own = binding(text);
      return {
        ...span,
        text,
        years: own.years ?? shared?.years ?? null,
        context: own.context ?? shared?.context ?? null,
        unsupported:
          own.unsupported || Boolean(shared && (own.years || own.context)),
      };
    }),
  );
  if (
    groups.length > 1 &&
    groups.some((group) => group.some(({ years, context }) => years || context))
  ) {
    // An unqualified sibling after a qualified clause may share the prefix.
    // Never silently impose or drop that qualifier.
    const allIndependentlyQualified = groups.every((group) =>
      group.every(({ years, context }) => years || context),
    );
    if (!allIndependentlyQualified)
      for (const part of groups.flat()) part.unsupported = true;
  }
  if (
    !shared &&
    groups.some(
      (group) =>
        group.length > 1 &&
        group.some(({ years, context }) => years || context) &&
        group.some(({ years, context }) => !years && !context),
    )
  )
    for (const part of groups.flat()) part.unsupported = true;
  return { key, groups };
}

/** A small grammar for full-source candidate structures. Spans always index
 * the exact supplied quote, and no option can invent connective text. */
export function matchingSourceStructures(
  quote: string,
): MatchingSourceStructure[] {
  if (
    quote.length > 1_200 ||
    (/\.(?=\s)|\b(?:and\s*\/\s*or)\b/iu.test(quote) &&
      !/\be\.g\./iu.test(quote))
  )
    return [];
  const rawBody = trim(quote, {
    start: lead.exec(quote)?.[0].length ?? 0,
    end: quote.length,
  });
  const endingMatch = ending.exec(quote.slice(rawBody.start, rawBody.end));
  const end = endingMatch
    ? rawBody.start + endingMatch.index
    : rawBody.end -
      (/[.!]$/u.test(quote.slice(rawBody.start, rawBody.end)) ? 1 : 0);
  const body = trim(quote, { start: rawBody.start, end });
  if (body.start >= body.end) return [];
  if (
    endingMatch &&
    /\b(?:preferred|optional|a plus|desirable)\b/iu.test(endingMatch[0]) &&
    /\b(?:must|required|mandatory)\b/iu.test(quote.slice(0, body.start))
  )
    return [];
  const bodyText = quote.slice(body.start, body.end);
  // No single-strength ledger entry can represent embedded mandatory and
  // optional conditions on the same line.
  if (
    /\b(?:must|required|mandatory|optional|preferred|desirable|nice[- ]to[- ]have)\b/iu.test(
      bodyText,
    )
  )
    return [];

  const prefix = sharedPrefix.exec(bodyText)?.[0] ?? '';
  const scoped = prefix ? binding(prefix) : null;
  const hasShared =
    scoped && !scoped.unsupported && Boolean(scoped.years || scoped.context);
  const structureStart =
    body.start +
    (prefix.length || (innerChoicePrefix.exec(bodyText)?.[0].length ?? 0));
  const payload = stripGroup(
    quote,
    trim(quote, { start: structureStart, end: body.end }),
  );
  const top = split(quote, payload);
  if (!top) return [];
  const kind = connector(top.joins);
  if (kind === 'mixed') return [];
  const explicitlySeparate = Boolean(
    hasShared &&
      kind !== 'comma' &&
      top.parts.length > 1 &&
      top.parts.slice(1).every(({ start, end }) => {
        const own = binding(quote.slice(start, end));
        return !own.unsupported && (own.years || own.context);
      }),
  );
  if (explicitlySeparate) {
    const first = top.parts[0];
    if (!first || quote.slice(first.start, first.end).includes('(')) return [];
    top.parts[0] = { ...first, start: body.start };
  }
  const shared = hasShared && !explicitlySeparate ? scoped : null;
  if (kind === 'single') {
    if (/\b(?:either|one of)\b/iu.test(bodyText)) return [];
    return [makeStructure(quote, 'whole', [[body]], null)];
  }

  if (kind === 'or' || kind === 'comma') {
    if (
      top.parts.some(
        (part) => split(quote, stripGroup(quote, part))?.joins.length,
      )
    )
      return [];
    const alternatives = top.parts.map((part) => stripGroup(quote, part));
    const any = makeStructure(
      quote,
      kind === 'or' ? 'explicit' : 'list-any',
      [alternatives],
      shared,
    );
    if (kind === 'or') return [any];
    const all = makeStructure(
      quote,
      'list-all',
      alternatives.map((part) => [part]),
      shared,
    );
    if (shared) for (const part of all.groups.flat()) part.unsupported = true;
    // An ordinary comma may be prose within one action, rather than Boolean
    // punctuation. Typed review can select the whole scoped phrase.
    const whole = makeStructure(quote, 'whole', [[body]], null);
    return [whole, all, any];
  }

  const groups: Span[][] = [];
  for (const part of top.parts) {
    const inner = split(quote, stripGroup(quote, part));
    if (!inner) return [];
    const mode = connector(inner.joins);
    if (mode !== 'single' && mode !== 'or') return [];
    groups.push(inner.parts);
  }
  const explicit = makeStructure(quote, 'explicit', groups, shared);
  if (shared)
    for (const part of explicit.groups.flat()) part.unsupported = true;
  return [explicit];
}

export function matchingSourceStructureMatches(
  quote: string,
  key: string,
  groups: readonly { alternatives: readonly Binding[] }[],
): boolean {
  const variant = matchingSourceStructures(quote).find(
    (item) => item.key === key,
  );
  return Boolean(
    variant &&
      variant.groups.length === groups.length &&
      variant.groups.every(
        (parts, group) =>
          parts.length === groups[group]?.alternatives.length &&
          parts.every(({ years, context, unsupported }, alternative) => {
            const atom = groups[group]?.alternatives[alternative];
            return (
              !unsupported && atom?.years === years && atom.context === context
            );
          }),
      ),
  );
}
