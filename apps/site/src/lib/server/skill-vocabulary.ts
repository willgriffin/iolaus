import { randomUUID } from 'node:crypto';
import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import { z } from 'zod';
import type { SkillTerm } from '$lib/objects/SkillTerm.js';
import {
  canonicalSkillSlug,
  installSkillVocabularySnapshot,
  SKILL_CANONICAL_ALIASES,
} from '$lib/skill-canonical.js';
import { normalizeSkill } from '$lib/skill-matching.js';
import {
  CAREER_SKILL_TERMS,
  careerSkillCategory,
} from '$lib/skill-vocabulary-data.js';
import { getDbConfig } from './db.js';
import { getCollection } from './smrt.js';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';

/** Stable aliases shared by deterministic analysis and candidate matching. */
export const SKILL_VOCABULARY_SEEDS: Record<string, string> =
  SKILL_CANONICAL_ALIASES;

/** Immutable platform vocabulary. Aliases mean the same capability; `related`
 * is intentionally separate and never grants an exact skill match. */
const CORE_SKILL_VOCABULARY_SEED_TERMS = [
  {
    slug: 'postgresql',
    label: 'PostgreSQL',
    aliases: ['postgres', 'postgresql'],
    related: ['sql'],
  },
  {
    slug: 'nodejs',
    label: 'Node.js',
    aliases: ['node.js', 'node js', 'nodejs'],
    related: ['javascript'],
  },
  {
    slug: 'react',
    label: 'React',
    aliases: ['react.js', 'reactjs'],
    related: ['javascript'],
  },
  {
    slug: 'kubernetes',
    label: 'Kubernetes',
    aliases: ['k8s', 'kubernetes'],
    related: ['docker'],
  },
  { slug: 'go', label: 'Go', aliases: ['golang', 'go'], related: [] },
  {
    slug: 'javascript',
    label: 'JavaScript',
    aliases: ['js', 'javascript'],
    related: [],
  },
  {
    slug: 'typescript',
    label: 'TypeScript',
    aliases: ['ts', 'typescript'],
    related: ['javascript'],
  },
  {
    slug: 'aws',
    label: 'AWS',
    aliases: ['amazon web services', 'aws'],
    related: [],
  },
] as const;

function rawSkillSlug(value: string): string {
  return canonicalSkillSlug(value);
}

type SeedTerm = {
  slug: string;
  label: string;
  aliases: readonly string[];
  related: readonly string[];
};
const coreSeedBySlug = new Map<string, SeedTerm>(
  CORE_SKILL_VOCABULARY_SEED_TERMS.map((term) => [term.slug, term]),
);
/** Includes the complete fixed career vocabulary, while retaining curated alias
 * and related-edge metadata only for explicitly governed core terms. */
export const SKILL_VOCABULARY_SEED_TERMS = Array.from(
  new Map(
    CAREER_SKILL_TERMS.map((label) => {
      const raw = rawSkillSlug(label);
      const slug = SKILL_VOCABULARY_SEEDS[raw.replace(/-/g, ' ')] ?? raw;
      const core = coreSeedBySlug.get(slug);
      return [
        slug,
        core ?? ({ slug, label, aliases: [label], related: [] } as SeedTerm),
      ];
    }),
  ).values(),
);

export { canonicalSkillSlug, installSkillVocabularySnapshot };

export function skillLabelFromSlug(slug: string): string {
  const seed = SKILL_VOCABULARY_SEED_TERMS.find((term) => term.slug === slug);
  if (seed) return seed.label;
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
  for (const seed of SKILL_VOCABULARY_SEED_TERMS) {
    const skillSlug = seed.slug;
    const [existing] = await terms.list({ limit: 1, where: { skillSlug } });
    if (existing) continue;
    try {
      await terms.create({
        skillSlug,
        label: seed.label,
        aliasesJson: JSON.stringify(seed.aliases),
        category: careerSkillCategory(seed.label),
        relatedJson: JSON.stringify(
          seed.related.map((slug) => ({ slug, weight: 0.5 })),
        ),
        status: 'seed',
        occurrenceCount: 0,
      });
      created += 1;
    } catch {
      // A concurrent seed won the unique natural key. Re-read to distinguish
      // that expected race from an unrelated persistence failure.
      const [raced] = await terms.list({ limit: 1, where: { skillSlug } });
      if (!raced) throw new Error(`Could not seed skill term ${skillSlug}.`);
    }
  }
  // Earlier seed normalization could materialize e.g. `react-js` beside the
  // canonical `react`. Remove only a redundant immutable seed after the
  // canonical row is durable; confirmed operator terms are never rewritten.
  const rows = await terms.list({ limit: 5000 });
  const existingSlugs = new Set(rows.map((row) => row.skillSlug));
  for (const row of rows) {
    const canonical = canonicalSkillSlug(row.skillSlug);
    if (
      row.status === 'seed' &&
      canonical !== row.skillSlug &&
      existingSlugs.has(canonical)
    )
      await row.delete();
  }
  await refreshSkillVocabularyLookup();
  return created;
}

function activeTerms(rows: SkillTerm[]): SkillTerm[] {
  const aliasKey = (value: string) => {
    const explicit = value.trim().toLowerCase().replace(/\s+/g, ' ');
    return explicit === 'c++' || explicit === 'c#'
      ? explicit
      : normalizeSkill(value);
  };
  const aliases = new Map<string, string>();
  const active = rows.filter(
    (row) => row.status === 'seed' || row.status === 'confirmed',
  );
  for (const row of active) {
    let values: unknown = [];
    try {
      values = JSON.parse(row.aliasesJson || '[]');
    } catch {
      throw new Error(`Skill term ${row.skillSlug} has malformed aliases.`);
    }
    if (!Array.isArray(values))
      throw new Error(`Skill term ${row.skillSlug} aliases must be an array.`);
    for (const value of [row.skillSlug, ...values.map(String)]) {
      const key = aliasKey(value);
      const prior = aliases.get(key);
      if (prior && prior !== row.skillSlug)
        throw new Error(`Skill vocabulary alias collision: ${value}.`);
      aliases.set(key, row.skillSlug);
    }
    const related = JSON.parse(row.relatedJson || '[]') as unknown;
    if (
      !Array.isArray(related) ||
      related.length > 50 ||
      related.some(
        (edge) =>
          !edge ||
          typeof edge !== 'object' ||
          !Number.isFinite(Number((edge as { weight?: unknown }).weight)) ||
          Number((edge as { weight?: unknown }).weight) < 0 ||
          Number((edge as { weight?: unknown }).weight) > 1,
      )
    )
      throw new Error(`Skill term ${row.skillSlug} has invalid related graph.`);
  }
  return active;
}

/** Load only operator-approved rows into the synchronous immutable matcher snapshot. */
export async function refreshSkillVocabularyLookup(): Promise<number> {
  const terms = await getCollection<SkillTerm>('SkillTerm');
  const active = activeTerms(await terms.list({ limit: 5000 }));
  installSkillVocabularySnapshot(active);
  return active.length;
}

/** Resolve submitted terms through persisted aliases, falling back to the
 * deterministic seed normalization during bootstrap and outages. */
export async function resolveSkillVocabulary(value: string): Promise<string> {
  const fallback = canonicalSkillSlug(value);
  const terms = await getCollection<SkillTerm>('SkillTerm');
  const all = activeTerms(await terms.list({ limit: 5000 }));
  installSkillVocabularySnapshot(all);
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const term of all) {
    let aliases: unknown = [];
    try {
      aliases = JSON.parse(term.aliasesJson || '[]') as unknown;
    } catch {
      // A malformed operator-created row must not make canonical matching
      // nondeterministic; it is simply ignored until repaired.
    }
    if (
      term.skillSlug === fallback ||
      (Array.isArray(aliases) &&
        aliases.some((alias) => normalizeSkill(String(alias)) === normalized))
    )
      return term.skillSlug;
  }
  return fallback;
}

const correctionSchema = z
  .object({
    slug: z.string().min(1).max(100).optional(),
    label: z.string().trim().min(1).max(100),
    category: z.string().trim().min(1).max(100).optional(),
    aliases: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    related: z
      .array(
        z
          .object({
            slug: z.string().min(1).max(100),
            weight: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();
export type SkillVocabularyCorrection = z.infer<typeof correctionSchema>;
/** Transactional operator correction: validate the complete proposed snapshot
 * while holding the shared vocabulary writer lock, then persist and publish. */
export async function publishSkillVocabularyCorrection(
  db: Awaited<ReturnType<typeof resolveDatabase>>,
  input: SkillVocabularyCorrection,
) {
  const checked = correctionSchema.parse(input);
  if (!db.transaction)
    throw new Error('Skill correction requires native transactions.');
  const transaction = db.transaction.bind(db);
  const sqlite = Boolean(db.url && detectEngine(db.url) === 'sqlite');
  const run = () =>
    transaction(async (tx) => {
      if (!sqlite) await tx.query('SELECT pg_advisory_xact_lock(196001)');
      const rows = (
        await tx.query(
          'SELECT id, skill_slug AS "skillSlug", label, aliases_json AS "aliasesJson", related_json AS "relatedJson", category, status, occurrence_count AS "occurrenceCount" FROM skill_terms ORDER BY skill_slug LIMIT 5001',
        )
      ).rows as unknown as SkillTerm[];
      if (rows.length > 5000)
        throw new Error('Vocabulary exceeds the bounded correction window.');
      const skillSlug = canonicalSkillSlug(checked.slug ?? checked.label);
      const existing = rows.find((row) => row.skillSlug === skillSlug);
      const proposal = {
        id: existing?.id ?? randomUUID(),
        skillSlug,
        label: checked.label,
        aliasesJson: JSON.stringify(
          Array.from(
            new Set([checked.label, ...(checked.aliases ?? [])]),
          ).sort(),
        ),
        relatedJson: JSON.stringify(checked.related ?? []),
        category: checked.category ?? existing?.category ?? 'general',
        status: 'confirmed',
        occurrenceCount: existing?.occurrenceCount ?? 0,
      } as SkillTerm;
      const active = activeTerms([
        ...rows.filter((row) => row.skillSlug !== skillSlug),
        proposal,
      ]);
      const now = new Date().toISOString();
      if (existing)
        await tx.query(
          'UPDATE skill_terms SET label=?,aliases_json=?,related_json=?,category=?,status=?,updated_at=? WHERE id=?',
          [
            proposal.label,
            proposal.aliasesJson,
            proposal.relatedJson,
            proposal.category,
            proposal.status,
            now,
            proposal.id,
          ],
        );
      else
        await tx.query(
          'INSERT INTO skill_terms(id,slug,context,created_at,updated_at,skill_slug,label,aliases_json,related_json,category,status,occurrence_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            proposal.id,
            skillSlug,
            '',
            now,
            now,
            skillSlug,
            proposal.label,
            proposal.aliasesJson,
            proposal.relatedJson,
            proposal.category,
            proposal.status,
            proposal.occurrenceCount,
          ],
        );
      return { proposal, active };
    });
  const result = await (sqlite
    ? withSqliteOperationLock('skill-vocabulary-correction', run)
    : run());
  installSkillVocabularySnapshot(result.active);
  return {
    id: result.proposal.id,
    skillSlug: result.proposal.skillSlug,
    label: result.proposal.label,
    status: result.proposal.status,
  };
}
export async function promoteSkillTerm(input: SkillVocabularyCorrection) {
  return publishSkillVocabularyCorrection(
    await resolveDatabase(getDbConfig()),
    input,
  );
}
