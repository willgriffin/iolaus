import { describe, expect, it } from 'vitest';
import { CAREER_SKILL_TERMS } from '$lib/skill-vocabulary-data.js';
import {
  canonicalSkillSlug,
  SKILL_VOCABULARY_SEED_TERMS,
  skillLabelFromSlug,
} from './skill-vocabulary.js';

describe('skill vocabulary', () => {
  it.each([
    ['Postgres', 'PostgreSQL'],
    ['Node.js', 'nodejs'],
    ['K8s', 'Kubernetes'],
    ['Golang', 'Go'],
  ])('canonicalizes alias %s to %s', (alias, canonical) => {
    expect(canonicalSkillSlug(alias)).toBe(canonicalSkillSlug(canonical));
  });

  it('keeps punctuation-bearing language identities distinct', () => {
    expect(canonicalSkillSlug('C++')).toBe('c++');
    expect(canonicalSkillSlug('C#')).toBe('c#');
    expect(canonicalSkillSlug('C')).toBe('c');
  });

  it('keeps aliases and related terms as separate seed graph fields', () => {
    const node = SKILL_VOCABULARY_SEED_TERMS.find(
      (term) => term.slug === 'nodejs',
    );
    expect(node?.aliases).toContain('node.js');
    expect(node?.related).toContain('javascript');
    expect(node?.aliases).not.toContain('javascript');
    expect(skillLabelFromSlug('postgresql')).toBe('PostgreSQL');
  });

  it('contains every fixed discovery vocabulary label as a seed term', () => {
    expect(CAREER_SKILL_TERMS).toHaveLength(57);
    const slugs = new Set(SKILL_VOCABULARY_SEED_TERMS.map((term) => term.slug));
    for (const term of CAREER_SKILL_TERMS)
      expect(slugs).toContain(canonicalSkillSlug(term));
  });
});
