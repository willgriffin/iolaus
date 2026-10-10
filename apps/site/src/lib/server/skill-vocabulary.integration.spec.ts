import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalSkillSlug,
  installSkillVocabularySnapshot,
} from '$lib/skill-canonical.js';
import { publishSkillVocabularyCorrection } from './skill-vocabulary.js';

const postgres = process.env.VOCABULARY_POSTGRES_TEST_DATABASE_URL;
for (const dialect of ['sqlite', 'postgres'] as const)
  describe.runIf(dialect === 'sqlite' || postgres)(
    `skill vocabulary ${dialect} persistence`,
    () => {
      let db: Awaited<ReturnType<typeof getDatabase>>;
      let schema = '';
      beforeAll(async () => {
        if (dialect === 'sqlite')
          db = await getDatabase({
            type: 'sqlite',
            url: ':memory:',
            cache: false,
          });
        else {
          const control = await getDatabase({
            type: 'postgres',
            url: postgres ?? '',
            cache: false,
            max: 3,
          });
          schema = `vocabulary_${randomUUID().replaceAll('-', '')}`;
          await control.query(`CREATE SCHEMA "${schema}"`);
          const url = new URL(postgres ?? '');
          url.searchParams.set('options', `-c search_path=${schema},public`);
          db = await getDatabase({
            type: 'postgres',
            url: url.toString(),
            cache: false,
            max: 3,
          });
        }
        await db.query(
          "CREATE TABLE skill_terms (id TEXT PRIMARY KEY, slug TEXT, context TEXT, created_at TEXT, updated_at TEXT, skill_slug TEXT NOT NULL, label TEXT, aliases_json TEXT NOT NULL, related_json TEXT DEFAULT '[]', category TEXT, status TEXT DEFAULT 'confirmed', occurrence_count INTEGER DEFAULT 0)",
        );
        await db.query(
          'CREATE UNIQUE INDEX skill_terms_skill_slug ON skill_terms(skill_slug)',
        );
      });
      afterAll(async () => {
        await db.close?.();
        if (schema) {
          const control = await getDatabase({
            type: 'postgres',
            url: postgres ?? '',
            cache: false,
            max: 3,
          });
          await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
      });
      it('rejects conflicting and invalid operator corrections without persisting them', async () => {
        await publishSkillVocabularyCorrection(db, {
          slug: 'fixture-alpha',
          label: 'Fixture Alpha',
          aliases: ['fixture shared'],
        });
        await expect(
          publishSkillVocabularyCorrection(db, {
            slug: 'fixture-beta',
            label: 'Fixture Beta',
            aliases: ['fixture shared'],
          }),
        ).rejects.toThrow('collision');
        await expect(
          publishSkillVocabularyCorrection(db, {
            slug: 'fixture-alpha',
            label: 'Changed',
            related: [{ slug: 'other', weight: 2 }],
          }),
        ).rejects.toThrow();
        const rows = (
          await db.query(
            "SELECT label FROM skill_terms WHERE skill_slug LIKE 'fixture-%'",
          )
        ).rows;
        expect(rows).toEqual([{ label: 'Fixture Alpha' }]);
      });
      it('serializes concurrent corrections that claim the same alias', async () => {
        const results = await Promise.allSettled([
          publishSkillVocabularyCorrection(db, {
            slug: 'concurrent-one',
            label: 'Concurrent One',
            aliases: ['shared concurrent alias'],
          }),
          publishSkillVocabularyCorrection(db, {
            slug: 'concurrent-two',
            label: 'Concurrent Two',
            aliases: ['shared concurrent alias'],
          }),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === 'rejected'),
        ).toHaveLength(1);
      });
      it('preserves one natural key and refreshes synchronous aliases from persisted rows', async () => {
        await db.query(
          'INSERT INTO skill_terms(id,skill_slug,aliases_json) VALUES (?,?,?)',
          [randomUUID(), 'postgresql', '["postgres","postgresql"]'],
        );
        await expect(
          db.query(
            'INSERT INTO skill_terms(id,skill_slug,aliases_json) VALUES (?,?,?)',
            [randomUUID(), 'postgresql', '[]'],
          ),
        ).rejects.toBeTruthy();
        const result = await db.query(
          'SELECT skill_slug AS "skillSlug", aliases_json AS "aliasesJson" FROM skill_terms',
        );
        installSkillVocabularySnapshot(
          result.rows as Array<{ skillSlug: string; aliasesJson: string }>,
        );
        expect(canonicalSkillSlug('Postgres')).toBe('postgresql');
      });
    },
  );
