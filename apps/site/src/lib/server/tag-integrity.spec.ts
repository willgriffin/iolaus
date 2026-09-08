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

  it('marks every tag guard uniqueness field as required in its model', () => {
    const classByTable: Record<string, string> = {
      achievement_tags: 'AchievementTag',
      company_tags: 'CompanyTag',
      decision_tags: 'DecisionTag',
      duty_tags: 'DutyTag',
      education_tags: 'EducationTag',
      employment_role_tags: 'EmploymentRoleTag',
      experience_tags: 'ExperienceTag',
      opportunity_tags: 'OpportunityTag',
      project_tags: 'ProjectTag',
      skill_category_members: 'SkillCategoryMember',
      skill_group_members: 'SkillGroupMember',
      source_tags: 'SourceTag',
    };

    for (const spec of tagReferenceSpecs) {
      const fields = ObjectRegistry.getClass(classByTable[spec.table])?.fields;

      for (const column of spec.uniqueColumns) {
        const fieldName = column.replace(/_([a-z])/g, (_, letter: string) =>
          letter.toUpperCase(),
        );

        expect(fields?.get(fieldName), `${spec.table}.${column}`).toMatchObject(
          { required: true },
        );
      }
    }
  });

  it('marks source provenance role as required in its model', () => {
    expect(
      ObjectRegistry.getClass('Source')?.fields.get('sourceRole'),
    ).toMatchObject({
      required: true,
    });
  });
});
