import { normalizeSkill } from '$lib/skill-matching.js';

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
