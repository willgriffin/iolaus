import type { ResumeSource } from '@willgriffin/iolaus-resume';
import { describe, expect, it } from 'vitest';
import type {
  CareerEditorSection,
  CareerSectionKey,
} from './career-management';
import { buildCareerPresentation } from './career-presentation';

function fixture() {
  const keys: CareerSectionKey[] = [
    'profile',
    'experiences',
    'projects',
    'achievements',
    'duties',
    'education',
    'other',
    'links',
    'skillCategories',
    'skillGroups',
  ];
  const rows: Record<CareerSectionKey, Record<string, unknown>[]> = {
    profile: [],
    experiences: [],
    projects: [],
    achievements: [],
    duties: [],
    education: [],
    other: [],
    links: [],
    skillCategories: [],
    skillGroups: [],
  };
  rows.profile = [
    { id: 'profile', name: 'Alex Rivera', summary: 'Canonical summary' },
  ];
  rows.experiences = [
    {
      id: 'raw-experience',
      experienceKey: 'canonical-experience',
      summary: 'Short summary',
    },
    {
      id: 'missing-company',
      experienceKey: 'hidden-experience',
      summary: 'Hidden details',
    },
  ];
  rows.projects = [
    {
      id: 'raw-project',
      projectKey: 'canonical-project',
      experienceId: 'raw-experience',
      name: 'Project',
    },
    {
      id: 'orphan-project',
      projectKey: 'orphan-key',
      experienceId: 'absent-parent',
      name: 'Orphan project',
    },
  ];
  rows.achievements = [
    {
      id: 'project-only',
      projectId: 'raw-project',
      experienceId: 'raw-experience',
      resumePlacement: 'project',
      title: 'Project achievement',
      body: 'Original source body',
    },
    {
      id: 'both',
      projectId: 'raw-project',
      experienceId: 'raw-experience',
      resumePlacement: 'both',
      title: 'Both locations',
      body: 'Original both body',
    },
  ];
  rows.education = [
    { id: 'valid-education', title: 'Degree', detail: 'Original detail' },
    { id: 'hidden-education', title: 'Incomplete degree', detail: '' },
  ];
  rows.other = [
    {
      id: 'valid-other',
      role: 'Developer',
      company: 'Example',
      period: '2020',
      body: '',
    },
    { id: 'hidden-other', role: 'Developer', company: '', period: '2020' },
  ];
  rows.skillCategories = [
    {
      id: 'raw-category',
      categoryKey: 'canonical-category',
      label: 'Languages',
    },
  ];
  const projectAchievement = {
    id: 'project-only',
    title: 'Project achievement',
    body: 'Original source body',
    tags: [],
  };
  const both = {
    id: 'both',
    title: 'Both locations',
    body: 'Original both body',
    tags: [],
  };
  const source: ResumeSource = {
    profile: {
      name: 'Alex Rivera',
      title: 'Engineer',
      email: '',
      links: [],
      summary: 'Canonical summary',
    },
    skills: {
      skillGroups: [],
      groups: [
        {
          id: 'canonical-category',
          label: 'Languages',
          skills: Array.from({ length: 30 }, (_, index) => ({
            id: 'skill-' + index,
            label: 'Skill ' + index,
          })),
        },
      ],
    },
    experience: {
      positions: [
        {
          id: 'canonical-experience',
          role: 'Staff Engineer',
          company: 'Northstar',
          start: '2020',
          end: 'Present',
          blurb: 'Short summary',
          achievements: [both],
          projects: [
            {
              id: 'canonical-project',
              name: 'Project',
              achievements: [projectAchievement, both],
            },
          ],
        },
      ],
      other: [
        {
          role: 'Developer',
          company: 'Example',
          period: '2020',
          body: '',
          tags: [],
        },
      ],
      education: [
        { title: 'Degree', institution: '', detail: 'Original detail' },
      ],
    },
  };
  const sections: CareerEditorSection[] = keys.map((key) => ({
    key,
    label: key,
    href: '/admin/' + key,
    fields: [],
    records: rows[key].map((row) => ({ id: String(row.id), values: {} })),
  }));
  const dependencies = {
    experienceRoles: [
      { experienceId: 'raw-experience', titleSnapshot: 'Staff Engineer' },
      { experienceId: 'missing-company', titleSnapshot: 'Developer' },
    ],
    experienceCompanies: [
      { experienceId: 'raw-experience', companyNameSnapshot: 'Northstar' },
    ],
    skillMembers: [
      {
        id: 'excluded-skill',
        categoryId: 'raw-category',
        label: 'Excluded skill',
        useOnResume: false,
      },
    ],
  };
  return { source, rows, sections, dependencies };
}
describe('Resume record presentation', () => {
  it('places an included project bullet under its actual canonical parent even when its other raw relationship is excluded', () => {
    const f = fixture();
    f.rows.achievements[0].experienceId = 'missing-company';
    const data = buildCareerPresentation(
      f.source,
      f.sections,
      f.rows,
      f.dependencies,
      'default',
    );
    expect(
      data.sections.find((section) => section.key === 'achievements')
        ?.records[0].presentation,
    ).toMatchObject({ inResume: true, parentExperienceId: 'raw-experience' });
  });
  it('uses raw record IDs and canonical stable keys, while keeping all metadata read only', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    const data = buildCareerPresentation(
      f.source,
      f.sections,
      f.rows,
      f.dependencies,
      'default',
    );
    const experience = data.sections.find(
      (section) => section.key === 'experiences',
    )?.records[0];
    expect(experience?.id).toBe('raw-experience');
    expect(experience?.presentation).toMatchObject({
      title: 'Staff Engineer · Northstar',
      context: '2020 – Present',
      inResume: true,
    });
    expect(JSON.stringify(f)).toBe(before);
  });
  it('classifies missing relationships, orphan projects and incomplete education with truthful reasons', () => {
    const f = fixture();
    const data = buildCareerPresentation(
      f.source,
      f.sections,
      f.rows,
      f.dependencies,
      'default',
    );
    for (const [key, id] of [
      ['experiences', 'missing-company'],
      ['projects', 'orphan-project'],
      ['education', 'hidden-education'],
      ['other', 'hidden-other'],
    ]) {
      const record = data.sections
        .find((section) => section.key === key)
        ?.records.find((row) => row.id === id);
      expect(record?.presentation?.inResume).toBe(false);
      expect(record?.presentation?.hiddenReason).toBeTruthy();
    }
    expect(data.skillExclusions).toEqual([
      {
        id: 'excluded-skill',
        title: 'Excluded skill',
        context: 'Languages',
        href: '/admin/skill-category-members',
      },
    ]);
  });
  it('keeps project-only and both-placement bullets included globally, without duplicates', () => {
    const f = fixture();
    const data = buildCareerPresentation(
      f.source,
      f.sections,
      f.rows,
      f.dependencies,
      'default',
    );
    const achievements = data.sections.find(
      (section) => section.key === 'achievements',
    )?.records;
    expect(
      achievements?.map((record) => [record.id, record.presentation?.inResume]),
    ).toEqual([
      ['project-only', true],
      ['both', true],
    ]);
    expect(
      achievements?.every(
        (record) =>
          record.presentation?.parentExperienceId === 'raw-experience',
      ),
    ).toBe(true);
  });
  it('bounds previews and shows only three skill labels plus the remaining count', () => {
    const f = fixture();
    f.rows.profile[0].summary = 'x'.repeat(1000);
    const data = buildCareerPresentation(
      f.source,
      f.sections,
      f.rows,
      f.dependencies,
      'default',
    );
    const preview = data.sections.find((section) => section.key === 'profile')
      ?.records[0].presentation?.preview;
    expect(preview?.length).toBeLessThanOrEqual(160);
    expect(preview).toBe(`${'x'.repeat(157)}…`);
    expect(
      data.sections.find((section) => section.key === 'skillCategories')
        ?.records[0].presentation?.preview,
    ).toBe('Skill 0 · Skill 1 · Skill 2 · +27 more');
  });
  it('does not infer membership from titles or duplicate stable keys', () => {
    const f = fixture();
    f.rows.experiences.push({
      id: 'ambiguous',
      experienceKey: 'canonical-experience',
      summary: 'Same title unrelated native record',
    });
    f.sections
      .find((section) => section.key === 'experiences')
      ?.records.push({ id: 'ambiguous', values: {} });
    const data = buildCareerPresentation(
      f.source,
      f.sections,
      f.rows,
      f.dependencies,
      'default',
    );
    expect(
      data.sections
        .find((section) => section.key === 'experiences')
        ?.records.filter((record) =>
          ['raw-experience', 'ambiguous'].includes(record.id),
        )
        .every((record) => record.presentation?.inResume === null),
    ).toBe(true);
  });
  it('uses canonical string normalization before classifying whitespace fields or stable keys', () => {
    const f = fixture();
    f.rows.education[1].title = '   ';
    f.rows.education[1].detail = '   ';
    f.rows.other[1].company = '   ';
    f.rows.experiences[0].experienceKey = '  canonical-experience  ';
    const data = buildCareerPresentation(
      f.source,
      f.sections,
      f.rows,
      f.dependencies,
      'default',
    );
    expect(
      data.sections.find((section) => section.key === 'education')?.records[1]
        .presentation?.inResume,
    ).toBe(false);
    expect(
      data.sections.find((section) => section.key === 'other')?.records[1]
        .presentation?.inResume,
    ).toBe(false);
    expect(
      data.sections.find((section) => section.key === 'experiences')?.records[0]
        .presentation?.inResume,
    ).toBe(true);
  });
  it('reports incomplete bounded reads and does not turn unavailable records into hidden entries', () => {
    const f = fixture();
    f.dependencies.experienceRoles = Array.from({ length: 1000 }, () => ({
      experienceId: 'raw-experience',
      titleSnapshot: 'Staff Engineer',
    }));
    const data = buildCareerPresentation(
      f.source,
      f.sections,
      f.rows,
      f.dependencies,
      'default',
    );
    expect(data.loadedComplete).toBe(false);
    expect(
      data.sections.find((section) => section.key === 'experiences')?.records[1]
        .presentation?.inResume,
    ).toBeNull();
    expect(
      data.sections.find((section) => section.key === 'projects')?.records[1]
        .presentation?.inResume,
    ).toBeNull();
  });
});
