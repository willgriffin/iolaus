import type { ResumeSource } from '@willgriffin/iolaus-resume';
import type {
  PublicProfileSnapshotV1,
  PublicProfileVisibility,
} from '../public-profile-contract.js';

/**
 * A deliberately small, presentation-safe resume document.  This mirrors the
 * publication contract owned by the profile store; it never carries record
 * identifiers, attachment data, tags, or source metadata.
 */
export interface PublicProfileProjectionInput {
  source: ResumeSource;
  /** Private contact facts explicitly supplied by the publication workflow. */
  contacts?: { email?: string; phone?: string; location?: string };
  /** Contact facts are opt-in; resume sections are selected unless excluded. */
  visibility?: PublicProfileVisibility;
}

const MAX_TEXT = 4_000;
const MAX_SHORT_TEXT = 240;
const MAX_LINKS = 30;
const MAX_POSITIONS = 40;
const MAX_BULLETS = 30;
const MAX_PROJECTS = 20;
const MAX_EDUCATION = 20;
const MAX_OTHER = 20;
const MAX_SKILL_GROUPS = 20;
const MAX_SKILLS_PER_GROUP = 60;
const MAX_PDF_CONCURRENCY = 2;
const MAX_PDF_QUEUE = 8;

function boundedText(value: unknown, maximum = MAX_SHORT_TEXT): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

/** Accept only externally navigable web URLs.  No data/file/javascript URLs. */
export function safePublicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return !url.username &&
      !url.password &&
      (url.protocol === 'https:' || url.protocol === 'http:')
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function freeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value;
  for (const item of Object.values(value as Record<string, unknown>))
    freeze(item);
  return Object.freeze(value);
}

function isVisible(
  selection: Partial<Record<string, boolean>> | undefined,
  key: string,
  defaultValue: boolean,
): boolean {
  return selection?.[key] ?? defaultValue;
}

/**
 * Produces the exact data that a public revision may render.  The projection
 * uses an allowlist, so private ResumeSource fields can never accidentally
 * become public when its schema grows.
 */
export function projectPublicProfileSnapshot(
  input: PublicProfileProjectionInput,
): PublicProfileSnapshotV1 {
  const { source } = input;
  const contacts = input.visibility?.contacts;
  const sections = input.visibility?.sections;
  const explicitContacts = input.contacts ?? {};
  const sourceLinks = isVisible(contacts, 'links', false)
    ? source.profile.links.slice(0, MAX_LINKS).flatMap((link) => {
        const url = safePublicUrl(link.href);
        const label = boundedText(link.label, 120);
        return url && label ? [{ label, url }] : [];
      })
    : [];

  const snapshot: PublicProfileSnapshotV1 = {
    version: 1,
    name: boundedText(source.profile.name),
    title: boundedText(source.profile.title),
    summary: boundedText(source.profile.summary, MAX_TEXT),
    ...(isVisible(contacts, 'email', false) &&
    boundedText(explicitContacts.email)
      ? { email: boundedText(explicitContacts.email) }
      : {}),
    ...(isVisible(contacts, 'phone', false) &&
    boundedText(explicitContacts.phone, 80)
      ? { phone: boundedText(explicitContacts.phone) }
      : {}),
    ...(isVisible(contacts, 'location', false) &&
    boundedText(explicitContacts.location)
      ? { location: boundedText(explicitContacts.location) }
      : {}),
    links: sourceLinks,
    experience: isVisible(sections, 'experience', true)
      ? source.experience.positions
          .slice(0, MAX_POSITIONS)
          .flatMap((position) => {
            const role = boundedText(position.role);
            const company = boundedText(position.company);
            const start = boundedText(position.start, 80);
            const end = boundedText(position.end, 80);
            if (!role || !company || !start || !end) return [];
            return [
              {
                role,
                company,
                start,
                end,
                summary:
                  boundedText(position.blurb, MAX_TEXT) ||
                  'Selected experience.',
                bullets: [
                  ...(position.duties ?? [])
                    .slice(0, MAX_BULLETS)
                    .map((duty) => boundedText(duty.body, MAX_TEXT)),
                  ...position.achievements
                    .slice(0, MAX_BULLETS)
                    .map((achievement) =>
                      boundedText(
                        [
                          achievement.title,
                          achievement.body,
                          achievement.metric,
                        ]
                          .filter(Boolean)
                          .join(': '),
                        MAX_TEXT,
                      ),
                    ),
                ]
                  .filter(Boolean)
                  .slice(0, MAX_BULLETS),
                projects: (position.projects ?? [])
                  .slice(0, MAX_PROJECTS)
                  .flatMap((project) => {
                    const name = boundedText(project.name);
                    const summary = boundedText(project.summary, MAX_TEXT);
                    return name && summary
                      ? [
                          {
                            name,
                            summary,
                            ...(safePublicUrl(project.url)
                              ? { url: safePublicUrl(project.url) }
                              : {}),
                          },
                        ]
                      : [];
                  }),
              },
            ];
          })
      : [],
    education: isVisible(sections, 'education', true)
      ? source.experience.education.slice(0, MAX_EDUCATION).flatMap((entry) => {
          const institution = boundedText(entry.institution);
          const credential = boundedText(entry.title);
          if (!institution || !credential) return [];
          return [
            {
              institution,
              credential,
              ...(boundedText(entry.detail, MAX_TEXT)
                ? { summary: boundedText(entry.detail, MAX_TEXT) }
                : {}),
            },
          ];
        })
      : [],
    other: isVisible(sections, 'other', true)
      ? source.experience.other.slice(0, MAX_OTHER).flatMap((entry) => {
          const label = boundedText(
            [entry.role, entry.company].filter(Boolean).join(', '),
          );
          const value = boundedText(
            [entry.period, entry.body].filter(Boolean).join(' — '),
            MAX_TEXT,
          );
          return label && value ? [{ label, value }] : [];
        })
      : [],
    skills: isVisible(sections, 'skills', true)
      ? source.skills.groups.slice(0, MAX_SKILL_GROUPS).flatMap((group) => {
          const label = boundedText(group.label);
          const skills = group.skills
            .slice(0, MAX_SKILLS_PER_GROUP)
            .map((skill) => boundedText(skill.label, 120))
            .filter(Boolean);
          return label && skills.length ? [{ label, skills }] : [];
        })
      : [],
  };
  return freeze(snapshot);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function text(value: string | undefined): string {
  return value ? escapeHtml(value) : '';
}

function link(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

/** Shared body for an owner preview and the anonymous public page. */
export function renderPublicProfileBody(
  snapshot: PublicProfileSnapshotV1,
): string {
  const contact = [
    snapshot.email ? `<span>${text(snapshot.email)}</span>` : '',
    snapshot.phone ? `<span>${text(snapshot.phone)}</span>` : '',
    snapshot.location ? `<span>${text(snapshot.location)}</span>` : '',
    ...snapshot.links.flatMap((item) => {
      const url = safePublicUrl(item.url);
      return url ? [link(item.label, url)] : [];
    }),
  ]
    .filter(Boolean)
    .join('<span aria-hidden="true"> · </span>');
  const positions = snapshot.experience
    .map(
      (position) => `
    <article><h3>${text(position.role)}${position.company ? ` <span>at ${text(position.company)}</span>` : ''}</h3>
    <p class="muted">${text(position.start)}${position.start && position.end ? ' – ' : ''}${text(position.end)}</p>
    ${position.summary ? `<p>${text(position.summary)}</p>` : ''}
    ${position.bullets.length ? `<ul>${position.bullets.map((bullet) => `<li>${text(bullet)}</li>`).join('')}</ul>` : ''}
    ${position.projects
      .map((project) => {
        const url = safePublicUrl(project.url);
        return `<section class="project"><strong>${url ? link(project.name, url) : text(project.name)}</strong>${project.summary ? `<p>${text(project.summary)}</p>` : ''}</section>`;
      })
      .join('')}
    </article>`,
    )
    .join('');
  const education = snapshot.education
    .map(
      (entry) =>
        `<article><h3>${text(entry.credential)}</h3><p>${text(entry.institution)}</p>${entry.summary ? `<p>${text(entry.summary)}</p>` : ''}</article>`,
    )
    .join('');
  const other = snapshot.other
    .map(
      (entry) =>
        `<li><strong>${text(entry.label)}</strong>: ${text(entry.value)}</li>`,
    )
    .join('');
  const skills = snapshot.skills
    .map(
      (group) =>
        `<li><strong>${text(group.label)}</strong>: ${group.skills.map(text).join(', ')}</li>`,
    )
    .join('');
  return `<main><header><h1>${text(snapshot.name)}</h1><p class="title">${text(snapshot.title)}</p>${contact ? `<p class="contact">${contact}</p>` : ''}</header>
    ${snapshot.summary ? `<section><h2>Profile</h2><p>${text(snapshot.summary)}</p></section>` : ''}
    ${positions ? `<section><h2>Experience</h2>${positions}</section>` : ''}
    ${education ? `<section><h2>Education</h2>${education}</section>` : ''}
    ${other ? `<section><h2>Additional experience</h2><ul>${other}</ul></section>` : ''}
    ${skills ? `<section><h2>Skills</h2><ul>${skills}</ul></section>` : ''}
  </main>`;
}

/** A standalone, network-free trusted document for page responses and PDF. */
export function renderPublicProfileHtml(
  snapshot: PublicProfileSnapshotV1,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(snapshot.name)} · ${text(snapshot.title)}</title><style>
  @page { size: letter; margin: .55in; } * { box-sizing: border-box; } body { color:#172033; font: 11pt/1.5 system-ui,sans-serif; margin:0; } main { max-width: 760px; margin:auto; } h1,h2,h3,p { margin:0 0:.5rem; } h1 { font-size:2rem; } h2 { border-bottom:1px solid #cbd5e1; margin-top:1.6rem; padding-bottom:.2rem; } h3 { font-size:1.05rem; } article { break-inside:avoid; margin: 0 0 1rem; } .title { color:#334155; font-size:1.2rem; } .contact,.muted { color:#475569; } a { color:#075985; overflow-wrap:anywhere; } ul { margin:.35rem 0; padding-left:1.25rem; } .project { margin:.65rem 0 .65rem 1rem; } @media print { a { color:inherit; text-decoration:none; } }
  </style></head><body>${renderPublicProfileBody(snapshot)}</body></html>`;
}

let activePdfRenders = 0;
const pdfRenderWaiters: Array<() => void> = [];

async function withinPdfRenderLimit<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (activePdfRenders >= MAX_PDF_CONCURRENCY) {
    if (pdfRenderWaiters.length >= MAX_PDF_QUEUE)
      throw new Error(
        'Public profile PDF rendering is busy; retry the publication.',
      );
    await new Promise<void>((resolve) => pdfRenderWaiters.push(resolve));
  }
  activePdfRenders += 1;
  try {
    return await operation();
  } finally {
    activePdfRenders -= 1;
    pdfRenderWaiters.shift()?.();
  }
}

/** Render the same immutable snapshot as HTML without requesting remote assets. */
export async function renderPublicProfilePdf(
  snapshot: PublicProfileSnapshotV1,
): Promise<Uint8Array> {
  return await withinPdfRenderLimit(async () => {
    // Keep browser automation out of normal SSR page loads. The organization
    // package imports its renderer lazily too, but this avoids its dependency
    // graph entirely until a publication actually renders a PDF.
    const { renderHtmlToPdf } = await import('@happyvertical/pdf');
    return await renderHtmlToPdf(renderPublicProfileHtml(snapshot), {
      format: 'Letter',
      margin: {
        top: '0.55in',
        bottom: '0.55in',
        left: '0.55in',
        right: '0.55in',
      },
      launchTimeoutMs: 60_000,
    });
  });
}
