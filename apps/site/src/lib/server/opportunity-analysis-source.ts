import { createHash } from 'node:crypto';
import type { OpportunityAnalysisSnapshot } from '$lib/opportunity-analysis-contract.js';
import { OPPORTUNITY_ANALYSIS_VERSION } from '$lib/opportunity-analysis-contract.js';
import {
  fingerprintOpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';
import { canonicalSkillSlug, skillLabelFromSlug } from './skill-vocabulary.js';

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
  const skills: OpportunityAnalysisSnapshot['skills'] = [];
  const requirements: OpportunityAnalysisSnapshot['requirements'] = [];
  for (const [value, kind] of [
    [source.requiredSkills, 'required'],
    [source.preferredSkills, 'preferred'],
  ] as const) {
    for (const term of sourceText(value)
      .split(/[\n,;]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 100)) {
      const slug = canonicalSkillSlug(term);
      const start = description.toLowerCase().indexOf(term.toLowerCase());
      if (
        !slug ||
        start < 0 ||
        hasAnalysisPII(term) ||
        negatedSkillEvidence(description, start, start + term.length)
      )
        continue;
      const end = start + term.length;
      if (skills.some((x) => x.slug === slug)) continue;
      skills.push({
        slug,
        label: skillLabelFromSlug(slug),
        kind,
        confidence: 1,
        evidence: [{ start, end, quote: description.slice(start, end) }],
      });
    }
  }
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
