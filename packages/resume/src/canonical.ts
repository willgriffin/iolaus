import type { TailoringConfig } from './types.js';

export const CANONICAL_TAILORING_SLUG = 'canonical';
export const CANONICAL_TAILORING_NAME = 'Canonical resume';

export const FULL_TAILORING_SLUG = 'full';
export const FULL_TAILORING_NAME = 'Full resume';

/** Short canonical resume: three items per role/project, compact older roles. */
export const canonicalResumeTailoringConfig: TailoringConfig = {
  compactExperienceIds: [],
  excludeEducationTitles: [],
  excludeSkillIds: [],
  hideSkills: true,
  hideTags: true,
  maxAchievementsPerPosition: 3,
  maxAchievementsPerProject: 3,
  maxProjectsPerPosition: 3,
  name: CANONICAL_TAILORING_NAME,
  outputSlug: CANONICAL_TAILORING_SLUG,
};

/** Long-form resume with the same exclusions but generous caps. */
export const fullResumeTailoringConfig: TailoringConfig = {
  excludeEducationTitles: [],
  excludeSkillIds: [],
  hideSkills: true,
  hideTags: true,
  maxAchievementsPerPosition: 10,
  maxAchievementsPerProject: 10,
  maxProjectsPerPosition: 10,
  name: FULL_TAILORING_NAME,
  outputSlug: FULL_TAILORING_SLUG,
};
