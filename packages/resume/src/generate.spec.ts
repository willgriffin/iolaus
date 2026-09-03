import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFilesystem } from '@happyvertical/files';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalResumeTailoringConfig,
  fullResumeTailoringConfig,
} from './canonical.js';
import { generateResumeArtifacts } from './generate.js';
import {
  renderResumeHtml,
  renderResumeMarkdown,
  renderResumeText,
} from './render.js';
import { applyTailoring } from './tailoring.js';
import type { ResumeSource } from './types.js';

// "%PDF-" magic bytes standing in for org-renderer output.
const orgPdfMock = vi.hoisted(() => ({
  renderHtmlToPdf: vi.fn(
    async (_html: string, _options?: Record<string, unknown>) =>
      Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
  ),
  resolveChromiumExecutablePath: vi.fn(async () => undefined),
}));
vi.mock('@happyvertical/pdf', () => orgPdfMock);

const source: ResumeSource = {
  profile: {
    name: 'Example Candidate',
    title: 'Programmer',
    email: 'will@example.com',
    links: [{ label: 'GitHub', href: 'https://github.com/iolaus' }],
    summary: 'Builds systems.',
  },
  skills: {
    skillGroups: [
      {
        id: 'g-platform',
        label: 'Platform',
        blurb: 'Platform work',
        skills: ['typescript', 'kubernetes'],
      },
    ],
    groups: [
      {
        id: 'languages',
        label: 'Languages',
        skills: [
          { id: 'typescript', label: 'TypeScript' },
          { id: 'kubernetes', label: 'Kubernetes' },
        ],
      },
    ],
  },
  experience: {
    positions: [
      {
        id: 'hv',
        role: 'Founder',
        company: 'OIDC',
        start: '2024',
        end: 'Present',
        achievements: [
          {
            title: 'Platform',
            body: 'Built a platform.',
            tags: ['typescript'],
          },
          {
            title: 'Cloud',
            body: 'Built infrastructure.',
            tags: ['kubernetes'],
          },
        ],
      },
    ],
    other: [],
    education: [
      {
        title: 'Example Secondary School',
        detail: 'Technical training.',
      },
      {
        title: 'CELTA',
        detail: 'English teaching certificate.',
      },
    ],
  },
};

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
  vi.clearAllMocks();
});

async function tempFilesystem() {
  const dir = await mkdtemp(join(tmpdir(), 'resume-artifacts-'));
  tempDirs.push(dir);
  return await getFilesystem({ type: 'local', basePath: dir });
}

describe('generateResumeArtifacts', () => {
  it('writes markdown, text, html, and PDF artifacts through the filesystem abstraction', async () => {
    const filesystem = await tempFilesystem();

    const artifact = await generateResumeArtifacts({
      filesystem,
      outputDir: 'generated-resumes/test',
      pdfPathBasename: 'resume.pdf',
      pdfRenderer: async () => Buffer.from('%PDF-1.4 test\n'),
      source,
    });

    expect(artifact.pdfPath).toBe('generated-resumes/test/resume.pdf');
    expect(artifact.pdfBasename).toBe('resume.pdf');
    await expect(filesystem.read(artifact.markdownPath)).resolves.toContain(
      '# Example Candidate',
    );
    await expect(filesystem.read(artifact.textPath)).resolves.toContain(
      'Example Candidate',
    );
    await expect(filesystem.read(artifact.htmlPath)).resolves.toContain(
      '<!doctype html>',
    );
    await expect(
      filesystem.read(artifact.pdfPath, { raw: true }),
    ).resolves.toEqual(Buffer.from('%PDF-1.4 test\n'));
    expect(orgPdfMock.renderHtmlToPdf).not.toHaveBeenCalled();
  });

  it('renders the PDF via @happyvertical/pdf when no pdfRenderer is injected', async () => {
    const filesystem = await tempFilesystem();

    const artifact = await generateResumeArtifacts({
      filesystem,
      outputDir: 'generated-resumes/org',
      pdfPathBasename: 'resume.pdf',
      source,
    });

    expect(orgPdfMock.renderHtmlToPdf).toHaveBeenCalledOnce();
    const [html, options] = orgPdfMock.renderHtmlToPdf.mock.calls[0] ?? [];
    expect(html).toContain('<!doctype html>');
    expect(options).toMatchObject({
      format: 'Letter',
      margin: {
        top: '0.45in',
        bottom: '0.45in',
        left: '0.55in',
        right: '0.55in',
      },
    });
    // The renderer's bytes are what lands on disk.
    await expect(
      filesystem.read(artifact.pdfPath, { raw: true }),
    ).resolves.toEqual(Buffer.from('%PDF-'));
  });
});

describe('renderResume', () => {
  it('does not paint a page background in generated resume HTML', () => {
    const html = renderResumeHtml(
      source.profile,
      source.experience,
      source.skills,
    );

    expect(html).toMatch(/html, body \{[^}]*background: transparent;/s);
    expect(html).not.toContain('--bg: #fbfaf7;');
  });

  it('renders experience URLs in markdown and HTML resumes', () => {
    const experienceSource = JSON.parse(JSON.stringify(source)) as ResumeSource;
    const position = experienceSource.experience.positions[0];
    if (!position) throw new Error('expected fixture position');
    position.url = 'https://example.invalid/work/founder';

    const markdown = renderResumeMarkdown(
      experienceSource.profile,
      experienceSource.experience,
      experienceSource.skills,
    );
    const html = renderResumeHtml(
      experienceSource.profile,
      experienceSource.experience,
      experienceSource.skills,
    );

    expect(markdown).toContain('### OIDC');
    expect(markdown).toContain(
      '*[Founder](https://example.invalid/work/founder) | 2024 – Present*',
    );
    expect(html).toContain('<h3 class="position-company">OIDC</h3>');
    expect(html).toContain(
      '<span class="position-role"><a href="https://example.invalid/work/founder">Founder</a></span>',
    );
  });

  it('renders project URLs in markdown and HTML resumes', () => {
    const projectSource = JSON.parse(JSON.stringify(source)) as ResumeSource;
    const position = projectSource.experience.positions[0];
    if (!position) throw new Error('expected fixture position');

    position.projects = [
      {
        achievements: [],
        id: 'sdk',
        name: 'Happy Vertical SDK',
        url: 'https://github.com/happyvertical/sdk?ref=resume#readme',
      },
      {
        achievements: [],
        id: 'internal-tool',
        name: 'Internal Tool',
      },
    ];

    expect(
      renderResumeMarkdown(
        projectSource.profile,
        projectSource.experience,
        projectSource.skills,
      ),
    ).toContain(
      '#### [Happy Vertical SDK](https://github.com/happyvertical/sdk?ref=resume#readme) — https://github.com/happyvertical/sdk?ref=resume#readme',
    );
    const html = renderResumeHtml(
      projectSource.profile,
      projectSource.experience,
      projectSource.skills,
    );
    expect(html).toContain(
      '<a class="project-link" href="https://github.com/happyvertical/sdk?ref=resume#readme">Happy Vertical SDK</a>',
    );
    expect(html).toContain(
      '<a class="project-url" href="https://github.com/happyvertical/sdk?ref=resume#readme">https://github.com/happyvertical/sdk?ref=resume#readme</a>',
    );
    expect(html).toContain('class="project-qr"');
    expect(html).toContain('<svg');
    expect(html.match(/class="project-qr"/g)).toHaveLength(1);
    expect(html).toContain('<h4>Internal Tool</h4>');
  });

  it('omits the skills section when hideSkills is set', () => {
    const html = renderResumeHtml(
      source.profile,
      source.experience,
      source.skills,
      { hideSkills: true },
    );
    const markdown = renderResumeMarkdown(
      source.profile,
      source.experience,
      source.skills,
      { hideSkills: true },
    );

    expect(html).not.toContain('Technical Skills');
    expect(html).toContain('<h2 class="section-title">Experience</h2>');
    expect(markdown).not.toContain('## Technical Skills');
    expect(renderResumeText(markdown, { hideSkills: true })).not.toContain(
      'Technical Skills',
    );
    expect(markdown).toContain('## Professional Experience');
  });

  it('omits tag chips when hideTags is set', () => {
    const html = renderResumeHtml(
      source.profile,
      source.experience,
      source.skills,
      { hideTags: true },
    );

    expect(html).not.toContain('class="tag"');
    expect(html).toContain('<span class="ach-title">Platform</span>');
    expect(
      renderResumeHtml(source.profile, source.experience, source.skills),
    ).toContain('<span class="tag">TypeScript</span>');
  });

  it('renders a footer link in html, markdown, and text', () => {
    const footerLink = {
      label: 'Full detail at iolaus.localhost',
      url: 'https://iolaus.localhost',
    };
    const html = renderResumeHtml(
      source.profile,
      source.experience,
      source.skills,
      { footerLink },
    );
    const markdown = renderResumeMarkdown(
      source.profile,
      source.experience,
      source.skills,
      { footerLink },
    );
    const text = renderResumeText(markdown, { footerLink });

    expect(html).toContain(
      '<a class="footer-link" href="https://iolaus.localhost">Full detail at iolaus.localhost</a>',
    );
    expect(html).toContain('class="footer-qr"');
    expect(html.lastIndexOf('<footer class="resume-foot">')).toBeGreaterThan(
      html.lastIndexOf('Education'),
    );
    expect(
      markdown.trimEnd().endsWith(`[${footerLink.label}](${footerLink.url})`),
    ).toBe(true);
    expect(
      text.trimEnd().endsWith(`${footerLink.label}: ${footerLink.url}`),
    ).toBe(true);
    expect(renderResumeText(markdown)).not.toContain('[');
  });

  it('renders project bullets with bold achievement titles', () => {
    const projectSource = JSON.parse(JSON.stringify(source)) as ResumeSource;
    const position = projectSource.experience.positions[0];
    if (!position) throw new Error('expected fixture position');

    position.projects = [
      {
        achievements: [
          {
            body: 'Built reusable TypeScript packages across the platform.',
            id: 'sdk-bullet',
            metric: '30 packages',
            tags: [],
            title: 'SDK Architecture',
          },
        ],
        id: 'sdk',
        name: 'Happy Vertical SDK',
      },
    ];

    const markdown = renderResumeMarkdown(
      projectSource.profile,
      projectSource.experience,
      projectSource.skills,
    );
    const html = renderResumeHtml(
      projectSource.profile,
      projectSource.experience,
      projectSource.skills,
    );

    expect(markdown).toContain(
      '- **SDK Architecture:** Built reusable TypeScript packages across the platform. *(30 packages)*',
    );
    expect(html).toContain(
      '<p class="ach-body"><strong class="ach-title">SDK Architecture:</strong> Built reusable TypeScript packages across the platform.</p>',
    );
    expect(html).not.toContain(
      '<span class="ach-title">SDK Architecture</span>',
    );
  });
});

describe('applyTailoring', () => {
  it('filters education by configured title without changing the source', () => {
    const tailored = applyTailoring(
      source.profile,
      source.experience,
      source.skills,
      {
        excludeEducationTitles: ['Example Secondary School'],
      },
    );

    expect(tailored.experience.education.map((item) => item.title)).toEqual([
      'CELTA',
    ]);
    expect(source.experience.education.map((item) => item.title)).toEqual([
      'Example Secondary School',
      'CELTA',
    ]);
  });

  it('includes only configured education titles when requested', () => {
    const tailored = applyTailoring(
      source.profile,
      source.experience,
      source.skills,
      {
        includeEducationTitles: ['CELTA'],
      },
    );

    expect(tailored.experience.education.map((item) => item.title)).toEqual([
      'CELTA',
    ]);
  });

  it('keeps education in generic default configurations', () => {
    const tailored = applyTailoring(
      source.profile,
      source.experience,
      source.skills,
      canonicalResumeTailoringConfig,
    );

    expect(tailored.experience.education.map((item) => item.title)).toEqual([
      'Example Secondary School',
      'CELTA',
    ]);
    expect(source.experience.education).toHaveLength(2);
  });

  it('filters and emphasizes resume content by tailoring config', () => {
    const tailored = applyTailoring(
      source.profile,
      source.experience,
      source.skills,
      {
        emphasizeTags: ['kubernetes'],
        excludeTags: ['typescript'],
        maxAchievementsPerPosition: 1,
        title: 'Platform Engineer',
      },
    );

    expect(tailored.profile.title).toBe('Platform Engineer');
    expect(tailored.experience.positions[0]?.achievements).toEqual([
      {
        title: 'Cloud',
        body: 'Built infrastructure.',
        tags: ['kubernetes'],
      },
    ]);
    expect(tailored.skills.groups[0]?.skills[0]?.id).toBe('kubernetes');
  });

  it('renders compact experience from tailoring config as other experience', () => {
    const tailored = applyTailoring(
      source.profile,
      source.experience,
      source.skills,
      {
        compactExperienceIds: ['hv'],
      },
    );
    const markdown = renderResumeMarkdown(
      tailored.profile,
      tailored.experience,
      tailored.skills,
    );

    expect(tailored.experience.positions).toEqual([]);
    expect(tailored.experience.other).toEqual([
      {
        body: undefined,
        company: 'OIDC',
        period: '2024\u2013Present',
        role: 'Founder',
        tags: undefined,
      },
    ]);
    expect(markdown).toContain('## Other Experience');
    expect(markdown).toContain('**Founder**, OIDC *(2024\u2013Present)*');
  });

  it('compacts month-precision and fixture-style position dates to years', () => {
    const dated = JSON.parse(JSON.stringify(source)) as ResumeSource;
    const position = dated.experience.positions[0];
    if (!position) throw new Error('expected fixture position');
    position.start = 'Jun 2003';
    position.end = '2008';
    const tailored = applyTailoring(
      dated.profile,
      dated.experience,
      dated.skills,
      { compactExperienceIds: ['hv'] },
    );
    expect(tailored.experience.other[0]?.period).toBe('2003\u20132008');

    position.start = '2000-04';
    position.end = '2002-12';
    const monthly = applyTailoring(
      dated.profile,
      dated.experience,
      dated.skills,
      { compactExperienceIds: ['hv'] },
    );
    expect(monthly.experience.other[0]?.period).toBe('2000\u20132002');
  });

  it('keeps compacted positions in newest-first order among other roles', () => {
    const ordered = JSON.parse(JSON.stringify(source)) as ResumeSource;
    const position = ordered.experience.positions[0];
    if (!position) throw new Error('expected fixture position');
    position.start = '2003-06';
    position.end = '2008';
    ordered.experience.other = [
      { body: '', company: 'Newer', period: '2020\u20132021', role: 'Dev' },
      { body: '', company: 'Older', period: '1997\u20131999', role: 'Dev' },
    ];
    const tailored = applyTailoring(
      ordered.profile,
      ordered.experience,
      ordered.skills,
      { compactExperienceIds: ['hv'] },
    );
    expect(tailored.experience.other.map((role) => role.company)).toEqual([
      'Newer',
      'OIDC',
      'Older',
    ]);
  });

  it('tailors project achievements by project id while preserving experience-id fallback', () => {
    const projectSource = JSON.parse(JSON.stringify(source)) as ResumeSource;
    const position = projectSource.experience.positions[0];
    if (!position) throw new Error('expected fixture position');

    position.achievements = [];
    position.projects = [
      {
        id: 'smrt',
        name: 'SMRT',
        achievements: [
          {
            title: 'Default',
            body: 'Default project result.',
            tags: ['typescript'],
          },
          {
            title: 'Pinned',
            body: 'Pinned project result.',
            tags: ['kubernetes'],
          },
        ],
      },
    ];

    const tailored = applyTailoring(
      projectSource.profile,
      projectSource.experience,
      projectSource.skills,
      {
        maxAchievementsPerPosition: 1,
        pinnedAchievementTitles: { smrt: ['Pinned'] },
      },
    );

    expect(
      tailored.experience.positions[0]?.projects?.[0]?.achievements,
    ).toEqual([
      {
        title: 'Pinned',
        body: 'Pinned project result.',
        tags: ['kubernetes'],
      },
    ]);
  });

  it('caps project achievements independently of the position cap', () => {
    const projectSource = JSON.parse(JSON.stringify(source)) as ResumeSource;
    const position = projectSource.experience.positions[0];
    if (!position) throw new Error('expected fixture position');

    position.projects = [
      {
        achievements: ['A', 'B', 'C', 'Pinned'].map((title) => ({
          body: `${title} result.`,
          tags: [],
          title,
        })),
        id: 'smrt',
        name: 'SMRT',
      },
    ];

    const tailored = applyTailoring(
      projectSource.profile,
      projectSource.experience,
      projectSource.skills,
      {
        maxAchievementsPerPosition: 1,
        maxAchievementsPerProject: 2,
        pinnedAchievementTitles: { smrt: ['Pinned'] },
      },
    );

    expect(tailored.experience.positions[0]?.achievements).toHaveLength(1);
    expect(
      tailored.experience.positions[0]?.projects?.[0]?.achievements.map(
        (achievement) => achievement.title,
      ),
    ).toEqual(['Pinned', 'A']);
  });

  it('applies the canonical and full configs without error', () => {
    for (const config of [
      canonicalResumeTailoringConfig,
      fullResumeTailoringConfig,
    ]) {
      const tailored = applyTailoring(
        source.profile,
        source.experience,
        source.skills,
        config,
      );
      const markdown = renderResumeMarkdown(
        tailored.profile,
        tailored.experience,
        tailored.skills,
        config,
      );
      const html = renderResumeHtml(
        tailored.profile,
        tailored.experience,
        tailored.skills,
        config,
      );

      expect(markdown).not.toContain('## Technical Skills');
      expect(markdown).not.toContain('https://iolaus.localhost');
      expect(html).not.toContain('class="footer-qr"');
      expect(html).not.toContain('class="tag"');
      expect(renderResumeText(markdown, config)).not.toContain(
        'https://iolaus.localhost',
      );
    }
    expect(canonicalResumeTailoringConfig.compactExperienceIds).toEqual([]);
  });

  it('limits projects per position in original order', () => {
    const projectSource = JSON.parse(JSON.stringify(source)) as ResumeSource;
    const position = projectSource.experience.positions[0];
    if (!position) throw new Error('expected fixture position');

    position.achievements = [];
    position.projects = ['One', 'Two', 'Three'].map((name, index) => ({
      achievements: [
        {
          body: `Project ${index + 1}.`,
          tags: ['kubernetes'],
          title: name,
        },
      ],
      id: name.toLowerCase(),
      name,
    }));

    const tailored = applyTailoring(
      projectSource.profile,
      projectSource.experience,
      projectSource.skills,
      {
        maxProjectsPerPosition: 2,
      },
    );

    expect(
      tailored.experience.positions[0]?.projects?.map((project) => project.id),
    ).toEqual(['one', 'two']);
  });
});
