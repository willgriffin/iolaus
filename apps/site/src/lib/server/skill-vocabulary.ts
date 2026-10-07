import type { SkillTerm } from '$lib/objects/SkillTerm.js';
import { normalizeSkill } from '$lib/skill-matching.js';
import { getCollection } from './smrt.js';

/** Stable aliases shared by deterministic analysis and candidate matching. */
export const SKILL_VOCABULARY_SEEDS: Record<string, string> = {
  postgres: 'postgresql',
  postgresql: 'postgresql',
  'node.js': 'nodejs',
  'node js': 'nodejs',
  nodejs: 'nodejs',
  'react.js': 'react',
  reactjs: 'react',
  k8s: 'kubernetes',
  kubernetes: 'kubernetes',
  golang: 'go',
  go: 'go',
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  'amazon web services': 'aws',
  aws: 'aws',
};

export function canonicalSkillSlug(value: string): string {
  // Punctuation is semantic for language names; collapsing C++ to C would
  // create a false candidate match.
  const explicitLanguage = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (explicitLanguage === 'c++' || explicitLanguage === 'c#')
    return explicitLanguage;
  const normalized = normalizeSkill(value).replace(/\s+/g, '-');
  return SKILL_VOCABULARY_SEEDS[normalized.replace(/-/g, ' ')] ?? normalized;
}

export function skillLabelFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) =>
      part.length <= 3
        ? part.toUpperCase()
        : part[0]?.toUpperCase() + part.slice(1),
    )
    .join(' ');
}

/** Idempotently persist the platform aliases so all server consumers can share
 * the same vocabulary instead of rebuilding ad-hoc candidate terms. */
export async function ensureSeedSkillVocabulary(): Promise<number> {
  const terms = await getCollection<SkillTerm>('SkillTerm');
  let created = 0;
  for (const [alias, canonical] of Object.entries(SKILL_VOCABULARY_SEEDS)) {
    const skillSlug = canonicalSkillSlug(canonical);
    const [existing] = await terms.list({ limit: 1, where: { skillSlug } });
    if (existing) continue;
    await terms.create({
      skillSlug,
      label: skillLabelFromSlug(skillSlug),
      aliasesJson: JSON.stringify([alias]),
      category: 'technology',
      status: 'seed',
      occurrenceCount: 0,
    });
    created += 1;
  }
  return created;
}

/** Resolve submitted terms through persisted aliases, falling back to the
 * deterministic seed normalization during bootstrap and outages. */
export async function resolveSkillVocabulary(value: string): Promise<string> {
  const fallback = canonicalSkillSlug(value);
  const terms = await getCollection<SkillTerm>('SkillTerm');
  const all = await terms.list({ limit: 5000 });
  const normalized = normalizeSkill(value);
  for (const term of all) {
    const aliases = JSON.parse(term.aliasesJson || '[]') as unknown;
    if (
      term.skillSlug === fallback ||
      (Array.isArray(aliases) &&
        aliases.some((alias) => normalizeSkill(String(alias)) === normalized))
    )
      return term.skillSlug;
  }
  return fallback;
}
