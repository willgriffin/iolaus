/**
 * Canonical resume collection read plans.
 *
 * These specs are the single source of truth for which collections make up the
 * published resume. Both the loader (`resume-data.ts`) and the cache version
 * stamp (`resume-stamp.ts`) derive from them, so the set of tables watched for
 * change can never drift from the set of tables actually read.
 */

export type ResumeReadPlanSpec = Readonly<
  Record<string, readonly [className: string, orderBy: string]>
>;

export const NORMALIZED_RESUME_READ_PLAN = {
  achievements: ['Achievement', 'sortOrder ASC'],
  achievementAttachments: ['AchievementAttachment', 'sortOrder ASC'],
  achievementTags: ['AchievementTag', 'updated_at ASC'],
  attachments: ['Attachment', 'sortOrder ASC'],
  companies: ['Company', 'name ASC'],
  companyAttachments: ['CompanyAttachment', 'sortOrder ASC'],
  duties: ['Duty', 'sortOrder ASC'],
  dutyTags: ['DutyTag', 'updated_at ASC'],
  education: ['Education', 'sortOrder ASC'],
  educationTags: ['EducationTag', 'updated_at ASC'],
  experienceCompanies: ['ExperienceCompany', 'sortOrder ASC'],
  experienceRoles: ['ExperienceRole', 'sortOrder ASC'],
  experienceTags: ['ExperienceTag', 'updated_at ASC'],
  experiences: ['Experience', 'sortOrder ASC'],
  otherRoles: ['ResumeOtherRole', 'sortOrder ASC'],
  profileLinks: ['CandidateProfileLink', 'sortOrder ASC'],
  profiles: ['CandidateProfile', 'profileKey ASC'],
  projects: ['Project', 'sortOrder ASC'],
  projectAttachments: ['ProjectAttachment', 'sortOrder ASC'],
  projectTags: ['ProjectTag', 'updated_at ASC'],
  roles: ['EmploymentRole', 'label ASC'],
  roleTags: ['EmploymentRoleTag', 'updated_at ASC'],
  skillCategories: ['SkillCategory', 'sortOrder ASC'],
  skillCategoryMembers: ['SkillCategoryMember', 'sortOrder ASC'],
  skillGroups: ['SkillGroup', 'sortOrder ASC'],
  skillGroupMembers: ['SkillGroupMember', 'sortOrder ASC'],
  tags: ['Tag', 'slug ASC'],
} as const satisfies ResumeReadPlanSpec;

export const LEGACY_RESUME_READ_PLAN = {
  achievements: ['ResumeAchievement', 'sortOrder ASC'],
  education: ['ResumeEducation', 'sortOrder ASC'],
  links: ['ResumeLink', 'sortOrder ASC'],
  otherRoles: ['ResumeOtherRole', 'sortOrder ASC'],
  positions: ['ResumePosition', 'sortOrder ASC'],
  profiles: ['ResumeProfile', 'profileKey ASC'],
  skillCategories: ['ResumeSkillCategory', 'sortOrder ASC'],
  skillGroups: ['ResumeSkillGroup', 'sortOrder ASC'],
  skills: ['ResumeSkill', 'sortOrder ASC'],
} as const satisfies ResumeReadPlanSpec;

/**
 * Every class the published resume can read.
 *
 * `loadPublishedResumeSource()` reads the normalized plan and falls back to the
 * legacy plan when no normalized profile exists, so a change to either set can
 * change the published payload. The stamp therefore watches the union: watching
 * a table that did not contribute only costs a redundant reload, while missing
 * one would serve stale content.
 */
export function resumeStampClassNames(): string[] {
  const names = new Set<string>();
  for (const plan of [NORMALIZED_RESUME_READ_PLAN, LEGACY_RESUME_READ_PLAN]) {
    for (const [className] of Object.values(plan)) names.add(className);
  }
  return [...names].sort();
}
