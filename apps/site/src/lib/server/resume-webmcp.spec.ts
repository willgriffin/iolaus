import type { ResumeSource } from '@willgriffin/iolaus-resume';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configs: vi.fn(async () => [] as Record<string, unknown>[]),
  profiles: vi.fn(async () => [] as Record<string, unknown>[]),
  source: vi.fn(
    async (_selection?: { profileKey?: string }) => ({}) as unknown,
  ),
}));

vi.mock('./resume-data.js', () => ({
  listPublishedResumeProfiles: mocks.profiles,
  listResumeTailoringConfigs: mocks.configs,
  loadPublishedResumeSource: mocks.source,
}));

/** Two selectable profiles, as `listPublishedResumeProfiles()` projects them. */
function profiles() {
  return [
    { active: true, default: true, key: 'default', name: 'Example Candidate' },
    {
      active: true,
      default: false,
      key: 'consulting',
      name: 'Example (Consulting)',
    },
  ];
}

function source(): ResumeSource {
  return {
    profile: {
      name: 'Example Candidate',
      title: 'Staff Engineer',
      email: 'will@example.com',
      summary: 'Builds platforms.',
      links: [
        { label: 'GitHub', href: 'https://github.com/example' },
        { label: 'Site', href: 'https://iolaus.localhost' },
      ],
    },
    skills: {
      skillGroups: [
        { id: 'platform', label: 'Platform', blurb: 'Infra', skills: ['k8s'] },
      ],
      groups: [
        {
          id: 'languages',
          label: 'Languages',
          skills: [
            { id: 'typescript', label: 'TypeScript' },
            { id: 'go', label: 'Go' },
          ],
        },
      ],
    },
    experience: {
      positions: [
        {
          id: 'acme',
          role: 'Staff Engineer',
          company: 'Acme',
          start: '2020',
          end: 'Present',
          blurb: 'Led platform.',
          tags: ['platform'],
          duties: [{ body: 'Ran the platform team.' }],
          projects: [
            {
              id: 'mesh',
              name: 'Mesh',
              summary: 'Service mesh rollout',
              achievements: [
                {
                  title: 'Cut latency',
                  body: 'Halved p99.',
                  metric: '50%',
                  tags: ['platform'],
                  attachments: [
                    {
                      id: 'att-1',
                      filePath: '/private/attachments/secret.pdf',
                      kind: 'document',
                      visibility: 'confidential',
                    },
                  ],
                },
              ],
            },
          ],
          achievements: [
            {
              title: 'Shipped',
              body: 'Shipped the thing.',
              tags: ['go'],
            },
          ],
        },
        {
          id: 'oldco',
          role: 'Engineer',
          company: 'OldCo',
          start: '2015',
          end: '2020',
          achievements: [{ title: 'Old win', body: 'Did it.', tags: [] }],
        },
      ],
      other: [{ role: 'Advisor', company: 'Startup', period: '2019 - 2020' }],
      education: [{ title: 'BSc', institution: 'University', detail: 'CS' }],
    },
  };
}

describe('readJobSearchResume', () => {
  beforeEach(() => {
    mocks.configs.mockReset();
    mocks.configs.mockResolvedValue([]);
    mocks.profiles.mockReset();
    mocks.profiles.mockResolvedValue(profiles());
    mocks.source.mockReset();
    mocks.source.mockResolvedValue(source());
  });

  it('returns the canonical structure without contact facts when no configs are stored', async () => {
    const { readJobSearchResume } = await import('./resume-webmcp');

    const result = await readJobSearchResume({});
    const { excluded, ...payload } = result;
    const serialized = JSON.stringify(payload);

    for (const secret of [
      'will@example.com',
      '"email"',
      '"phone"',
      '"location"',
      '"workAuthorization"',
      'secret.pdf',
      '"attachments"',
      'confidential',
      '"links"',
      '"href"',
      'https://github.com/example',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(excluded).toEqual([
      'email',
      'phone',
      'location',
      'workAuthorization',
      'profileLinks',
      'attachments',
      'candidateAnswers',
    ]);
    expect(result.tailoring).toEqual({
      slug: 'canonical',
      name: 'Canonical resume',
      source: 'canonical_default',
      available: [],
      availableTruncated: false,
    });
    expect(result.profile).toEqual({
      name: 'Example Candidate',
      title: 'Staff Engineer',
      summary: 'Builds platforms.',
    });
    expect(result.skills.groups[0]?.skills.map((skill) => skill.id)).toEqual([
      'typescript',
      'go',
    ]);
    expect(result.experience.positions.map((position) => position.id)).toEqual([
      'acme',
      'oldco',
    ]);
    expect(result.experience.positions[0]?.projects[0]).toMatchObject({
      id: 'mesh',
      achievements: [{ title: 'Cut latency', metric: '50%' }],
    });
    expect(result.experience.other).toEqual([
      {
        role: 'Advisor',
        company: 'Startup',
        period: '2019 - 2020',
        body: '',
        tags: [],
      },
    ]);
    expect(result.experience.education).toEqual([
      { title: 'BSc', institution: 'University', detail: 'CS' },
    ]);
  });

  it('applies a stored tailoring config selected by slug', async () => {
    mocks.configs.mockResolvedValue([
      {
        id: 'cfg-1',
        configSlug: 'canonical',
        name: 'Canonical resume',
        company: '',
        config: {},
      },
      {
        id: 'cfg-2',
        configSlug: 'acme-platform',
        name: 'Acme platform',
        company: 'Acme',
        config: {
          title: 'Platform Lead',
          excludePositionIds: ['oldco'],
          hideOtherExperience: true,
        },
      },
    ]);
    const { readJobSearchResume } = await import('./resume-webmcp');

    const tailored = await readJobSearchResume({ tailoring: 'acme-platform' });
    expect(tailored.tailoring).toMatchObject({
      slug: 'acme-platform',
      name: 'Acme platform',
      source: 'stored',
    });
    expect(tailored.tailoring.available.map((option) => option.slug)).toEqual([
      'canonical',
      'acme-platform',
    ]);
    expect(tailored.profile.title).toBe('Platform Lead');
    expect(
      tailored.experience.positions.map((position) => position.id),
    ).toEqual(['acme']);
    expect(tailored.experience.other).toEqual([]);

    const canonical = await readJobSearchResume({});
    expect(canonical.tailoring).toMatchObject({
      slug: 'canonical',
      source: 'stored',
    });
    expect(canonical.experience.positions).toHaveLength(2);
  });

  it('assembles the default profile when no key is requested and lists the selectable profiles', async () => {
    const { readJobSearchResume } = await import('./resume-webmcp');

    const result = await readJobSearchResume({});

    expect(mocks.source).toHaveBeenCalledWith(undefined);
    expect(result.profileKey).toBe('default');
    expect(result.profiles).toEqual([
      {
        key: 'default',
        name: 'Example Candidate',
        active: true,
        default: true,
      },
      {
        key: 'consulting',
        name: 'Example (Consulting)',
        active: true,
        default: false,
      },
    ]);
    expect(result.profilesTruncated).toBe(false);
  });

  it('selects a non-default profile by key', async () => {
    mocks.source.mockImplementation(async (selection) => {
      const selected = source();
      if (selection?.profileKey === 'consulting') {
        selected.profile = {
          ...selected.profile,
          name: 'Example (Consulting)',
          title: 'Fractional CTO',
          email: 'consulting@example.com',
        };
      }
      return selected;
    });
    const { readJobSearchResume } = await import('./resume-webmcp');

    const result = await readJobSearchResume({ profileKey: 'consulting' });

    expect(mocks.source).toHaveBeenCalledWith({ profileKey: 'consulting' });
    expect(result.profileKey).toBe('consulting');
    expect(result.profile).toEqual({
      name: 'Example (Consulting)',
      title: 'Fractional CTO',
      summary: 'Builds platforms.',
    });
    expect(JSON.stringify(result)).not.toContain('consulting@example.com');
  });

  it('rejects unknown or oversized profile keys before loading the resume', async () => {
    const { readJobSearchResume } = await import('./resume-webmcp');

    await expect(
      readJobSearchResume({ profileKey: 'missing' }),
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Resume profile not found.' },
    });
    await expect(
      readJobSearchResume({ profileKey: 'x'.repeat(121) }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it('keeps contact facts out of the profile inventory even when the loader leaks them', async () => {
    mocks.profiles.mockResolvedValue([
      {
        active: true,
        default: true,
        email: 'will@example.com',
        key: 'default',
        linkedinUrl: 'https://linkedin.com/in/example',
        name: 'Example Candidate',
        phone: '+1 555 0100',
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        active: false,
        default: false,
        key: `alt-${index}`,
        name: `Alt ${index}`,
      })),
    ]);
    const { readJobSearchResume } = await import('./resume-webmcp');

    const result = await readJobSearchResume({});
    const serialized = JSON.stringify(result.profiles);

    for (const secret of [
      'will@example.com',
      '+1 555 0100',
      'linkedin.com',
      '"email"',
      '"phone"',
      '"linkedinUrl"',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const profile of result.profiles) {
      expect(Object.keys(profile).sort()).toEqual([
        'active',
        'default',
        'key',
        'name',
      ]);
    }
    expect(result.profiles).toHaveLength(25);
    expect(result.profilesTruncated).toBe(true);
  });

  it('rejects unknown or oversized tailoring slugs', async () => {
    const { readJobSearchResume } = await import('./resume-webmcp');

    await expect(
      readJobSearchResume({ tailoring: 'missing' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readJobSearchResume({ tailoring: 'x'.repeat(121) }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('bounds list sizes and text lengths', async () => {
    const big = source();
    big.profile.summary = 's'.repeat(10_000);
    big.experience.positions = Array.from({ length: 50 }, (_, index) => ({
      id: `pos-${index}`,
      role: 'Role',
      company: 'Co',
      start: '2000',
      end: '2001',
      achievements: Array.from({ length: 40 }, (_, achievementIndex) => ({
        title: `A${achievementIndex}`,
        body: 'b'.repeat(5_000),
        tags: Array.from({ length: 60 }, (_, tag) => `t${tag}`),
      })),
    }));
    big.experience.other = Array.from({ length: 50 }, () => ({
      role: 'R',
      company: 'C',
      period: 'P',
    }));
    mocks.source.mockResolvedValue(big);
    // An uncapped stored canonical config, so the response bounds (not the
    // tailoring pipeline's own per-position caps) are what get exercised.
    mocks.configs.mockResolvedValue([
      { configSlug: 'canonical', name: 'Canonical resume', config: {} },
      ...Array.from({ length: 30 }, (_, index) => ({
        configSlug: `cfg-${index}`,
        name: `Config ${index}`,
        config: {},
      })),
    ]);
    const { readJobSearchResume } = await import('./resume-webmcp');

    const result = await readJobSearchResume({});

    expect(result.profile.summary.length).toBeLessThanOrEqual(3_001);
    expect(result.experience.positions).toHaveLength(30);
    expect(result.truncated.positions).toBe(true);
    expect(result.experience.positions[0]?.achievements).toHaveLength(20);
    expect(
      result.experience.positions[0]?.achievements[0]?.body.length,
    ).toBeLessThanOrEqual(1_001);
    expect(result.experience.positions[0]?.achievements[0]?.tags).toHaveLength(
      30,
    );
    expect(result.experience.other).toHaveLength(30);
    expect(result.tailoring.available).toHaveLength(25);
    expect(result.tailoring.availableTruncated).toBe(true);
  });
});
