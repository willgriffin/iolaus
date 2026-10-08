import { normalizeSkill } from './skill-matching.js';

export const SKILL_CANONICAL_ALIASES: Record<string, string> = {
  postgres: 'postgresql',
  postgresql: 'postgresql',
  'node.js': 'nodejs',
  'node js': 'nodejs',
  nodejs: 'nodejs',
  'react.js': 'react',
  'react js': 'react',
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
let persistedAliases = new Map<string, string>();
function raw(value: string): string {
  const explicit = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (explicit === 'c++' || explicit === 'c#') return explicit;
  return normalizeSkill(value).replace(/\s+/g, '-');
}
export function installSkillVocabularySnapshot(
  terms: ReadonlyArray<{ skillSlug: string; aliasesJson: string }>,
): void {
  const next = new Map<string, string>();
  for (const term of terms) {
    if (!term.skillSlug) continue;
    next.set(raw(term.skillSlug), term.skillSlug);
    try {
      const aliases = JSON.parse(term.aliasesJson || '[]') as unknown;
      if (Array.isArray(aliases))
        for (const alias of aliases)
          next.set(raw(String(alias)), term.skillSlug);
    } catch {
      /* ignore malformed operator data */
    }
  }
  persistedAliases = next;
}
export function canonicalSkillSlug(value: string): string {
  const normalized = raw(value);
  return (
    persistedAliases.get(normalized) ??
    SKILL_CANONICAL_ALIASES[normalized.replace(/-/g, ' ')] ??
    normalized
  );
}
