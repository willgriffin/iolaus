import { createHash } from 'node:crypto';
import type { OpportunityAnalysisSnapshot } from '$lib/opportunity-analysis-contract.js';
import { OPPORTUNITY_ANALYSIS_VERSION } from '$lib/opportunity-analysis-contract.js';
import {
  fingerprintOpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';
import {
  canonicalSkillSlug,
  SKILL_VOCABULARY_SEED_TERMS,
  skillLabelFromSlug,
} from './skill-vocabulary.js';

/** Bumped independently from the pinned public analysis contract when the
 * deterministic extractor changes. This makes incomplete snapshots refresh
 * without changing the public projection shape. */
export const DETERMINISTIC_SKILLS_PROMPT_VERSION = 'deterministic-skills/v2';

type ExtractedSkill = {
  slug: string;
  label: string;
  start: number;
  end: number;
  quote: string;
};

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = '[\\p{L}\\p{N}]';
const unsafeAliases = new Set(['go', 'js', 'ts']);

/** Replace markup, URLs, and non-visible script/style payloads while keeping
 * offsets identical to the canonical source string. */
function visibleDescriptionMask(description: string): string {
  const chars = description.split('');
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) chars[index] = ' ';
  };
  for (const match of description.matchAll(
    /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<[^>]*>/gi,
  ))
    mask(match.index ?? 0, (match.index ?? 0) + match[0].length);
  for (const match of description.matchAll(/(?:https?:\/\/|www\.)[^\s<>'"]+/gi))
    mask(match.index ?? 0, (match.index ?? 0) + match[0].length);
  return chars.join('');
}

function skillAliases(): Array<{ slug: string; label: string; alias: string }> {
  const aliases = new Map<
    string,
    { slug: string; label: string; alias: string }
  >();
  for (const term of SKILL_VOCABULARY_SEED_TERMS) {
    for (const alias of new Set([term.label, ...term.aliases])) {
      const trimmed = alias.trim();
      const normalized = trimmed.toLocaleLowerCase();
      // Short abbreviations and `go` are ordinary prose in job descriptions.
      // They remain discoverable when the source uses an unambiguous label.
      if (!trimmed || unsafeAliases.has(normalized)) continue;
      const key = `${term.slug}:${normalized}`;
      aliases.set(key, { slug: term.slug, label: term.label, alias: trimmed });
    }
  }
  return [...aliases.values()].sort(
    (left, right) =>
      right.alias.length - left.alias.length ||
      left.alias.localeCompare(right.alias),
  );
}

const catalogAliases = skillAliases();

/** Extract exact catalog terms from canonical visible posting text. Candidates
 * are selected longest-first at each source position, then never overlap. */
export function extractCatalogSkills(description: string): ExtractedSkill[] {
  const visible = visibleDescriptionMask(description);
  const candidates: ExtractedSkill[] = [];
  for (const { slug, label, alias } of catalogAliases) {
    const expression = new RegExp(
      `(?<!${word})${escaped(alias)}(?!${word})`,
      'giu',
    );
    for (const match of visible.matchAll(expression)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (negatedSkillEvidence(visible, start, end)) continue;
      candidates.push({
        slug,
        label,
        start,
        end,
        quote: description.slice(start, end),
      });
    }
  }
  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      right.end - right.start - (left.end - left.start) ||
      left.slug.localeCompare(right.slug),
  );
  const selected: ExtractedSkill[] = [];
  for (const candidate of candidates) {
    if (
      selected.some(
        (skill) => candidate.start < skill.end && candidate.end > skill.start,
      )
    )
      continue;
    // Multiple aliases may establish a canonical capability. Keep the first
    // source citation, which is deterministic after the stable ordering above.
    if (selected.some((skill) => skill.slug === candidate.slug)) continue;
    selected.push(candidate);
  }
  return selected;
}

function structuredSkills(
  value: unknown,
): Array<{ slug: string; term: string }> {
  const skills = new Map<string, { slug: string; term: string }>();
  for (const term of sourceText(value)
    .split(/[\n,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 100)) {
    const slug = canonicalSkillSlug(term);
    if (slug && !hasAnalysisPII(term)) skills.set(slug, { slug, term });
  }
  return [...skills.values()];
}

function structuredSkillEvidence(
  description: string,
  structured: Array<{ slug: string; term: string }>,
  existing: ExtractedSkill[],
): ExtractedSkill[] {
  const visible = visibleDescriptionMask(description);
  const found = [...existing];
  for (const { slug, term } of structured) {
    if (found.some((skill) => skill.slug === slug)) continue;
    const expression = new RegExp(
      `(?<!${word})${escaped(term)}(?!${word})`,
      'giu',
    );
    const match = [...visible.matchAll(expression)].find((candidate) => {
      const start = candidate.index ?? 0;
      return !negatedSkillEvidence(visible, start, start + candidate[0].length);
    });
    if (!match) continue;
    const start = match.index ?? 0;
    found.push({
      slug,
      label: skillLabelFromSlug(slug),
      start,
      end: start + match[0].length,
      quote: description.slice(start, start + match[0].length),
    });
  }
  return found.sort(
    (left, right) =>
      left.start - right.start || left.slug.localeCompare(right.slug),
  );
}

export interface AnalysisSourceIdentity {
  id: string;
  sourceContentJson: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
}
export function verifiedAnalysisSource(row: AnalysisSourceIdentity) {
  const source = parseOpportunitySourceContent(row.sourceContentJson);
  if (
    !source ||
    fingerprintOpportunitySourceContent(source) !==
      row.sourceContentFingerprint ||
    !Number.isInteger(row.sourceContentVersion) ||
    row.sourceContentVersion < 1
  )
    throw new Error('Unverified canonical opportunity source.');
  return source;
}
export const sourceText = (value: unknown): string =>
  typeof value === 'string' ? value : '';
export const hasAnalysisPII = (text: string): boolean =>
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\s().-]*){9,}/i.test(text);
export function negatedSkillEvidence(
  text: string,
  start: number,
  end: number,
): boolean {
  const before =
    text
      .slice(Math.max(0, start - 50), start)
      .split(/[.;\n]/)
      .at(-1) ?? '';
  const after = text.slice(end, end + 50).split(/[.;\n]/)[0] ?? '';
  return (
    /\b(no|not|without)\b[^,;]*$/i.test(before) ||
    /^\s*(?:experience\s+)?(?:is\s+)?(?:not\s+(?:required|needed|necessary)|unnecessary)/i.test(
      after,
    )
  );
}
export function deterministicOpportunityAnalysis(
  row: AnalysisSourceIdentity,
): OpportunityAnalysisSnapshot {
  const source = verifiedAnalysisSource(row);
  const description = sourceText(source.descriptionRaw);
  const requiredSkills = structuredSkills(source.requiredSkills);
  const preferredSkills = structuredSkills(source.preferredSkills);
  const requiredSlugs = new Set(requiredSkills.map((skill) => skill.slug));
  const preferredSlugs = new Set(preferredSkills.map((skill) => skill.slug));
  const structuredSlugs = new Set([...requiredSlugs, ...preferredSlugs]);
  const catalog = extractCatalogSkills(description);
  const structured = structuredSkillEvidence(
    description,
    [...requiredSkills, ...preferredSkills],
    catalog.filter((skill) => structuredSlugs.has(skill.slug)),
  );
  const structuredMatches = new Set(structured.map((skill) => skill.slug));
  // Keep explicit requirements ahead of free-text mentions, then bound the
  // public analysis shape even when a posting lists an exhaustive taxonomy.
  const extracted = [
    ...structured,
    ...catalog.filter((skill) => !structuredMatches.has(skill.slug)),
  ].slice(0, 100);
  const skills: OpportunityAnalysisSnapshot['skills'] = extracted.map(
    (skill) => ({
      slug: skill.slug,
      label: skill.label,
      kind: requiredSlugs.has(skill.slug)
        ? 'required'
        : preferredSlugs.has(skill.slug)
          ? 'preferred'
          : 'mentioned',
      confidence: 1,
      evidence: [{ start: skill.start, end: skill.end, quote: skill.quote }],
    }),
  );
  const requirements: OpportunityAnalysisSnapshot['requirements'] = [];
  const sentences = /[^\n]+?(?:[.!?](?=\s|$)|$)/g;
  for (const match of description.matchAll(sentences)) {
    const text = match[0].trim();
    if (
      text.length > 600 ||
      hasAnalysisPII(text) ||
      !/\b(required|must|minimum|at least|preferred|nice to have)\b/i.test(text)
    )
      continue;
    const start = (match.index ?? 0) + match[0].indexOf(text),
      end = start + text.length;
    const years = text.match(/\b(\d{1,2})\+?\s+years?\b/i);
    requirements.push({
      hash: createHash('sha256')
        .update(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '))
        .digest('hex'),
      text,
      kind: /\b(preferred|nice to have)\b/i.test(text) ? 'nice' : 'must',
      category: years ? 'experience' : 'other',
      ...(years ? { years: Number(years[1]) } : {}),
      skills: skills
        .filter((x) => x.evidence.some((e) => e.start >= start && e.end <= end))
        .map((x) => x.slug),
      evidence: [{ start, end }],
    });
    if (requirements.length === 100) break;
  }
  const number = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
  const hourly =
    number(source.hourlyMin) !== undefined ||
    number(source.hourlyMax) !== undefined;
  const min = number(hourly ? source.hourlyMin : source.salaryMin),
    max = number(hourly ? source.hourlyMax : source.salaryMax);
  const currency = sourceText(source.currency);
  const title = sourceText(source.title).slice(0, 300);
  const seniority =
    /\b(intern|junior|senior|staff|principal|manager|director)\b/i
      .exec(title)?.[1]
      .toLowerCase() ?? 'unknown';
  const workMode = ['remote', 'hybrid', 'onsite'].includes(
    sourceText(source.workMode),
  )
    ? sourceText(source.workMode)
    : 'unknown';
  return {
    id: '',
    opportunityId: row.id,
    sourceContentFingerprint: row.sourceContentFingerprint,
    sourceContentVersion: row.sourceContentVersion,
    analysisVersion: OPPORTUNITY_ANALYSIS_VERSION,
    status: 'deterministic',
    normalizedTitle: hasAnalysisPII(title) ? '' : title,
    seniority,
    function: 'unknown',
    workMode,
    employmentType: sourceText(source.employmentType).slice(0, 80),
    skills,
    requirements,
    skillSlugs: skills.map((x) => x.slug).sort(),
    summaryBullets: [],
    eligibility: {
      remote:
        workMode === 'remote' ? true : workMode === 'onsite' ? false : null,
      countries: [],
      regions: [],
      timezones: [],
      flags: 0,
      workAuthorization: { required: [], sponsorship: 'unknown' },
    },
    compensation:
      /^[A-Z]{3}$/.test(currency) && (min !== undefined || max !== undefined)
        ? {
            currency,
            min,
            max,
            period: hourly ? 'hour' : 'year',
            source: 'posted',
          }
        : null,
  };
}
