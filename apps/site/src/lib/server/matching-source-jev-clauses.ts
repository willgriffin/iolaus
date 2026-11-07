type ClauseSpan = { start: number; end: number; quote: string };

const maxBytes = 900;
const maxClauses = 4;
const closing = { '(': ')', '[': ']', '{': '}' } as const;
const abbreviation =
  /(?:\b(?:e\.g|i\.e|etc|vs|viz|cf|approx|dept|est|inc|ltd|corp|co|mr|mrs|ms|dr|sr|jr|prof|st|no|fig|ref|vol)\.|(?:\b[\p{L}]\.){2,}|\b[\p{Lu}]\.)$/iu;
const leadingCoupling =
  /^(?:and|or|nor|but|unless|except|without|only (?:if|in|when|for)|provided(?: that)?|subject to|depending on|as well as|along with|together with|instead of|alternatively|otherwise|not|never|including|such as|for example|e\.g\.|i\.e\.|with|of|for|to|in (?:production|practice)|under (?:the|these))(?=\s|[,.:;]|$)/iu;
const trailingCoupling =
  /\b(?:and|or|nor|but|unless|except|without|not|including|such as|for example|because|provided(?: that)?|subject to|depending on|with|of|for|to|in|using)\s*[,.:]?$/iu;
const conditional =
  /\b(?:unless|provided that|except (?:for|when|if)|subject to|only if|depending on|as an alternative|alternative to|in lieu of)\b/iu;
const negatedLead =
  /^(?:not|never|neither|do not|don['’]t|no longer|no need)\b/iu;
const sharedScope =
  /\b(?:(?:\d{1,2}\+?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:years?|months?|weeks?)|(?:professional|commercial|production)\s+(?:experience|use|work)|in production|at least\s+\d|no fewer than)\b/iu;
const closedStrength =
  /\b(?:(?:is|are|will be)\s+(?:required|mandatory|preferred|optional|important)|(?:is|are)\s+(?:not required|a plus|nice to have))\s*\.?$/iu;
const startsIndependent =
  /^(?:we(?:['’]re| are) looking for\b|you['’]ll (?:work|report|join|build|lead|support|collaborate)\b|(?:you|candidates?|applicants?|employees?)\s+(?:must|should|will|need to|are required to)\b|(?:required|preferred|optional|mandatory)\s*[:：]|(?:build|design|architect|implement|develop|operate|maintain|create|deliver|monitor|improve|write|ship|work|support|ensure|participate|lead|manage|collaborate|own|document|test)\b|no (?:visa )?sponsorship\b)/iu;
const conditionWords =
  /\b(?:is|are|has|have|must|should|will|need|requires?|required|mandatory|preferred|optional|experience|familiarity|proficiency|expertise|knowledge|work authori[sz]ation|visa sponsorship|background checks?|security clearance)\b/iu;

function spansAt(quote: string, boundaries: number[]) {
  const spans: ClauseSpan[] = [];
  let from = 0;
  for (const until of [...boundaries, quote.length]) {
    const raw = quote.slice(from, until);
    const start = from + raw.length - raw.trimStart().length;
    const end = from + raw.trimEnd().length;
    if (start >= end) return [];
    spans.push({ start, end, quote: quote.slice(start, end) });
    from = until + 1;
  }
  return spans;
}

function independentClauses(
  quote: string,
  visible: string,
  boundaries: number[],
) {
  const spans = spansAt(quote, boundaries);
  if (spans.length < 2) return [];
  const parts = spans.map(({ start, end }) => visible.slice(start, end).trim());
  if (
    parts.some(
      (part) =>
        !/[\p{L}\p{N}]/u.test(part) ||
        leadingCoupling.test(part) ||
        trailingCoupling.test(part) ||
        conditional.test(part) ||
        negatedLead.test(part) ||
        /[:：,]$/u.test(part) ||
        (/\b(?:either|one or more of|one of)\b/iu.test(part) &&
          !/\b(?:either|one or more of|one of)\b.+\bor\b/iu.test(part)) ||
        (!startsIndependent.test(part) && !conditionWords.test(part)),
    )
  )
    return [];
  if (
    parts.slice(0, -1).some((part, index) => {
      const next = parts[index + 1] ?? '';
      return (
        sharedScope.test(part) &&
        !closedStrength.test(part) &&
        !startsIndependent.test(next)
      );
    })
  )
    return [];
  return spans;
}

/** Exact UTF-16 spans from an independently bounded candidate split.
 * Delimiters between spans stay in the original unit, outside both spans. */
export function matchingSourceJevClauseSpans(quote: string): ClauseSpan[] {
  if (
    Buffer.byteLength(quote, 'utf8') > maxBytes ||
    /[\r\n\uD800-\uDFFF]|<[^<>]+>/u.test(quote)
  )
    return [];
  const visible = quote.split('');
  const boundaries: number[] = [];
  const stack: string[] = [];
  let doubleQuote: '"' | '”' | undefined;
  for (let index = 0; index < quote.length; index += 1) {
    const char = quote[index] ?? '';
    if (doubleQuote) {
      visible[index] = ' ';
      if (char === '\\' && doubleQuote === '"') {
        index += 1;
        visible[index] = ' ';
      } else if (char === doubleQuote) doubleQuote = undefined;
      continue;
    }
    if (char === '"' || char === '“') {
      doubleQuote = char === '"' ? '"' : '”';
      visible[index] = ' ';
      continue;
    }
    if (char === '”') return [];
    if (char === '(' || char === '[' || char === '{') {
      stack.push(closing[char]);
      visible[index] = ' ';
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) return [];
      visible[index] = ' ';
      continue;
    }
    if (stack.length) {
      visible[index] = ' ';
      continue;
    }
    if (char === ';') {
      boundaries.push(index);
    } else if (
      char === '.' &&
      /^\s+[\p{L}\p{N}“"]/u.test(quote.slice(index + 1)) &&
      !abbreviation.test(quote.slice(0, index + 1))
    ) {
      if (
        quote[index - 1] === '.' ||
        !/^\s+[\p{Lu}\p{N}“"]/u.test(quote.slice(index + 1))
      )
        return [];
      boundaries.push(index);
    } else if (
      (char === '?' || char === '!') &&
      /^\s+\S/u.test(quote.slice(index + 1))
    ) {
      return [];
    }
    if (boundaries.length >= maxClauses) return [];
  }
  return stack.length || doubleQuote
    ? []
    : independentClauses(quote, visible.join(''), boundaries);
}
