import { describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ renderHtmlToPdf: vi.fn() }));
vi.mock('@happyvertical/pdf', () => pdf);

import type { ResumeSource } from '@willgriffin/iolaus-resume';
import { publicProfileSnapshotSchema } from '../public-profile-contract.js';
import {
  formatPublicProfileDate,
  formatPublicProfileDateRange,
} from '../public-profile-dates.js';
import {
  projectPublicProfileSnapshot,
  renderPublicProfileBody,
  renderPublicProfileHtml,
  renderPublicProfilePdf,
  safePublicUrl,
} from './public-profile-render.js';

// Synthetic, mixed-industry evidence only.  These sentinel values model
// private fields that must never cross a publication boundary.
const source: ResumeSource = {
  profile: {
    name: 'Avery Rivera',
    title: 'Renewable Energy Operations Lead',
    email: 'PRIVATE_EMAIL_SENTINEL@example.invalid',
    summary:
      'Leads grid modernization programmes across utilities and public-sector partners.',
    links: [
      { label: 'Portfolio', href: 'https://portfolio.example/avery' },
      { label: 'file sentinel', href: 'file:///private/sentinel' },
      { label: 'script sentinel', href: 'javascript:alert(1)' },
    ],
  },
  experience: {
    positions: [
      {
        id: 'PRIVATE_POSITION_ID',
        role: 'Operations Lead',
        company: 'Northwind Renewables',
        start: '2021-03',
        end: 'Present',
        blurb: 'Coordinates field reliability and customer operations.',
        duties: [
          {
            id: 'PRIVATE_DUTY_ID',
            title: 'Reliability',
            body: 'Reduced outage restoration time with regional crews.',
            tags: ['PRIVATE_TAG'],
          },
        ],
        achievements: [
          {
            id: 'PRIVATE_ACHIEVEMENT_ID',
            title: 'Commissioning',
            body: 'Commissioned battery projects safely.',
            metric: '32 sites',
            tags: ['PRIVATE_TAG'],
            attachments: [
              {
                id: 'PRIVATE_ATTACHMENT_ID',
                filePath: '/private/sentinel.pdf',
                kind: 'document',
                sourceUrl: 'https://private.example/sentinel',
              },
            ],
          },
        ],
        projects: [
          {
            id: 'PRIVATE_PROJECT_ID',
            name: 'Grid telemetry',
            summary: 'Modernized regional monitoring.',
            url: 'https://projects.example/telemetry',
            tags: ['PRIVATE_TAG'],
            attachments: [
              {
                id: 'PRIVATE_ATTACHMENT_ID',
                filePath: '/private/sentinel.pdf',
                kind: 'document',
              },
            ],
            achievements: [
              {
                id: 'PRIVATE_PROJECT_ACHIEVEMENT_ID',
                title: 'Alerting',
                body: 'Cut false alarms with tuned thresholds.',
                metric: '40%',
                tags: ['PRIVATE_TAG'],
              },
              { title: '  ', body: '', tags: [] },
            ],
          },
          {
            id: 'PRIVATE_PROJECT_ID',
            name: 'Field tablets',
            summary: 'Replaced paper checklists.',
            achievements: [],
          },
        ],
        tags: ['PRIVATE_TAG'],
      },
    ],
    other: [
      {
        role: 'Mentor',
        company: 'Community Lab',
        period: '2018–2021',
        body: 'Supported technician apprentices.',
        tags: ['PRIVATE_TAG'],
      },
    ],
    education: [
      {
        title: 'BSc Industrial Engineering',
        institution: 'Example Polytechnic',
        detail: 'Systems design and operations.',
      },
    ],
  },
  skills: {
    groups: [
      {
        id: 'PRIVATE_CATEGORY_ID',
        label: 'Operations',
        skills: [{ id: 'PRIVATE_SKILL_ID', label: 'Incident command' }],
      },
    ],
    skillGroups: [],
  },
};

describe('public profile projection and rendering', () => {
  it('defaults contacts off, creates an immutable allowlisted snapshot, and removes private sentinels', () => {
    const snapshot = projectPublicProfileSnapshot({
      source,
      contacts: {
        email: 'avery@example.invalid',
        phone: '+1 555 0100',
        location: 'Edmonton, AB',
      },
    });

    expect(snapshot).toMatchObject({
      version: 1,
      name: 'Avery Rivera',
      links: [],
    });
    expect(snapshot).not.toHaveProperty('email');
    expect(snapshot).not.toHaveProperty('phone');
    expect(snapshot).not.toHaveProperty('location');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.experience)).toBe(true);
    expect(() => (snapshot.links as Array<unknown>).push({})).toThrow();
    const serialized = JSON.stringify(snapshot);
    for (const sentinel of [
      'PRIVATE_EMAIL_SENTINEL',
      'PRIVATE_POSITION_ID',
      'PRIVATE_DUTY_ID',
      'PRIVATE_ACHIEVEMENT_ID',
      'PRIVATE_PROJECT_ID',
      'PRIVATE_PROJECT_ACHIEVEMENT_ID',
      'PRIVATE_ATTACHMENT_ID',
      'PRIVATE_CATEGORY_ID',
      'PRIVATE_SKILL_ID',
      'PRIVATE_TAG',
      '/private/sentinel',
      'private.example',
    ])
      expect(serialized).not.toContain(sentinel);
  });

  it('includes only opted-in contacts, selected sections, and safe external links', () => {
    const snapshot = projectPublicProfileSnapshot({
      source,
      contacts: {
        email: 'avery@example.invalid',
        phone: '+1 555 0100',
        location: 'Edmonton, AB',
      },
      visibility: {
        contacts: { email: true, phone: false, location: false, links: true },
        sections: {
          education: false,
          experience: true,
          other: false,
          skills: false,
        },
      },
    });

    expect(snapshot.email).toBe('avery@example.invalid');
    expect(snapshot.phone).toBeUndefined();
    expect(snapshot.location).toBeUndefined();
    expect(snapshot.links).toEqual([
      { label: 'Portfolio', url: 'https://portfolio.example/avery' },
    ]);
    expect(snapshot.experience).toHaveLength(1);
    expect(snapshot.education).toEqual([]);
    expect(snapshot.other).toEqual([]);
    expect(snapshot.skills).toEqual([]);
  });

  it('projects project achievements as bullets, caps them, and omits the key when empty', () => {
    const snapshot = projectPublicProfileSnapshot({ source });
    const [telemetry, tablets] = snapshot.experience[0]?.projects ?? [];

    expect(telemetry).toEqual({
      name: 'Grid telemetry',
      summary: 'Modernized regional monitoring.',
      url: 'https://projects.example/telemetry',
      bullets: ['Alerting: Cut false alarms with tuned thresholds.: 40%'],
    });
    expect(tablets).toEqual({
      name: 'Field tablets',
      summary: 'Replaced paper checklists.',
    });
    expect(tablets).not.toHaveProperty('bullets');
    expect(Object.isFrozen(telemetry?.bullets)).toBe(true);
    expect(publicProfileSnapshotSchema.safeParse(snapshot).success).toBe(true);

    const [position] = source.experience.positions;
    const [project] = position?.projects ?? [];
    if (!position || !project) throw new Error('fixture position missing');
    const capped = projectPublicProfileSnapshot({
      source: {
        ...source,
        experience: {
          ...source.experience,
          positions: [
            {
              ...position,
              projects: [
                {
                  ...project,
                  achievements: Array.from({ length: 35 }, (_, index) => ({
                    title: `Win ${index}`,
                    body: 'x'.repeat(5_000),
                    tags: [],
                  })),
                },
              ],
            },
          ],
        },
      },
    });
    const bullets = capped.experience[0]?.projects[0]?.bullets ?? [];
    expect(bullets).toHaveLength(30);
    expect(bullets[0]).toHaveLength(4_000);
    expect(bullets[0]?.startsWith('Win 0: xxx')).toBe(true);
  });

  it.each([
    ['https://example.com/path', 'https://example.com/path'],
    ['http://example.com', 'http://example.com/'],
    ['https://private:secret@example.com/path', undefined],
    ['javascript:alert(1)', undefined],
    ['data:text/html,sentinel', undefined],
    ['file:///private/sentinel', undefined],
    ['not a url', undefined],
  ])('accepts only safe public URL schemes: %s', (value, expected) => {
    expect(safePublicUrl(value)).toBe(expected);
  });

  it('renders one trusted page and PDF input without hidden contacts or private sentinels', async () => {
    const snapshot = projectPublicProfileSnapshot({
      source,
      contacts: { email: 'avery@example.invalid' },
      visibility: {
        contacts: { email: false, phone: false, location: false, links: false },
        sections: {
          education: true,
          experience: true,
          other: true,
          skills: true,
        },
      },
    });
    const body = renderPublicProfileBody(snapshot);
    const html = renderPublicProfileHtml(snapshot);
    pdf.renderHtmlToPdf.mockResolvedValueOnce(new Uint8Array([37, 80, 68, 70]));
    await expect(renderPublicProfilePdf(snapshot)).resolves.toEqual(
      new Uint8Array([37, 80, 68, 70]),
    );

    expect(html).toContain(body);
    expect(pdf.renderHtmlToPdf).toHaveBeenCalledWith(
      html,
      expect.objectContaining({
        format: 'Letter',
        margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' },
      }),
    );
    for (const hidden of [
      'avery@example.invalid',
      '+1 555 0100',
      'Edmonton, AB',
      'PRIVATE_',
      'file:',
      'javascript:',
    ]) {
      expect(html).not.toContain(hidden);
      expect(body).not.toContain(hidden);
    }
    expect(html).toContain('https://projects.example/telemetry');
    expect(body).toContain(
      '<span class="dash" aria-hidden="true">—</span> Modernized regional monitoring.<ul><li>Alerting: Cut false alarms with tuned thresholds.: 40%</li></ul></li>',
    );
    expect(body).toContain(
      '<li><strong>Field tablets</strong> <span class="dash" aria-hidden="true">—</span> Replaced paper checklists.</li></ul>',
    );
  });

  it('paints the standalone document from its own palette in both colour schemes', () => {
    const html = renderPublicProfileHtml(
      projectPublicProfileSnapshot({ source }),
    );
    const styles = html.slice(
      html.indexOf('<style>'),
      html.indexOf('</style>'),
    );
    const tokens = [
      '--profile-bg',
      '--profile-ink',
      '--profile-muted',
      '--profile-rule',
      '--profile-accent',
    ];
    const lightRoot = styles.match(/:root \{([^}]*)\}/u)?.[1] ?? '';
    const darkRoot =
      styles.match(
        /@media \(prefers-color-scheme: dark\) \{ :root \{([^}]*)\}/u,
      )?.[1] ?? '';
    for (const token of tokens) {
      expect(lightRoot).toContain(`${token}:`);
      expect(darkRoot).toContain(`${token}:`);
    }
    // Background and ink both come from the tokens, so a theme wrapper or a
    // dark system scheme can never leave light ink on a dark surface.
    expect(styles).toMatch(/body \{[^}]*background:var\(--profile-bg\)/u);
    expect(styles).toMatch(/body \{[^}]*color:var\(--profile-ink\)/u);
    expect(styles).not.toMatch(/color:#[0-9a-f]{3,6}/iu);
  });

  it.each([
    ['2024-12', 'Dec 2024'],
    ['2003-09', 'Sep 2003'],
    ['2008', '2008'],
    ['2021-13', '2021'],
    ['Present', 'Present'],
    [' 2019-06 ', 'Jun 2019'],
    [undefined, ''],
  ])('formats a snapshot date for display: %s', (value, expected) => {
    expect(formatPublicProfileDate(value)).toBe(expected);
  });

  it('joins a date range with an en dash and drops a missing side', () => {
    expect(formatPublicProfileDateRange('2024-12', 'Present')).toBe(
      'Dec 2024 – Present',
    );
    expect(formatPublicProfileDateRange('2003-09', '2008')).toBe(
      'Sep 2003 – 2008',
    );
    expect(formatPublicProfileDateRange(undefined, '2023')).toBe('2023');
    expect(formatPublicProfileDateRange(undefined, undefined)).toBe('');
  });

  it('puts formatted dates on the heading line and lays sections out in reading order', () => {
    const snapshot = projectPublicProfileSnapshot({ source });
    const body = renderPublicProfileBody(snapshot);

    expect(body).toContain(
      '<h3><span class="lead">Operations Lead</span><span class="follow">Northwind Renewables</span><span class="when">Mar 2021 – Present</span></h3>',
    );
    expect(body).not.toContain('2021-03');
    // Institution leads, credential follows, detail paragraph beneath.
    expect(body).toContain(
      '<article class="keep"><h3><span class="lead">Example Polytechnic</span><span class="follow">BSc Industrial Engineering</span></h3><p>Systems design and operations.</p></article>',
    );
    // Heading, date, and summary stay together; bullet lists may break.
    expect(body).toMatch(
      /<div class="keep"><h3>.*<\/h3><p>Coordinates field reliability and customer operations\.<\/p><\/div>\s*<ul><li>/u,
    );
    // Projects are a compact list: name, summary on the same line, sub-bullets.
    expect(body).toContain(
      '<ul class="projects"><li><strong><a href="https://projects.example/telemetry" rel="noopener noreferrer">Grid telemetry</a></strong> <span class="dash" aria-hidden="true">—</span> Modernized regional monitoring.<ul><li>Alerting: Cut false alarms with tuned thresholds.: 40%</li></ul></li><li><strong>Field tablets</strong> <span class="dash" aria-hidden="true">—</span> Replaced paper checklists.</li></ul>',
    );
    const order = [
      '<h2>Profile</h2>',
      '<h2>Skills</h2>',
      '<h2>Experience</h2>',
      '<h2>Education</h2>',
      '<h2>Additional experience</h2>',
    ].map((marker) => body.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain(
      '<li><strong>Operations</strong> Incident command</li>',
    );
    // Running header repeats the name on every printed page.
    expect(body).toMatch(
      /<thead><tr><th class="running"><span>Avery Rivera<\/span><\/th><\/tr><\/thead>/u,
    );
  });

  it('embeds its serif and sans faces so the PDF never falls back to a monospace font', () => {
    const html = renderPublicProfileHtml(
      projectPublicProfileSnapshot({ source }),
    );
    const styles = html.slice(
      html.indexOf('<style>'),
      html.indexOf('</style>'),
    );
    const faces = styles.match(/@font-face \{[^}]*\}/gu) ?? [];
    expect(faces.length).toBeGreaterThanOrEqual(3);
    for (const family of ['"Source Serif 4"', '"Inter Tight"']) {
      const face = faces.find((rule) => rule.includes(`font-family:${family}`));
      expect(face).toMatch(
        /src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\) format\("woff2"\)/u,
      );
    }
    expect(styles).toMatch(/--profile-serif:"Source Serif 4"[^;]*serif;/u);
    expect(styles).toMatch(
      /body \{[^}]*font:10\.5pt\/1\.35 var\(--profile-serif\)/u,
    );
    expect(styles).not.toMatch(/monospace/u);
    expect(styles).toContain('@page { size: letter; margin: 18mm; }');
    expect(styles).toMatch(/\.keep \{ break-inside:avoid; \}/u);
    expect(styles).toMatch(/li \{[^}]*break-inside:avoid/u);
    expect(styles).toMatch(/h2 \{[^}]*break-after:avoid/u);
    expect(styles).toMatch(/h3 \{[^}]*break-after:avoid/u);
    expect(styles).not.toMatch(/article \{[^}]*break-inside/u);
    expect(html).not.toContain('https://fonts.g');
  });
});
