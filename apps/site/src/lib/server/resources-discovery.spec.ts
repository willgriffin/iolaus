import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
// Side-effect import registers all @smrt() model classes in the registry,
// exactly as the GET /api/_resources route does.
import './smrt';

/**
 * Guards the iolaus CLI's runtime resource discovery
 * (`GET /api/_resources` → `@happyvertical/smrt-app-cli`).
 *
 * The discovery handler builds CLI URLs from each registered class's
 * `collection` (the pluralized endpoint segment the SvelteKit route
 * generator routes under). For multi-word class names that segment
 * diverges from `tableName` — e.g. `SourceCrawl` is served at
 * `/api/sourcecrawls` but stored in `source_crawls`. smrt-core 0.26.4
 * (smrt#1312) made the registry carry `collection` so the handler stops
 * mis-deriving it from `tableName` and the CLI stops 404ing on these.
 *
 * If this regresses (e.g. a smrt bump drops `collection` again), the CLI
 * silently 404s on ~8 of iolaus's resources — this catches it.
 */
describe('CLI resource discovery: runtime collection (smrt#1312)', () => {
  it.each([
    ['SourceCrawl', 'sourcecrawls', 'source_crawls'],
    ['SourceCrawlItem', 'sourcecrawlitems', 'source_crawl_items'],
    ['ResumeVariant', 'resumevariants', 'resume_variants'],
    ['SkillCategory', 'skillcategories', 'skill_categories'],
    ['Education', 'educations', 'education'], // uncountable tableName
    ['EmploymentPerson', 'employmentpersons', 'people'], // overridden tableName
    ['Company', 'companies', 'companies'], // single word: collection == table
  ])('%s exposes collection "%s" (not tableName "%s")', (className, collection) => {
    const rc = ObjectRegistry.getClass(className);
    expect(rc, `${className} should be registered`).toBeDefined();
    expect(rc?.collection).toBe(collection);
  });
});
