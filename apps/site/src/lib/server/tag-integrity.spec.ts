import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import './smrt.js';
import {
  tagContextForRole,
  tagNameFromSlug,
  tagReferenceSpecs,
} from './tag-integrity.js';

describe('tag integrity', () => {
  it('maps join roles to stable SMRT tag contexts', () => {
    expect(tagContextForRole('required_skill', 'global')).toBe('skill');
    expect(tagContextForRole('domain', 'global')).toBe('domain');
    expect(tagContextForRole('source_type', 'global')).toBe('source');
    expect(tagContextForRole('unknown', 'credential')).toBe('credential');
  });

  it('derives readable names without changing source slugs', () => {
    expect(tagNameFromSlug('cloud-native-postgres')).toBe(
      'Cloud Native Postgres',
    );
  });

  it('guards every local table that references a SMRT tag', () => {
    expect(tagReferenceSpecs.map((spec) => spec.table).sort()).toEqual(
      [
        'achievement_tags',
        'company_tags',
        'decision_tags',
        'duty_tags',
        'education_tags',
        'employment_role_tags',
        'experience_tags',
        'opportunity_tags',
        'project_tags',
        'skill_category_members',
        'skill_group_members',
        'source_tags',
      ].sort(),
    );
  });

  it.each([
    'AchievementTag',
    'CompanyTag',
    'DecisionTag',
    'DutyTag',
    'EducationTag',
    'EmploymentRoleTag',
    'ExperienceTag',
    'OpportunityTag',
    'ProjectTag',
    'SkillCategoryMember',
    'SkillGroupMember',
    'SourceTag',
  ])('%s validates tagId as a cross-package Tag reference', (className) => {
    const field = ObjectRegistry.getClass(className)?.fields.get('tagId');

    expect(field).toMatchObject({
      related: '@happyvertical/smrt-tags:Tag',
      required: true,
      type: 'crossPackageRef',
    });
    expect(field?._meta).toMatchObject({ idType: 'text', validate: true });
  });
});
