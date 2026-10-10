// Fictional test-only evidence. Runtime seed files remain empty.
vi.mock('../data/experience.json', () => ({
  default: {
    positions: [
      {
        id: 'example',
        role: 'Engineer',
        company: 'Example Company',
        start: '2020',
        end: '2024',
        achievements: [
          {
            title: 'Example achievement',
            body: 'Built a sample service.',
            tags: ['typescript'],
          },
        ],
      },
    ],
    other: [],
    education: [],
  },
}));
vi.mock('../data/skills.json', () => ({
  default: {
    groups: [
      {
        id: 'languages',
        label: 'Languages',
        skills: [{ id: 'typescript', label: 'TypeScript' }],
      },
    ],
    skillGroups: [],
  },
}));

import type {
  Experience,
  Profile,
  ResumeSource,
  Skills,
} from '@willgriffin/iolaus-resume';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidateProfileWhere: vi.fn(),
  executeCollectionReadPlan: vi.fn(),
  getCurrentSessionPermissionContext: vi.fn(),
  getCurrentTenant: vi.fn(),
  getRequestScopedSmrtOptions: vi.fn(),
  getRequestScopedDatabase: vi.fn(),
  getPrivateRecord: vi.fn(),
  getCollection: vi.fn(),
  isSharedHosted: vi.fn(),
  loadPublishedResumeStamp: vi.fn(),
  privateRecordWhere: vi.fn(),
  requireWorkspaceSubject: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  executeCollectionReadPlan: mocks.executeCollectionReadPlan,
}));

vi.mock('@happyvertical/smrt-tenancy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-tenancy')>()),
  getCurrentTenant: mocks.getCurrentTenant,
}));

vi.mock('@happyvertical/smrt-users', () => ({
  getCurrentSessionPermissionContext: mocks.getCurrentSessionPermissionContext,
  getRequestScopedDatabase: mocks.getRequestScopedDatabase,
}));

vi.mock('./resume-stamp', () => ({
  loadPublishedResumeStamp: mocks.loadPublishedResumeStamp,
}));

vi.mock('./app-config.js', () => ({
  isSharedHosted: mocks.isSharedHosted,
}));

vi.mock('./private-workspace.js', () => ({
  candidateProfileWhere: mocks.candidateProfileWhere,
  getPrivateRecord: mocks.getPrivateRecord,
  privateRecordWhere: mocks.privateRecordWhere,
  requireWorkspaceSubject: mocks.requireWorkspaceSubject,
}));

vi.mock('./smrt', () => ({
  getCollection: mocks.getCollection,
  getRequestScopedSmrtOptions: mocks.getRequestScopedSmrtOptions,
}));

import {
  assembleResumeSourceFromLegacyRecords,
  assembleResumeSourceFromRecords,
  getCachedPublishedResume,
  getCachedPublishedResumeSource,
  getPublishedResumeAsset,
  invalidatePublishedResumeCache,
  type LegacyResumeSourceRecords,
  listResumeAssets,
  loadLegacyAdminResumeSource,
  loadLegacyResumeSource,
  loadNormalizedResumeSource,
  loadPublishedResumeSource,
  loadWorkspaceCandidateEvidence,
  parseTailoringConfigRecord,
  type ResumeSourceRecords,
  resumeProfileSummaries,
} from './resume-data';

function emptyReadPlanResult(plan: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(plan).map((key) => [key, []]));
}

beforeEach(() => {
  invalidatePublishedResumeCache();
  mocks.getCollection.mockReset();
  mocks.getCollection.mockImplementation(() => {
    throw new Error('database unavailable');
  });
  mocks.executeCollectionReadPlan.mockReset();
  mocks.executeCollectionReadPlan.mockRejectedValue(
    new Error('database unavailable'),
  );
  mocks.getRequestScopedSmrtOptions.mockReset();
  mocks.getRequestScopedSmrtOptions.mockReturnValue({ db: 'request-db' });
  mocks.getCurrentSessionPermissionContext.mockReset();
  mocks.getRequestScopedDatabase.mockReset();
  mocks.getCurrentTenant.mockReset();
  mocks.getPrivateRecord.mockReset();
  mocks.isSharedHosted.mockReset();
  mocks.isSharedHosted.mockReturnValue(false);
  mocks.loadPublishedResumeStamp.mockReset();
  mocks.loadPublishedResumeStamp.mockResolvedValue('stamp-1');
  mocks.candidateProfileWhere.mockReset();
  mocks.candidateProfileWhere.mockImplementation((subject) => ({
    ownerUserId: subject.userId,
    tenantId: subject.tenantId,
  }));
  mocks.privateRecordWhere.mockReset();
  mocks.privateRecordWhere.mockImplementation((subject) => ({
    candidateProfileId: subject.profileId,
    ownerUserId: subject.userId,
    tenantId: subject.tenantId,
  }));
  mocks.requireWorkspaceSubject.mockReset();
  mocks.requireWorkspaceSubject.mockImplementation((subject) => subject);
  vi.useRealTimers();
});

function legacyRecordsFromSource(
  source: ResumeSource,
): LegacyResumeSourceRecords {
  return {
    profiles: [
      {
        active: true,
        email: source.profile.email,
        name: source.profile.name,
        profileKey: 'default',
        summary: source.profile.summary,
        title: source.profile.title,
      },
    ],
    links: source.profile.links.map((link, index) => ({
      ...link,
      profileKey: 'default',
      sortOrder: index,
    })),
    skillCategories: source.skills.groups.map((group, index) => ({
      categoryId: group.id,
      label: group.label,
      sortOrder: index,
    })),
    skills: source.skills.groups.flatMap((group, groupIndex) =>
      group.skills.map((skill, skillIndex) => ({
        categoryId: group.id,
        label: skill.label,
        skillId: skill.id,
        sortOrder: groupIndex * 100 + skillIndex,
      })),
    ),
    skillGroups: source.skills.skillGroups.map((group, index) => ({
      blurb: group.blurb,
      groupId: group.id,
      label: group.label,
      skillIds: group.skills.join('\n'),
      sortOrder: index,
    })),
    positions: source.experience.positions.map((position, index) => ({
      blurb: position.blurb ?? '',
      company: position.company,
      companyHref: position.companyHref ?? '',
      endLabel: position.end,
      positionId: position.id,
      role: position.role,
      sortOrder: index,
      start: position.start,
      url: position.url ?? '',
      weight: position.weight ?? 0,
    })),
    achievements: source.experience.positions.flatMap(
      (position, positionIndex) =>
        position.achievements.map((achievement, achievementIndex) => ({
          body: achievement.body,
          metric: achievement.metric ?? '',
          positionId: position.id,
          sortOrder: positionIndex * 100 + achievementIndex,
          tags: achievement.tags.join('\n'),
          title: achievement.title,
        })),
    ),
    otherRoles: source.experience.other.map((role, index) => ({
      body: role.body ?? '',
      company: role.company,
      period: role.period,
      role: role.role,
      sortOrder: index,
      tags: (role.tags ?? []).join('\n'),
    })),
    education: source.experience.education.map((item, index) => ({
      detail: item.detail,
      institution: item.institution ?? '',
      sortOrder: index,
      title: item.title,
    })),
  };
}

function normalizedRecordsFromSource(
  source: ResumeSource,
): ResumeSourceRecords {
  const profiles = [
    {
      active: true,
      email: source.profile.email,
      id: 'profile-default',
      isDefault: true,
      name: source.profile.name,
      profileKey: 'default',
      summary: source.profile.summary,
      title: source.profile.title,
    },
  ];
  const skillCategories = source.skills.groups.map((group, index) => ({
    categoryKey: group.id,
    id: `category-${group.id}`,
    label: group.label,
    sortOrder: index,
  }));
  const skillCategoryMembers = source.skills.groups.flatMap(
    (group, groupIndex) =>
      group.skills.map((skill, skillIndex) => ({
        categoryId: `category-${group.id}`,
        id: `skill-${skill.id}`,
        label: skill.label,
        sortOrder: groupIndex * 100 + skillIndex,
        tagId: skill.id,
      })),
  );
  const skillGroups = source.skills.skillGroups.map((group, index) => ({
    blurb: group.blurb,
    groupKey: group.id,
    id: `group-${group.id}`,
    label: group.label,
    sortOrder: index,
  }));

  return {
    achievements: source.experience.positions.flatMap(
      (position, positionIndex) =>
        position.achievements.map((achievement, achievementIndex) => ({
          body: achievement.body,
          experienceId: `experience-${position.id}`,
          id: `achievement-${position.id}-${achievementIndex}`,
          metric: achievement.metric ?? '',
          projectId: '',
          sortOrder: positionIndex * 100 + achievementIndex,
          title: achievement.title,
        })),
    ),
    achievementAttachments: [],
    achievementTags: source.experience.positions.flatMap((position) =>
      position.achievements.flatMap((achievement, achievementIndex) =>
        achievement.tags.map((tagId) => ({
          achievementId: `achievement-${position.id}-${achievementIndex}`,
          tagId,
          tagRole: 'skill',
        })),
      ),
    ),
    attachments: [],
    companies: source.experience.positions.map((position) => ({
      id: `company-${position.id}`,
      name: position.company,
      websiteUrl: position.companyHref ?? '',
    })),
    companyAttachments: [],
    duties: [],
    dutyTags: [],
    education: source.experience.education.map((item, index) => ({
      detail: item.detail,
      id: `education-${index}`,
      institution: item.institution ?? '',
      profileKey: 'default',
      sortOrder: index,
      title: item.title,
    })),
    educationTags: [],
    experienceCompanies: source.experience.positions.map((position, index) => ({
      companyHrefSnapshot: position.companyHref ?? '',
      companyId: `company-${position.id}`,
      companyNameSnapshot: position.company,
      experienceId: `experience-${position.id}`,
      isPrimary: true,
      sortOrder: index,
    })),
    experienceRoles: source.experience.positions.map((position, index) => ({
      endDate: new Date(
        `${position.end === 'Present' ? '2026' : position.end.slice(-4)}-01-01`,
      ).toISOString(),
      endPrecision: position.end === 'Present' ? 'present' : 'year',
      experienceId: `experience-${position.id}`,
      roleId: `role-${position.id}`,
      sortOrder: index,
      startDate: new Date(`${position.start.slice(-4)}-01-01`).toISOString(),
      startPrecision: 'year',
      titleSnapshot: position.role,
    })),
    experienceTags: [],
    experiences: source.experience.positions.map((position, index) => ({
      endDate: new Date(
        `${position.end === 'Present' ? '2026' : position.end.slice(-4)}-01-01`,
      ).toISOString(),
      endPrecision: position.end === 'Present' ? 'present' : 'year',
      experienceKey: position.id,
      id: `experience-${position.id}`,
      sortOrder: index,
      startDate: new Date(`${position.start.slice(-4)}-01-01`).toISOString(),
      startPrecision: 'year',
      summary: position.blurb ?? '',
      url: position.url ?? '',
      weight: position.weight ?? 0,
    })),
    otherRoles: source.experience.other.map((role, index) => ({
      body: role.body ?? '',
      company: role.company,
      period: role.period,
      role: role.role,
      sortOrder: index,
      tags: (role.tags ?? []).join('\n'),
    })),
    profileLinks: source.profile.links.map((link, index) => ({
      ...link,
      profileKey: 'default',
      sortOrder: index,
    })),
    profiles,
    projects: [],
    projectAttachments: [],
    projectTags: [],
    roles: source.experience.positions.map((position) => ({
      id: `role-${position.id}`,
      label: position.role,
    })),
    roleTags: [],
    skillCategories,
    skillCategoryMembers,
    skillGroups,
    skillGroupMembers: source.skills.skillGroups.flatMap((group, groupIndex) =>
      group.skills.map((tagId, skillIndex) => ({
        groupId: `group-${group.id}`,
        sortOrder: groupIndex * 100 + skillIndex,
        tagId,
      })),
    ),
  };
}

describe('assembleResumeSourceFromRecords', () => {
  it('assembles normalized source records into renderer-facing resume data', () => {
    const legacy = loadLegacyResumeSource();

    const assembled = assembleResumeSourceFromRecords(
      normalizedRecordsFromSource(legacy),
    );

    expect(assembled?.profile).toEqual(legacy.profile as Profile);
    expect(assembled?.skills).toEqual(legacy.skills as Skills);
    expect(
      assembled?.experience.positions.map((position) => position.id),
    ).toEqual(legacy.experience.positions.map((position) => position.id));
    expect(assembled?.experience.positions[0]?.end).toBe(
      legacy.experience.positions[0]?.end,
    );
    expect(assembled?.experience.positions[0]?.achievements[0]?.tags).toEqual(
      legacy.experience.positions[0]?.achievements[0]?.tags,
    );
    expect(assembled?.experience.education).toEqual(
      legacy.experience.education as Experience['education'],
    );
    expect(assembled?.experience.other).toEqual(
      legacy.experience.other as Experience['other'],
    );
  });

  it('returns null when no candidate profile exists', () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    records.profiles = [];

    expect(assembleResumeSourceFromRecords(records)).toBeNull();
  });

  it('assembles the profile selected by key and its own links, and the default otherwise', () => {
    const legacy = loadLegacyResumeSource();
    const records = normalizedRecordsFromSource(legacy);
    records.profiles.push({
      active: true,
      email: 'consulting@example.com',
      id: 'profile-consulting',
      isDefault: false,
      name: 'Example (Consulting)',
      phone: '+1 555 0100',
      profileKey: 'consulting',
      summary: 'Fractional platform leadership.',
      title: 'Fractional CTO',
    });
    records.profileLinks.push({
      href: 'https://consulting.example.com',
      label: 'Consulting',
      profileKey: 'consulting',
      sortOrder: 0,
    });

    const selected = assembleResumeSourceFromRecords(records, {
      profileKey: 'consulting',
    });
    expect(selected?.profile).toMatchObject({
      name: 'Example (Consulting)',
      title: 'Fractional CTO',
      summary: 'Fractional platform leadership.',
      links: [{ label: 'Consulting', href: 'https://consulting.example.com' }],
    });

    const defaulted = assembleResumeSourceFromRecords(records);
    expect(defaulted?.profile).toEqual(legacy.profile as Profile);
    expect(
      assembleResumeSourceFromRecords(records, { profileKey: '' })?.profile,
    ).toEqual(legacy.profile as Profile);

    expect(
      assembleResumeSourceFromRecords(records, { profileKey: 'missing' }),
    ).toBeNull();

    expect(resumeProfileSummaries(records.profiles)).toEqual([
      {
        active: true,
        default: true,
        key: 'default',
        name: legacy.profile.name,
      },
      {
        active: true,
        default: false,
        key: 'consulting',
        name: 'Example (Consulting)',
      },
    ]);
    expect(
      JSON.stringify(resumeProfileSummaries(records.profiles)),
    ).not.toMatch(/email|phone|example\.com/);
  });

  it('omits normalized skill members marked as hidden from the resume', () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    const hiddenSkill = records.skillCategoryMembers[0];
    hiddenSkill.useOnResume = false;

    const assembled = assembleResumeSourceFromRecords(records);

    expect(
      assembled?.skills.groups
        .flatMap((group) => group.skills)
        .map((skill) => skill.id),
    ).not.toContain(hiddenSkill.tagId);
  });

  it('normalizes canonical SMRT tag IDs back to renderer-facing slugs', () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    const skill = records.skillCategoryMembers[0];
    const originalSlug = String(skill.tagId);
    const canonicalId = '63374921-f037-441e-976a-1a48e07c8342';
    records.tags = [{ id: canonicalId, slug: originalSlug }];
    skill.tagId = canonicalId;
    skill.label = '';
    const achievementTag = records.achievementTags.find(
      (record) => record.tagId === originalSlug,
    );
    expect(achievementTag).toBeDefined();
    if (achievementTag) achievementTag.tagId = canonicalId;

    const assembled = assembleResumeSourceFromRecords(records);

    expect(assembled?.skills.groups[0]?.skills[0]?.id).toBe(originalSlug);
    expect(assembled?.skills.groups[0]?.skills[0]?.label).toBe(originalSlug);
    expect(
      assembled?.experience.positions.flatMap((position) =>
        position.achievements.flatMap((achievement) => achievement.tags),
      ),
    ).toContain(originalSlug);
    expect(JSON.stringify(assembled)).not.toContain(canonicalId);
  });

  it('assembles achievement attachment metadata from attachment joins', () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    const achievementId = records.achievements[0]?.id;
    records.attachments = [
      {
        altText: 'Architecture screenshot',
        filePath: 'source/achievements/architecture.png',
        id: 'attachment-architecture',
        kind: 'image',
        mimeType: 'image/png',
        title: 'Architecture proof',
        visibility: 'private',
      },
    ];
    records.achievementAttachments = [
      {
        achievementId,
        attachmentId: 'attachment-architecture',
        sortOrder: 0,
        usage: 'screenshot',
      },
    ];

    const assembled = assembleResumeSourceFromRecords(records);

    expect(
      assembled?.experience.positions[0]?.achievements[0]?.attachments,
    ).toEqual([
      {
        altText: 'Architecture screenshot',
        filePath: 'source/achievements/architecture.png',
        id: 'attachment-architecture',
        kind: 'image',
        mimeType: 'image/png',
        sourceUrl: undefined,
        title: 'Architecture proof',
        caption: undefined,
        visibility: 'private',
      },
    ]);
  });

  it('preserves project URLs for resume rendering', () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    const experienceId = records.experiences[0]?.id;
    records.projects = [
      {
        experienceId,
        id: 'project-happyvertical-sdk',
        name: 'Happy Vertical SDK',
        projectKey: 'happyvertical-sdk',
        sortOrder: 0,
        summary: 'Reusable foundation packages.',
        url: 'https://github.com/happyvertical/sdk',
      },
    ];

    const assembled = assembleResumeSourceFromRecords(records);

    expect(assembled?.experience.positions[0]?.projects?.[0]).toMatchObject({
      id: 'happyvertical-sdk',
      name: 'Happy Vertical SDK',
      summary: 'Reusable foundation packages.',
      url: 'https://github.com/happyvertical/sdk',
    });
  });

  it('nests project achievements under their project instead of the position', () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    const experienceId = records.experiences[0]?.id;
    records.projects = [
      {
        experienceId,
        id: 'project-smrt',
        name: 's-m-r-t Framework',
        projectKey: 'smrt',
        sortOrder: 0,
        summary: 'Define-once app framework.',
      },
    ];
    records.achievements.push({
      body: 'Generated REST APIs, CLI commands, MCP tools, and migrations from class definitions.',
      experienceId,
      id: 'achievement-smrt-codegen',
      metric: '37 packages',
      projectId: 'project-smrt',
      sortOrder: 0,
      title: 'Code generation',
    });
    records.achievementTags.push({
      achievementId: 'achievement-smrt-codegen',
      tagId: 'typescript',
      tagRole: 'skill',
    });

    const assembled = assembleResumeSourceFromRecords(records);
    const position = assembled?.experience.positions[0];
    const project = position?.projects?.[0];

    expect(project).toMatchObject({
      id: 'smrt',
      name: 's-m-r-t Framework',
      achievements: [
        {
          body: 'Generated REST APIs, CLI commands, MCP tools, and migrations from class definitions.',
          id: 'achievement-smrt-codegen',
          metric: '37 packages',
          tags: ['typescript'],
          title: 'Code generation',
        },
      ],
    });
    expect(
      position?.achievements.some(
        (achievement) => achievement.id === 'achievement-smrt-codegen',
      ),
    ).toBe(false);
  });

  it('can render a project achievement at both the project and position levels', () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    const experienceId = records.experiences[0]?.id;
    records.projects = [
      {
        experienceId,
        id: 'project-smrt',
        name: 's-m-r-t Framework',
        projectKey: 'smrt',
        sortOrder: 0,
        summary: 'Define-once app framework.',
      },
    ];
    records.achievements.push({
      body: 'Kept the framework narrative visible at both the company and project levels.',
      experienceId,
      id: 'achievement-smrt-both',
      projectId: 'project-smrt',
      resumePlacement: 'both',
      sortOrder: 0,
      title: 'Framework narrative',
    });

    const assembled = assembleResumeSourceFromRecords(records);
    const position = assembled?.experience.positions[0];

    expect(position?.projects?.[0]?.achievements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'achievement-smrt-both' }),
      ]),
    );
    expect(position?.achievements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'achievement-smrt-both' }),
      ]),
    );
  });

  it('preserves experience URLs for resume rendering', () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    const firstExperience = records.experiences[0];
    if (!firstExperience) throw new Error('expected fixture experience');

    firstExperience.url = 'https://example.invalid/work/sdk';

    const assembled = assembleResumeSourceFromRecords(records);

    expect(assembled?.experience.positions[0]?.url).toBe(
      'https://example.invalid/work/sdk',
    );
  });
});

describe('assembleResumeSourceFromLegacyRecords', () => {
  it('keeps normalized and legacy canonical bytes unchanged while excluding incomplete education and other roles', () => {
    const expected: ResumeSource = {
      profile: {
        name: 'Fictional Candidate',
        title: '',
        email: '',
        summary: '',
        links: [],
      },
      skills: { skillGroups: [], groups: [] },
      experience: {
        positions: [],
        other: [
          {
            role: 'Engineer',
            company: 'Example',
            period: '2020',
            body: 'Original body',
            tags: [],
          },
        ],
        education: [
          {
            title: 'Degree',
            institution: 'Example',
            detail: 'Original detail',
          },
        ],
      },
    };
    const normalized = normalizedRecordsFromSource(expected);
    const legacy = legacyRecordsFromSource(expected);
    // The existing assembler normalizes strings before its membership filter.
    for (const records of [normalized, legacy]) {
      records.education[0].title = '  Degree  ';
      records.otherRoles[0].role = '  Engineer  ';
    }
    const baseline = [
      assembleResumeSourceFromRecords(normalized),
      assembleResumeSourceFromLegacyRecords(legacy),
    ];
    for (const records of [normalized, legacy]) {
      records.education.push({
        id: 'whitespace-education',
        title: ' ',
        institution: '',
        detail: ' ',
      });
      records.otherRoles.push({
        id: 'whitespace-other',
        role: ' ',
        company: ' ',
        period: ' ',
        body: '',
        tags: [],
      });
      records.education.push({
        id: 'incomplete-education',
        title: 'Hidden degree',
        detail: '',
      });
      records.otherRoles.push({
        id: 'incomplete-other',
        role: 'Hidden role',
        company: '',
        period: '2022',
      });
    }
    for (const [index, assembled] of [
      assembleResumeSourceFromRecords(normalized),
      assembleResumeSourceFromLegacyRecords(legacy),
    ].entries()) {
      expect(assembled).toEqual(expected);
      expect(JSON.stringify(assembled)).toBe(JSON.stringify(baseline[index]));
    }
  });
  it('reconstructs the legacy JSON resume shape from old resume admin records', () => {
    const legacy = loadLegacyResumeSource();

    const assembled = assembleResumeSourceFromLegacyRecords(
      legacyRecordsFromSource(legacy),
    );

    expect(assembled).toEqual({
      profile: legacy.profile as Profile,
      skills: legacy.skills as Skills,
      experience: legacy.experience as Experience,
    });
  });
});

describe('SMRT resume collection read plans', () => {
  it('uses a bounded normalized read plan with stable key and collection ordering', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    await expect(loadNormalizedResumeSource()).resolves.toBeNull();

    const [plan, options] = mocks.executeCollectionReadPlan.mock.calls[0] as [
      Record<string, { className: string; options: unknown }>,
      { collectionOptions: unknown; maxConcurrency: number },
    ];
    expect(Object.keys(plan)).toEqual([
      'achievements',
      'achievementAttachments',
      'achievementTags',
      'attachments',
      'companies',
      'companyAttachments',
      'duties',
      'dutyTags',
      'education',
      'educationTags',
      'experienceCompanies',
      'experienceRoles',
      'experienceTags',
      'experiences',
      'otherRoles',
      'profileLinks',
      'profiles',
      'projects',
      'projectAttachments',
      'projectTags',
      'roles',
      'roleTags',
      'skillCategories',
      'skillCategoryMembers',
      'skillGroups',
      'skillGroupMembers',
      'tags',
    ]);
    expect(plan.achievements).toEqual({
      className: 'Achievement',
      options: { limit: 1000, orderBy: 'sortOrder ASC' },
    });
    expect(plan.profileLinks).toEqual({
      className: 'CandidateProfileLink',
      options: { limit: 1001, orderBy: 'id ASC' },
    });
    expect(plan.tags).toEqual({
      className: 'Tag',
      options: { limit: 1000, orderBy: 'slug ASC' },
    });
    expect(options).toEqual({
      collectionOptions: { db: 'request-db' },
      maxConcurrency: 2,
    });
  });

  it('uses the same bounded executor for the legacy read plan without changing result ordering', async () => {
    const legacy = loadLegacyResumeSource();
    const records = legacyRecordsFromSource(legacy);
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      Object.fromEntries(
        Object.keys(plan).map((key) => [
          key,
          records[key as keyof LegacyResumeSourceRecords],
        ]),
      ),
    );

    await expect(loadLegacyAdminResumeSource()).resolves.toEqual(legacy);

    const [plan, options] = mocks.executeCollectionReadPlan.mock.calls[0] as [
      Record<string, { className: string; options: unknown }>,
      { collectionOptions: unknown; maxConcurrency: number },
    ];
    expect(Object.keys(plan)).toEqual([
      'achievements',
      'education',
      'links',
      'otherRoles',
      'positions',
      'profiles',
      'skillCategories',
      'skillGroups',
      'skills',
    ]);
    expect(plan.positions).toEqual({
      className: 'ResumePosition',
      options: { limit: 1000, orderBy: 'sortOrder ASC' },
    });
    expect(options).toEqual({
      collectionOptions: { db: 'request-db' },
      maxConcurrency: 2,
    });
  });

  it('restores approved profile-link ordering before the trusted server projection', async () => {
    const records = normalizedRecordsFromSource(loadLegacyResumeSource());
    records.profileLinks = [
      {
        href: 'https://example.invalid/third',
        id: 'link-third',
        label: 'Third',
        profileKey: 'default',
        sortOrder: 2,
      },
      {
        href: 'https://example.invalid/first-b',
        id: 'link-b',
        label: 'First B',
        profileKey: 'default',
        sortOrder: 1,
      },
      {
        href: 'https://example.invalid/first-a',
        id: 'link-a',
        label: 'First A',
        profileKey: 'default',
        sortOrder: 1,
      },
    ];
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      Object.fromEntries(
        Object.keys(plan).map((key) => [
          key,
          records[key as keyof ResumeSourceRecords] ?? [],
        ]),
      ),
    );

    const source = await loadNormalizedResumeSource();

    expect(source?.profile.links).toEqual([
      { href: 'https://example.invalid/first-a', label: 'First A' },
      { href: 'https://example.invalid/first-b', label: 'First B' },
      { href: 'https://example.invalid/third', label: 'Third' },
    ]);
    expect(source?.profile).not.toHaveProperty('profileKey');
    expect(source?.profile.links[0]).not.toHaveProperty('sortOrder');
  });

  it('fails closed instead of changing the legacy top-1000 membership', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      Object.fromEntries(
        Object.keys(plan).map((key) => [
          key,
          key === 'profileLinks'
            ? Array.from({ length: 1001 }, () => ({}))
            : [],
        ]),
      ),
    );

    await expect(loadNormalizedResumeSource()).rejects.toThrow(
      'Published resume read exceeds the supported 1000-row limit for profileLinks.',
    );
  });

  it('keeps concurrent request database options isolated', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );
    const firstDatabase = { id: 'first-request-db' };
    const secondDatabase = { id: 'second-request-db' };
    mocks.getRequestScopedSmrtOptions
      .mockReturnValueOnce({ db: firstDatabase })
      .mockReturnValueOnce({ db: secondDatabase });

    await Promise.all([
      loadNormalizedResumeSource(),
      loadNormalizedResumeSource(),
    ]);

    expect(mocks.executeCollectionReadPlan.mock.calls[0]?.[1]).toEqual({
      collectionOptions: { db: firstDatabase },
      maxConcurrency: 2,
    });
    expect(mocks.executeCollectionReadPlan.mock.calls[1]?.[1]).toEqual({
      collectionOptions: { db: secondDatabase },
      maxConcurrency: 2,
    });
  });
});

describe('loadPublishedResumeSource', () => {
  it('returns a neutral payload for a shared hosted landing request', async () => {
    mocks.isSharedHosted.mockReturnValue(true);

    await expect(loadPublishedResumeSource()).resolves.toEqual({
      experience: { education: [], other: [], positions: [] },
      profile: { email: '', links: [], name: '', summary: '', title: '' },
      skills: { groups: [], skillGroups: [] },
    });
    expect(mocks.executeCollectionReadPlan).not.toHaveBeenCalled();
  });

  it('does not hide current resume source load failures behind bundled legacy data', async () => {
    await expect(loadPublishedResumeSource()).rejects.toThrow(
      'database unavailable',
    );
  });

  it('coalesces concurrent cache misses and serves subsequent hits without queries', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    await expect(
      Promise.all([
        getCachedPublishedResumeSource(),
        getCachedPublishedResumeSource(),
      ]),
    ).resolves.toHaveLength(2);

    // The published loader checks normalized then legacy records once; the
    // cache shares that single in-flight loader between both callers.
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(2);

    await expect(getCachedPublishedResumeSource()).resolves.toBeDefined();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(2);
  });

  it('isolates cached resume data by request database and tenant context', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );
    const sharedDatabase = {
      type: 'postgres',
      url: 'postgresql://example.test/resume',
    };

    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database: sharedDatabase,
      tenantId: 'tenant-a',
    });
    await expect(getCachedPublishedResumeSource()).resolves.toBeDefined();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(2);

    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database: { ...sharedDatabase, url: 'postgresql://example.test/other' },
      tenantId: 'tenant-a',
    });
    await expect(getCachedPublishedResumeSource()).resolves.toBeDefined();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(4);

    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database: sharedDatabase,
      tenantId: 'tenant-b',
    });
    await expect(getCachedPublishedResumeSource()).resolves.toBeDefined();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(6);

    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database: sharedDatabase,
      tenantId: 'tenant-a',
    });
    await expect(getCachedPublishedResumeSource()).resolves.toBeDefined();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(6);
  });

  it('serves warm hits from the stamp window without any database work', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    await getCachedPublishedResumeSource();
    const plansAfterLoad = mocks.executeCollectionReadPlan.mock.calls.length;
    const stampsAfterLoad = mocks.loadPublishedResumeStamp.mock.calls.length;

    await getCachedPublishedResumeSource();
    await getCachedPublishedResumeSource();

    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(
      plansAfterLoad,
    );
    expect(mocks.loadPublishedResumeStamp).toHaveBeenCalledTimes(
      stampsAfterLoad,
    );
  });

  it('rechecks the stamp past the window and reloads only when it moved', async () => {
    vi.useFakeTimers();
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    await getCachedPublishedResumeSource();
    const plansAfterLoad = mocks.executeCollectionReadPlan.mock.calls.length;

    // Unchanged stamp: one cheap probe, no read plan.
    vi.advanceTimersByTime(5_001);
    await getCachedPublishedResumeSource();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(
      plansAfterLoad,
    );
    expect(mocks.loadPublishedResumeStamp).toHaveBeenCalledTimes(2);

    // Changed stamp: the read plan runs again. This is what lets a replica that
    // did not handle the admin write still observe it.
    mocks.loadPublishedResumeStamp.mockResolvedValue('stamp-2');
    vi.advanceTimersByTime(5_001);
    await getCachedPublishedResumeSource();
    expect(mocks.executeCollectionReadPlan.mock.calls.length).toBeGreaterThan(
      plansAfterLoad,
    );
  });

  it('falls back to the cached payload when the stamp probe fails', async () => {
    vi.useFakeTimers();
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    await getCachedPublishedResumeSource();
    const plansAfterLoad = mocks.executeCollectionReadPlan.mock.calls.length;

    mocks.loadPublishedResumeStamp.mockRejectedValue(
      new Error('database unavailable'),
    );
    vi.advanceTimersByTime(5_001);

    await expect(getCachedPublishedResumeSource()).resolves.toBeDefined();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(
      plansAfterLoad,
    );
  });

  it('exposes the stamp alongside the payload for conditional responses', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    await expect(getCachedPublishedResume()).resolves.toMatchObject({
      stamp: 'stamp-1',
    });
  });

  it('reports no stamp when the database identity is unknown', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );
    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database: { handle: 'opaque', type: 'postgres' },
      tenantId: 'tenant-a',
    });

    const result = await getCachedPublishedResume();

    expect(result.stamp).toBeNull();
    expect(mocks.loadPublishedResumeStamp).not.toHaveBeenCalled();
  });

  it('keeps the configured pool size on the stamp database (#93)', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );
    const database = {
      max: 5,
      type: 'postgres',
      url: 'postgresql://example.test/resume',
    };
    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database,
      tenantId: 'tenant-a',
    });
    mocks.getRequestScopedSmrtOptions.mockReturnValue({ db: database });

    await getCachedPublishedResumeSource();

    // The first resolver of `smrt:<url>` sizes the shared pool, so dropping
    // `max` here reverted every process to the SQL default of 20 clients.
    expect(mocks.loadPublishedResumeStamp).toHaveBeenCalledWith(
      expect.objectContaining({ max: 5 }),
    );
  });

  it('stamps against the same database the payload was loaded from', async () => {
    // The isolation property that matters: a stamp read from one database must
    // never validate a payload loaded from another. Assert BOTH sides come from
    // the same context — checking only the stamp call would let a regression
    // that stamps A while loading B pass unnoticed.
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );
    const database = {
      type: 'postgres',
      url: 'postgresql://example.test/resume',
    };
    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database,
      tenantId: 'tenant-a',
    });
    mocks.getRequestScopedSmrtOptions.mockReturnValue({ db: database });

    await getCachedPublishedResumeSource();

    expect(mocks.loadPublishedResumeStamp).toHaveBeenCalledWith(database);
    for (const call of mocks.executeCollectionReadPlan.mock.calls) {
      expect(
        (call[1] as { collectionOptions: unknown }).collectionOptions,
      ).toEqual({
        db: database,
      });
    }
  });

  it('does not cache behind a live database handle', async () => {
    // A live handle carries an open transaction, session variables, or an RLS
    // tenant scope that a reconstructed endpoint connection cannot reproduce, so
    // the stamp could see a different row set than the payload. Bypass instead.
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );
    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database: {
        query: () => Promise.resolve({ rows: [] }),
        type: 'postgres',
        url: 'postgresql://example.test/resume',
      },
      tenantId: 'tenant-a',
    });

    const result = await getCachedPublishedResume();

    expect(result.stamp).toBeNull();
    expect(mocks.loadPublishedResumeStamp).not.toHaveBeenCalled();

    // ...and it stays uncached: a second read reloads rather than reusing.
    const plansAfterFirst = mocks.executeCollectionReadPlan.mock.calls.length;
    await getCachedPublishedResume();
    expect(mocks.executeCollectionReadPlan.mock.calls.length).toBeGreaterThan(
      plansAfterFirst,
    );
  });

  it('does not reuse cached data for opaque request database handles', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database: { handle: 'first', type: 'postgres' },
      tenantId: 'tenant-a',
    });
    await expect(getCachedPublishedResumeSource()).resolves.toBeDefined();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(2);

    mocks.getCurrentSessionPermissionContext.mockReturnValue({
      database: { handle: 'second', type: 'postgres' },
      tenantId: 'tenant-a',
    });
    await expect(getCachedPublishedResumeSource()).resolves.toBeDefined();
    expect(mocks.executeCollectionReadPlan).toHaveBeenCalledTimes(4);
  });
});

describe('workspace candidate evidence', () => {
  const subject = {
    profileId: 'profile-a',
    tenantId: 'tenant-a',
    userId: 'user-a',
  };

  it('adds the full verified owner predicate to every private resume read', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    await loadNormalizedResumeSource(undefined, subject);

    const plan = mocks.executeCollectionReadPlan.mock.calls[0]?.[0] as Record<
      string,
      { options: Record<string, unknown> }
    >;
    expect(plan.experiences.options.where).toEqual({
      candidateProfileId: 'profile-a',
      ownerUserId: 'user-a',
      tenantId: 'tenant-a',
    });
    expect(plan.profiles.options.where).toEqual({
      id: 'profile-a',
      ownerUserId: 'user-a',
      tenantId: 'tenant-a',
    });
    expect(plan.skillGroups.options.where).toEqual(
      plan.experiences.options.where,
    );
    expect(plan.companies.options.where).toBeUndefined();
    expect(plan.tags.options.where).toBeUndefined();
  });

  it('keeps concurrent profile roots separate from their private child rows', async () => {
    const otherSubject = {
      profileId: 'profile-b',
      tenantId: 'tenant-b',
      userId: 'user-b',
    };
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );

    await Promise.all([
      loadNormalizedResumeSource(undefined, subject),
      loadNormalizedResumeSource(undefined, otherSubject),
    ]);

    const plans = mocks.executeCollectionReadPlan.mock.calls.map(
      ([plan]) => plan as Record<string, { options: Record<string, unknown> }>,
    );
    expect(plans).toHaveLength(2);
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          experiences: expect.objectContaining({
            options: expect.objectContaining({
              where: {
                candidateProfileId: 'profile-a',
                ownerUserId: 'user-a',
                tenantId: 'tenant-a',
              },
            }),
          }),
          profiles: expect.objectContaining({
            options: expect.objectContaining({
              where: {
                id: 'profile-a',
                ownerUserId: 'user-a',
                tenantId: 'tenant-a',
              },
            }),
          }),
        }),
        expect.objectContaining({
          experiences: expect.objectContaining({
            options: expect.objectContaining({
              where: {
                candidateProfileId: 'profile-b',
                ownerUserId: 'user-b',
                tenantId: 'tenant-b',
              },
            }),
          }),
          profiles: expect.objectContaining({
            options: expect.objectContaining({
              where: {
                id: 'profile-b',
                ownerUserId: 'user-b',
                tenantId: 'tenant-b',
              },
            }),
          }),
        }),
      ]),
    );
  });

  it('rejects unbound private reads in shared hosted mode', async () => {
    mocks.isSharedHosted.mockReturnValue(true);

    await expect(loadNormalizedResumeSource()).rejects.toThrow(
      'A verified candidate workspace subject is required.',
    );
    expect(mocks.executeCollectionReadPlan).not.toHaveBeenCalled();
  });

  it('returns only the selected candidate material and a stable scoped fingerprint', async () => {
    const resume = structuredClone(loadLegacyResumeSource());
    resume.experience.positions[0] = {
      ...resume.experience.positions[0]!,
      blurb: 'Complete private role narrative',
      duties: [
        {
          id: 'daily-pack-duty',
          title: 'Private duty',
          body: 'Designed reliable distributed platforms and coached staff engineers.',
        },
      ],
    };
    resume.experience.other = [
      {
        role: 'Advisor',
        company: 'Private Example',
        period: '2020–2022',
        body: 'Private advisory narrative',
      },
    ];
    const records = normalizedRecordsFromSource(resume);
    records.duties = [
      {
        id: 'daily-pack-duty',
        experienceId: `experience-${resume.experience.positions[0]!.id}`,
        title: 'Private duty',
        body: 'Designed reliable distributed platforms and coached staff engineers.',
      },
    ];
    records.education.push(
      {
        id: 'education-private-a',
        title: 'Certificate',
        institution: 'Example',
        detail: 'Distributed systems',
      },
      {
        id: 'education-private-b',
        title: 'Certificate',
        institution: 'Example',
        detail: 'Distributed systems',
      },
    );
    records.profiles[0] = {
      ...records.profiles[0],
      candidateProfileId: subject.profileId,
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
    };
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      Object.fromEntries(
        Object.keys(plan).map((key) => [
          key,
          records[key as keyof ResumeSourceRecords] ?? [],
        ]),
      ),
    );
    mocks.getPrivateRecord.mockResolvedValue({
      authorizedWorkCountriesJson: '["CA"]',
      citizenshipsJson: '["CA"]',
      factsJson: '{"citizenships":["CA"]}',
      id: subject.profileId,
      location: 'Edmonton, CA',
      name: 'Candidate A',
      ownerUserId: subject.userId,
      preferencesJson: '{"locations":["CA"]}',
      residenceCountryJson: '["CA"]',
      sponsorshipRequired: false,
      summary: 'Platform engineer',
      targetWorkCountryJson: '["CA"]',
      tenantId: subject.tenantId,
      title: 'Engineer',
      workAuthorization: 'Canada citizen',
    });

    const first = await loadWorkspaceCandidateEvidence(subject);
    const second = await loadWorkspaceCandidateEvidence(subject);

    expect(first.subject).toEqual(subject);
    expect(first.candidate).toEqual({
      authorizedWorkCountriesJson: '["CA"]',
      citizenshipsJson: '["CA"]',
      factsJson: '{"citizenships":["CA"]}',
      location: 'Edmonton, CA',
      preferencesJson: '{"locations":["CA"]}',
      residenceCountryJson: '["CA"]',
      sponsorshipRequired: false,
      summary: 'Platform engineer',
      targetWorkCountryJson: '["CA"]',
      title: 'Engineer',
      workAuthorization: 'Canada citizen',
    });
    expect(first.evidence.some((item) => item.kind === 'achievement')).toBe(
      true,
    );
    expect(first.evidence.some((item) => item.kind === 'skill')).toBe(true);
    expect(
      first.evidence
        .filter((item) => item.kind === 'skill')
        .every((item) => item.id.startsWith('skill:') && item.recordId),
    ).toBe(true);
    expect(
      first.evidence
        .filter((item) => item.kind === 'project')
        .every(
          (item) =>
            item.id.startsWith('project:') && item.recordId && item.sectionId,
        ),
    ).toBe(true);
    expect(first.evidence.some((item) => item.kind === 'employment')).toBe(
      true,
    );
    expect(
      first.evidence.some(
        (item) =>
          item.kind === 'duty' && item.text.includes('coached staff engineers'),
      ),
    ).toBe(true);
    expect(
      first.evidence.some(
        (item) =>
          item.kind === 'employment' &&
          item.text.includes('Complete private role narrative'),
      ),
    ).toBe(true);
    expect(
      first.evidence.some(
        (item) =>
          item.kind === 'employment' &&
          item.text.includes('Private advisory narrative'),
      ),
    ).toBe(true);
    const duplicateEducation = first.evidence.filter(
      (item) => item.kind === 'education' && item.title === 'Certificate',
    );
    expect(duplicateEducation.map((item) => item.id)).toEqual([
      'education:education-private-a',
      'education:education-private-b',
    ]);
    expect(
      duplicateEducation.every(
        (item) => item.sectionId === `profile:${subject.profileId}`,
      ),
    ).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
    const profile = await mocks.getPrivateRecord.mock.results[0]?.value;
    mocks.getPrivateRecord.mockResolvedValue({
      ...profile,
      preferencesJson: '{"weight":99}',
    });
    expect((await loadWorkspaceCandidateEvidence(subject)).fingerprint).toBe(
      first.fingerprint,
    );
    expect(mocks.getPrivateRecord).toHaveBeenCalledWith(
      'CandidateProfile',
      subject.profileId,
      subject,
    );
  });

  it('includes confirmed private skills with exact introductory limits and citations', async () => {
    const records = normalizedRecordsFromSource(
      structuredClone(loadLegacyResumeSource()),
    );
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      Object.fromEntries(
        Object.keys(plan).map((key) => [
          key,
          records[key as keyof ResumeSourceRecords] ?? [],
        ]),
      ),
    );
    mocks.getPrivateRecord.mockResolvedValue({
      id: subject.profileId,
      tenantId: subject.tenantId,
      ownerUserId: subject.userId,
      factsJson: JSON.stringify({
        version: 1,
        facts: {
          confirmedSkills: [
            {
              id: 'confirmation-1',
              label: 'Python',
              classification: 'introductory',
              provenance: 'user_verified',
              discoveryRequestId: 'request-1',
              evidence: [
                {
                  id: 'project-1',
                  title: 'Prototype',
                  text: 'Dabbled in Python.',
                },
              ],
            },
          ],
        },
      }),
    });
    const result = await loadWorkspaceCandidateEvidence(subject);
    expect(
      result.evidence.find(
        (row) => row.id === 'confirmed-skill:confirmation-1',
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'skill_context',
        title: 'Confirmed skill: Python',
        text: 'User-confirmed skill: Python. Experience: introductory exposure only; not established proficiency.\nSupporting career record [project-1] Prototype:\nDabbled in Python.',
      }),
    );
  });

  it('rejects a forged candidate profile before loading candidate material', async () => {
    mocks.getPrivateRecord.mockResolvedValue(null);

    await expect(loadWorkspaceCandidateEvidence(subject)).rejects.toThrow(
      'Candidate profile is outside this workspace.',
    );
    expect(mocks.executeCollectionReadPlan).not.toHaveBeenCalled();
  });

  it('keeps missing sponsorship information unknown', async () => {
    mocks.executeCollectionReadPlan.mockImplementation(async (plan) =>
      emptyReadPlanResult(plan),
    );
    mocks.getPrivateRecord.mockResolvedValue({
      id: subject.profileId,
      name: 'Candidate A',
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
    });

    await expect(
      loadWorkspaceCandidateEvidence(subject),
    ).resolves.toMatchObject({
      candidate: { sponsorshipRequired: 'unknown' },
    });
  });
});

describe('parseTailoringConfigRecord', () => {
  it('parses valid JSON tailoring configs and tolerates invalid config text', () => {
    expect(
      parseTailoringConfigRecord({
        configJson:
          '{"title":"Platform Engineer","includeExperienceIds":["happy-vertical"]}',
      }).config,
    ).toEqual({
      title: 'Platform Engineer',
      includeExperienceIds: ['happy-vertical'],
    });

    expect(parseTailoringConfigRecord({ configJson: '{' }).config).toEqual({});
  });
});

describe('private resume asset history', () => {
  it('queries and returns only the verified owner profile, even if an adapter ignores where', async () => {
    const subject = {
      profileId: 'profile-owner',
      tenantId: 'tenant-owner',
      userId: 'user-owner',
    };
    const ownership = {
      candidateProfileId: subject.profileId,
      tenantId: subject.tenantId,
      ownerUserId: subject.userId,
    };
    const owned = {
      id: 'owned-resume',
      ...ownership,
      isPublished: true,
      applicationId: '',
    };
    const list = vi.fn(async () => [
      owned,
      { ...owned, id: 'foreign-owner', ownerUserId: 'foreign-user' },
      {
        ...owned,
        id: 'foreign-profile',
        candidateProfileId: 'foreign-profile',
      },
      { ...owned, id: 'foreign-tenant', tenantId: 'foreign-tenant' },
      { ...owned, id: 'owned-packet', applicationId: 'owned-application' },
    ]);
    mocks.getCollection.mockResolvedValue({ list });
    mocks.isSharedHosted.mockReturnValue(true);
    expect(await listResumeAssets(subject)).toEqual([owned]);
    expect(list).toHaveBeenCalledWith({
      limit: 1000,
      orderBy: 'updated_at DESC',
      where: ownership,
    });
    expect(await getPublishedResumeAsset(subject)).toEqual(owned);
  });
});
