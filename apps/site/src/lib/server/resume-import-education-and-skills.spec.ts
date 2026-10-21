import { describe, expect, it } from 'vitest';
import { Education } from '$lib/objects/Education.js';
import {
  assembleResumeSourceFromRecords,
  type ResumeSourceRecords,
} from './resume-data.js';

describe('resume import education and private skills', () => {
  it('keeps legacy education date precision defaults at year', () => {
    const education = new Education();
    expect(education.startPrecision).toBe('year');
    expect(education.endPrecision).toBe('year');
  });

  it('keeps a private skill group visible when it has no shared catalog member', () => {
    const records: ResumeSourceRecords = {
      achievements: [],
      achievementAttachments: [],
      achievementTags: [],
      attachments: [],
      companies: [],
      companyAttachments: [],
      duties: [],
      dutyTags: [],
      education: [],
      educationTags: [],
      experienceCompanies: [],
      experienceRoles: [],
      experienceTags: [],
      experiences: [],
      otherRoles: [],
      profileLinks: [],
      profiles: [
        {
          id: 'profile',
          profileKey: 'default',
          active: true,
          name: 'Name',
          title: 'Title',
          email: 'email@example.test',
          summary: '',
        },
      ],
      projects: [],
      projectAttachments: [],
      projectTags: [],
      roles: [],
      roleTags: [],
      skillCategories: [],
      skillCategoryMembers: [],
      skillGroups: [
        {
          id: 'private-skill',
          groupKey: 'private-skill',
          label: 'Obscure Internal Tool',
          blurb: '',
          useOnResume: true,
          sortOrder: 0,
        },
      ],
      skillGroupMembers: [],
    };
    expect(
      assembleResumeSourceFromRecords(records)?.skills.skillGroups,
    ).toEqual([
      {
        id: 'private-skill',
        label: 'Obscure Internal Tool',
        blurb: '',
        skills: [],
      },
    ]);
  });
});
