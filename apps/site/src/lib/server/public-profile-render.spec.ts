import { describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ renderHtmlToPdf: vi.fn() }));
vi.mock('@happyvertical/pdf', () => pdf);

import type { ResumeSource } from '@willgriffin/iolaus-resume';
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
        start: '2021',
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
      expect.objectContaining({ format: 'Letter' }),
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
  });
});
