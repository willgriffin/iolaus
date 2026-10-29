import type { ResumeSource } from '@willgriffin/iolaus-resume';
import type {
  PublicProfileSnapshotV1,
  PublicProfileVisibility,
} from '../public-profile-contract.js';
import { formatPublicProfileDateRange } from '../public-profile-dates.js';
import { PUBLIC_PROFILE_FONT_FACES } from './public-profile-fonts.js';

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

/** Public bullet text for a position or project: duties, then achievements. */
function projectBullets(
  duties: ReadonlyArray<{ body?: string }>,
  achievements: ReadonlyArray<{
    title?: string;
    body?: string;
    metric?: string;
  }>,
): string[] {
  return [
    ...duties
      .slice(0, MAX_BULLETS)
      .map((duty) => boundedText(duty.body, MAX_TEXT)),
    ...achievements
      .slice(0, MAX_BULLETS)
      .map((achievement) =>
        boundedText(
          [achievement.title, achievement.body, achievement.metric]
            .filter(Boolean)
            .join(': '),
          MAX_TEXT,
        ),
      ),
  ]
    .filter(Boolean)
    .slice(0, MAX_BULLETS);
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
                bullets: projectBullets(
                  position.duties ?? [],
                  position.achievements,
                ),
                projects: (position.projects ?? [])
                  .slice(0, MAX_PROJECTS)
                  .flatMap((project) => {
                    const name = boundedText(project.name);
                    const summary = boundedText(project.summary, MAX_TEXT);
                    const bullets = projectBullets([], project.achievements);
                    return name && summary
                      ? [
                          {
                            name,
                            summary,
                            ...(safePublicUrl(project.url)
                              ? { url: safePublicUrl(project.url) }
                              : {}),
                            ...(bullets.length ? { bullets } : {}),
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

/**
 * Shared body for an owner preview and the anonymous public page.
 *
 * The document is one table so that Chromium repeats the `<thead>` running
 * header (name, left) at the top of every printed page; the masthead on page
 * one sits over the first instance with its own background so the name is not
 * shown twice there.  `.keep` wraps a heading with its date line and summary
 * so a heading never ends a page alone, while bullet lists are free to flow
 * across pages.  Section order (summary, skills, experience, education,
 * additional) and the type hierarchy are mirrored by `PublicProfileResume.svelte`.
 */
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
    .join('<span class="sep" aria-hidden="true">·</span>');
  const heading = (
    lead: string,
    follow: string | undefined,
    when: string,
  ): string =>
    `<h3><span class="lead">${text(lead)}</span>${follow ? `<span class="follow">${text(follow)}</span>` : ''}${when ? `<span class="when">${text(when)}</span>` : ''}</h3>`;
  const bullets = (items: readonly string[] | undefined): string =>
    items?.length
      ? `<ul>${items.map((bullet) => `<li>${text(bullet)}</li>`).join('')}</ul>`
      : '';
  const positions = snapshot.experience
    .map(
      (position) => `<article>
      <div class="keep">${heading(position.role, position.company, formatPublicProfileDateRange(position.start, position.end))}${position.summary ? `<p>${text(position.summary)}</p>` : ''}</div>
      ${bullets(position.bullets)}
      ${
        position.projects.length
          ? `<ul class="projects">${position.projects
              .map((project) => {
                const url = safePublicUrl(project.url);
                return `<li><strong>${url ? link(project.name, url) : text(project.name)}</strong>${project.summary ? ` <span class="dash" aria-hidden="true">—</span> ${text(project.summary)}` : ''}${bullets(project.bullets)}</li>`;
              })
              .join('')}</ul>`
          : ''
      }
    </article>`,
    )
    .join('');
  const education = snapshot.education
    .map(
      (entry) =>
        `<article class="keep">${heading(entry.institution, entry.credential, formatPublicProfileDateRange(entry.start, entry.end))}${entry.summary ? `<p>${text(entry.summary)}</p>` : ''}</article>`,
    )
    .join('');
  const other = snapshot.other
    .map(
      (entry) =>
        `<li><strong>${text(entry.label)}</strong> ${text(entry.value)}</li>`,
    )
    .join('');
  const skills = snapshot.skills
    .map(
      (group) =>
        `<li><strong>${text(group.label)}</strong> ${group.skills.map(text).join(', ')}</li>`,
    )
    .join('');
  return `<main><table class="doc"><thead><tr><th class="running"><span>${text(snapshot.name)}</span></th></tr></thead><tbody><tr><td>
    <header class="masthead"><h1>${text(snapshot.name)}</h1><p class="title">${text(snapshot.title)}</p>${contact ? `<p class="contact">${contact}</p>` : ''}</header>
    ${snapshot.summary ? `<section><h2>Profile</h2><p>${text(snapshot.summary)}</p></section>` : ''}
    ${skills ? `<section class="skills"><h2>Skills</h2><ul>${skills}</ul></section>` : ''}
    ${positions ? `<section><h2>Experience</h2>${positions}</section>` : ''}
    ${education ? `<section><h2>Education</h2>${education}</section>` : ''}
    ${other ? `<section class="other"><h2>Additional experience</h2><ul>${other}</ul></section>` : ''}
  </td></tr></tbody></table></main>`;
}

/** Embedded OFL faces, so the headless container never falls back to Courier. */
function fontFaces(): string {
  return PUBLIC_PROFILE_FONT_FACES.map(
    (face) =>
      `@font-face { font-family:"${face.family}"; font-style:${face.style}; font-weight:${face.weight}; font-display:block; src:url(data:font/woff2;base64,${face.data}) format("woff2"); }`,
  ).join('\n  ');
}

/** Letter page, 18mm margins; the PDF renderer passes the same margins. */
export const PUBLIC_PROFILE_PAGE_MARGIN = '18mm';

/** A standalone, network-free trusted document for page responses and PDF. */
export function renderPublicProfileHtml(
  snapshot: PublicProfileSnapshotV1,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(snapshot.name)} · ${text(snapshot.title)}</title><style>
  ${fontFaces()}
  :root { --profile-bg:#fbfaf7; --profile-ink:#1a1814; --profile-ink-soft:#3a3630; --profile-muted:#5c584f; --profile-rule:#d6d1c2; --profile-accent:#8a3f1f; --profile-serif:"Source Serif 4",Georgia,"Times New Roman",serif; --profile-sans:"Inter Tight","Liberation Sans",Arial,sans-serif; --profile-running:9mm; }
  @media (prefers-color-scheme: dark) { :root { --profile-bg:#15140f; --profile-ink:#f1ede2; --profile-ink-soft:#d5d0c2; --profile-muted:#a8a397; --profile-rule:#3d3a30; --profile-accent:#f0a880; } }
  @page { size: letter; margin: ${PUBLIC_PROFILE_PAGE_MARGIN}; }
  * { box-sizing: border-box; }
  body { background:var(--profile-bg); color:var(--profile-ink); font:10.5pt/1.35 var(--profile-serif); margin:0; -webkit-font-smoothing:antialiased; }
  main { max-width:7.5in; margin:auto; }
  table.doc { width:100%; border-collapse:collapse; }
  table.doc thead { display:table-header-group; }
  table.doc th, table.doc td { padding:0; text-align:left; font-weight:inherit; vertical-align:top; }
  .running { height:var(--profile-running); font:500 8pt/1 var(--profile-sans); color:var(--profile-muted); }
  /* Top padding keeps the glyph ink inside the box: Chromium paints the ink overflow of the next page's repeated header at the foot of the page before it. */
  .running span { display:block; padding:4pt 0 3pt; border-bottom:1px solid var(--profile-rule); }
  .masthead { position:relative; z-index:1; background:var(--profile-bg); margin-top:calc(-1 * var(--profile-running) - 3mm); padding:3mm 0 2pt; }
  h1, h2, h3, p, ul { margin:0; }
  h1 { font:600 22pt/1.1 var(--profile-sans); letter-spacing:-.01em; }
  .title { font:500 11pt/1.3 var(--profile-sans); color:var(--profile-ink-soft); margin-top:3pt; }
  .contact { font:9pt/1.4 var(--profile-sans); color:var(--profile-muted); margin-top:4pt; }
  .contact .sep { padding:0 .45em; }
  h2 { font:600 8.5pt/1.2 var(--profile-sans); letter-spacing:.09em; text-transform:uppercase; color:var(--profile-ink-soft); border-bottom:1px solid var(--profile-rule); margin:11pt 0 5pt; padding-bottom:2.5pt; break-after:avoid; }
  section:first-of-type h2 { margin-top:7pt; }
  h3 { display:flex; flex-wrap:wrap; align-items:baseline; column-gap:.5em; font:600 10.5pt/1.3 var(--profile-sans); break-after:avoid; }
  h3 .follow { font-weight:500; color:var(--profile-ink-soft); }
  h3 .follow::before { content:"·"; color:var(--profile-muted); margin-right:.5em; }
  h3 .when { margin-left:auto; font:500 9pt/1.3 var(--profile-sans); color:var(--profile-muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
  .keep { break-inside:avoid; }
  article { margin:0 0 7pt; }
  article .keep p { margin-top:1.5pt; }
  ul { list-style:none; padding-left:0; margin-top:2pt; }
  li { position:relative; margin:0 0 1.5pt; padding-left:1.1em; break-inside:avoid; }
  p { orphans:2; widows:2; }
  li::before { content:"\\2022"; position:absolute; left:.15em; color:var(--profile-muted); }
  ul ul li::before { content:"\\25E6"; }
  ul.projects { padding-left:1.1em; margin-top:3pt; border-left:1px solid var(--profile-rule); }
  /* A project item holds a sub-list, so it may paginate; the first bullet stays with the project line. */
  ul.projects > li { padding-left:0; break-inside:auto; }
  ul.projects > li > ul { break-before:avoid; }
  ul.projects > li::before { content:none; }
  ul.projects > li { margin-bottom:2pt; }
  ul.projects strong { font:600 10pt/1.3 var(--profile-sans); }
  ul.projects .dash { color:var(--profile-muted); }
  ul.projects ul { font-size:9.5pt; margin-top:1pt; }
  .skills ul, .other ul { margin-top:0; }
  .skills li, .other li { padding-left:0; }
  .skills li::before, .other li::before { content:none; }
  .skills li { font-size:9.5pt; line-height:1.35; margin-bottom:1pt; }
  .skills strong, .other strong { font:600 8.5pt/1.3 var(--profile-sans); color:var(--profile-ink-soft); margin-right:.2em; }
  .other li { margin-bottom:2pt; }
  a { color:var(--profile-accent); overflow-wrap:anywhere; text-decoration:none; }
  @media screen { main { padding:0 1.25rem; } }
  @media print { :root { --profile-bg:#ffffff; --profile-ink:#1a1814; --profile-ink-soft:#3a3630; --profile-muted:#5c584f; --profile-rule:#d6d1c2; --profile-accent:#1a1814; } a { color:inherit; } }
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
        top: PUBLIC_PROFILE_PAGE_MARGIN,
        bottom: PUBLIC_PROFILE_PAGE_MARGIN,
        left: PUBLIC_PROFILE_PAGE_MARGIN,
        right: PUBLIC_PROFILE_PAGE_MARGIN,
      },
      launchTimeoutMs: 60_000,
    });
  });
}
