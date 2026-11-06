import type { MatchingSourceText } from './matching-source-extraction-contract.js';
import {
  matchingDescriptionUnits,
  matchingSourceSemanticUnits,
} from './matching-source-units.js';
import {
  matchingSourceContextLabel,
  type matchingSourceSectionHints,
} from './normalized-matching.js';

type SourceUnit = ReturnType<typeof matchingSourceSemanticUnits>[number];
type Block = {
  anchorId: string;
  unitIds: string[];
  kind: 'requirement' | 'preferred';
  operator: 'all' | 'any';
};

type PlainItem = {
  format: 'plain';
  marker: string;
  indent: number;
  line: number;
};
type HtmlItem = {
  format: 'html';
  item: number;
  list: number;
  parentItem: number | undefined;
  ancestors: number[];
};
type Item = PlainItem | HtmlItem;

const anchorEnd =
  /(?:^|\s)(one(?: or more)? of|at least one of|any(?: one)? of|all of|each of|both of)(?: the following)?\s*[:：]$/iu;
const capability =
  /\b(?:experience|expertise|knowledge|proficiency|skills?|capabilit(?:y|ies)|familiarity|qualifications?|must (?:have|demonstrate|possess)|(?:should|need to) have|preferred)\b/iu;
const hard = /\b(?:must|required|mandatory|non[- ]negotiable|need to have)\b/iu;
const optional =
  /\b(?:preferred|optional|desirable|nice[- ]to[- ]have|a plus|not required)\b/iu;
const eligibility =
  /\b(?:work authori[sz]ation|right to work|citizenship|residency|residen(?:t|ce)|visa|sponsor(?:ship|ed)?|(?:security )?clearance|work permit|background check|(?:driver.s|professional) licen[cs]e|degree|diploma|certification|minimum age|located in|based in|relocat\w*|travel|weekends?|on[- ]call|time ?zone|working hours|business hours)\b/iu;
const unsupportedScope =
  /\b(?:without|unless|except|excluding|instead of|exactly|at most|up to|less than|more than|none|not|never|no|such as|including|for example)\b|\be\.g\.|\band\s*\/\s*or\b/iu;
const quantifiedAnchor =
  /\b(?:\d+\+?\s*(?:months?|weeks?|years?)|professional|production|certif\w*|fluen\w*)\b/iu;
const unrelated =
  /^(?:we (?:are|offer|provide|build|welcome)|you(?: will|[’']ll)|apply|submit|salary|benefits|compensation|job location|(?:fully )?remote (?:in|within|from))\b/iu;
const nestedCondition =
  /\b(?:either|both|one or more of|one of|at least one of|any one of|all of|each of)\b|\([^()]*\b(?:and|or)\b[^()]*\)|(?:[,;]|\b(?:and|or|but|while)\b)\s+(?:(?:at least |minimum of )?\d+\+?\s*(?:years?|months?)|(?:proven |prior |hands-on )?(?:experience|expertise|familiarity|proficiency|knowledge)\b)/iu;
const independentQualification =
  /^(?:(?:demonstrated|proven|strong|deep|solid|significant|extensive|prior|hands-on|practical|working|excellent|good|sound)\s+)*(?:experience|expertise|ability|understanding|knowledge|familiarity|proficiency|track record)\s+(?:with|in|of|to|building|designing|leading|working|developing|managing|delivering|operating|implementing)\b/iu;
const proseAlternative =
  /^(?:build|design|develop|operate|deliver|manage|lead|create|maintain|implement|work|support|provide|understand)\s|\b(?:applicants?|candidates?|you)\s+(?:have|bring|need|will|should|are)\b|\b\d+\+?\s*(?:months?|weeks?|years?)\b/iu;
const blockMarkup = /<(?:script|style|template)\b|<!--/iu;
const maxItems = 8;

function lineStart(raw: string, offset: number) {
  return (
    Math.max(
      raw.lastIndexOf('\n', offset - 1),
      raw.lastIndexOf('\r', offset - 1),
    ) + 1
  );
}

function indentWidth(indentation: string) {
  return indentation.replace(/\t/gu, '    ').length;
}

function plainItem(raw: string, unit: SourceUnit): PlainItem | undefined {
  const line = lineStart(raw, unit.start);
  const prefix = /^([ \t]*)([-*+•]|\d{1,2}[.)])[ \t]+(?=\S)/u.exec(
    raw.slice(line, unit.end),
  );
  if (!prefix) return undefined;
  const indentation = prefix[1] ?? '';
  const marker = prefix[2] ?? '';
  // For markers the source splitter leaves in the unit, the unit begins at
  // the marker itself. A second unit on the same physical line is not an item.
  if (
    unit.start !== line + prefix[0].length &&
    unit.start !== line + indentation.length
  )
    return undefined;
  return {
    format: 'plain',
    marker: marker.length > 1 ? (marker.at(-1) ?? '') : marker,
    indent: indentWidth(indentation),
    line,
  };
}

function htmlItems(raw: string, units: SourceUnit[]) {
  type Frame = { tag: 'ul' | 'ol' | 'li'; start: number };
  const marks = new Map<string, HtmlItem>();
  const tokens = raw.matchAll(/<(\/?)(ul|ol|li)\b[^<>]*>/giu);
  const stack: Frame[] = [];
  let next = tokens.next();
  for (const unit of units) {
    while (!next.done && next.value.index < unit.start) {
      const { index } = next.value;
      const tag = next.value[2]?.toLowerCase() as Frame['tag'];
      if (next.value[1]) {
        const open = stack.findLastIndex((frame) => frame.tag === tag);
        if (open >= 0) stack.length = open;
      } else {
        if (tag === 'li' && stack.at(-1)?.tag === 'li') stack.pop();
        stack.push({ tag, start: index });
      }
      next = tokens.next();
    }
    const item = stack.at(-1);
    const list = stack.at(-2);
    if (item?.tag !== 'li' || (list?.tag !== 'ul' && list?.tag !== 'ol'))
      continue;
    const parent = stack.at(-3);
    marks.set(unit.id, {
      format: 'html',
      item: item.start,
      list: list.start,
      parentItem: parent?.tag === 'li' ? parent.start : undefined,
      ancestors: stack
        .slice(0, -2)
        .flatMap(({ tag, start }) => (tag === 'li' ? [] : [start])),
    });
  }
  return marks;
}

function opensList(
  raw: string,
  anchor: SourceUnit,
  own: Item | undefined,
  first: Item,
) {
  if (first.format === 'html') {
    if (own?.format === 'plain' || first.list < anchor.end) return false;
    if (first.parentItem !== (own?.format === 'html' ? own.item : undefined))
      return false;
    // Only markup and whitespace may intervene before the explicit list.
    return !raw
      .slice(anchor.end, first.list)
      .replace(/<[^<>]+>/gu, '')
      .trim();
  }
  if (own?.format === 'html') return false;
  return (
    first.line >= anchor.end &&
    (!own || first.indent > own.indent) &&
    /^\s*$/u.test(raw.slice(anchor.end, first.line))
  );
}

function listRelation(
  raw: string,
  first: Item,
  last: SourceUnit,
  current: Item,
) {
  if (first.format === 'html' && current.format === 'html') {
    if (current.list === first.list) return 'same';
    return current.ancestors.includes(first.list) ? 'nested' : 'outside';
  }
  if (first.format !== 'plain' || current.format !== 'plain') return 'outside';
  if (current.indent < first.indent) return 'outside';
  if (current.indent > first.indent) return 'nested';
  if (current.marker !== first.marker) return 'outside';
  return current.line >= last.end &&
    /^[ \t]*(?:\r\n|\r|\n)$/u.test(raw.slice(last.end, current.line))
    ? 'same'
    : 'ambiguous';
}

function flattenedPeer(
  raw: string,
  anchor: PlainItem,
  previous: SourceUnit,
  candidate: Item | undefined,
) {
  return (
    candidate?.format === 'plain' &&
    candidate.indent === anchor.indent &&
    candidate.marker === anchor.marker &&
    candidate.line >= previous.end &&
    /^[ \t]*(?:(?:\r\n|\r|\n)[ \t]*){1,3}$/u.test(
      raw.slice(previous.end, candidate.line),
    )
  );
}

function unsafeClause(text: string) {
  return (
    !text ||
    eligibility.test(text) ||
    unrelated.test(text) ||
    hard.test(text) ||
    optional.test(text) ||
    unsupportedScope.test(text)
  );
}

function blockOperator(text: string, kind: Block['kind']) {
  const bare = text.replace(/^\*\*(.*?)\*\*$/u, '$1').trim();
  const match = anchorEnd.exec(bare);
  if (!match || bare.length > 240) return null;
  const prefix = bare.slice(0, match.index).trim();
  if (
    (prefix && !capability.test(prefix)) ||
    /[.;]/u.test(prefix) ||
    eligibility.test(prefix) ||
    unsupportedScope.test(prefix) ||
    quantifiedAnchor.test(prefix) ||
    (kind === 'requirement' ? optional.test(prefix) : hard.test(prefix))
  )
    return null;
  const phrase = match[1]?.toLowerCase();
  return {
    operator:
      phrase === 'all of' || phrase === 'each of' || phrase === 'both of'
        ? ('all' as const)
        : ('any' as const),
    exactlyTwo: phrase === 'both of',
  };
}

function isPlainContinuation(
  raw: string,
  item: Item,
  previous: SourceUnit,
  next: SourceUnit,
) {
  if (item.format !== 'plain') return false;
  const start = lineStart(raw, next.start);
  if (start === lineStart(raw, previous.start)) return true;
  return (
    start >= previous.end &&
    /^[ \t]*(?:\r\n|\r|\n)$/u.test(raw.slice(previous.end, start)) &&
    indentWidth(raw.slice(start, next.start)) > item.indent &&
    /^[ \t]+$/u.test(raw.slice(start, next.start))
  );
}

/** Discover explicit list scopes while retaining the host's exact unit IDs.
 * Unmarked text and an unsafe sibling remain available for independent review. */
export function matchingSourceJevBlocks(
  source: MatchingSourceText,
  hints: Readonly<ReturnType<typeof matchingSourceSectionHints>>,
): Block[] {
  const raw = source.description;
  if (blockMarkup.test(raw)) return [];
  let units: SourceUnit[];
  try {
    units = matchingSourceSemanticUnits(source).filter(
      ({ field }) => field === 'description',
    );
  } catch {
    return [];
  }
  const visible = new Map(
    matchingDescriptionUnits(raw).map(({ start, text }) => [start, text]),
  );
  const html = htmlItems(raw, units);
  const items = units.map((unit) => html.get(unit.id) ?? plainItem(raw, unit));
  const blocks: Block[] = [];
  for (let index = 0; index < units.length - 2; index += 1) {
    const anchor = units[index];
    const first = items[index + 1];
    if (!anchor || !first) continue;
    const hint = hints.get(anchor.start);
    const kind =
      hint?.sectionHint === 'required'
        ? 'requirement'
        : hint?.sectionHint === 'preferred'
          ? 'preferred'
          : null;
    if (!hint || !kind) continue;
    const operation = blockOperator(visible.get(anchor.start) ?? '', kind);
    if (!operation) continue;
    const own = items[index];
    const flattened =
      own?.format === 'plain' && flattenedPeer(raw, own, anchor, first)
        ? own
        : null;
    if (!flattened && !opensList(raw, anchor, own, first)) continue;

    const unitIds = [anchor.id];
    let previous = anchor;
    const htmlItemsSeen = new Set<number>();
    let unsafe = false;
    let closed = false;
    for (
      let childIndex = index + 1;
      childIndex < units.length;
      childIndex += 1
    ) {
      const child = units[childIndex];
      const item = items[childIndex];
      if (!child) break;
      const text = visible.get(child.start) ?? '';
      const childHint = hints.get(child.start);
      if (flattened) {
        if (
          childHint?.sectionHeading ||
          matchingSourceContextLabel({
            field: 'description',
            start: child.start,
            end: child.end,
            text,
          }) ||
          /^#{1,6}\s+[^#]/u.test(text)
        ) {
          closed = true;
          break;
        }
        if (
          childHint?.governingHeading.start !== hint.governingHeading.start ||
          !flattenedPeer(raw, flattened, previous, item) ||
          unsafeClause(text)
        )
          break;
        const wording = text.replace(/^\*\*(.*?)\*\*$/u, '$1');
        if (independentQualification.test(wording)) {
          closed = true;
          break;
        }
        if (
          text.length > 180 ||
          unitIds.length > maxItems ||
          proseAlternative.test(wording) ||
          nestedCondition.test(text) ||
          /[:：;!?]|\.(?=\s+\S)/u.test(text)
        )
          break;
        unitIds.push(child.id);
        previous = child;
        continue;
      }
      if (!item) {
        unsafe = isPlainContinuation(raw, first, previous, child);
        break;
      }
      const relation =
        childIndex === index + 1
          ? 'same'
          : listRelation(raw, first, previous, item);
      if (relation === 'outside') break;
      if (
        relation === 'nested' ||
        (item.format === 'html' && htmlItemsSeen.has(item.item))
      ) {
        unsafe = true;
        break;
      }
      if (
        childHint?.governingHeading.start !== hint.governingHeading.start ||
        childHint?.sectionHeading
      )
        break;
      const startsHeading =
        item.format === 'html' &&
        /<h[1-6]\b/iu.test(raw.slice(item.item, child.start));
      if (startsHeading || /(?:[:：]\s*$|^#{1,6}\s)/u.test(text)) break;
      if (
        relation !== 'same' ||
        unitIds.length > maxItems ||
        unsafeClause(text) ||
        nestedCondition.test(text) ||
        /\.(?=\s+\S)|[;!?]/u.test(text)
      ) {
        unsafe = true;
        break;
      }
      if (item.format === 'html') htmlItemsSeen.add(item.item);
      unitIds.push(child.id);
      previous = child;
    }
    if (
      unsafe ||
      (flattened && !closed) ||
      unitIds.length < 3 ||
      (operation.exactlyTwo && unitIds.length !== 3)
    )
      continue;
    blocks.push({
      anchorId: anchor.id,
      unitIds,
      kind,
      operator: operation.operator,
    });
    index += unitIds.length - 1;
  }
  return blocks;
}
