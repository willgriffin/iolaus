import qrcode from 'qrcode-generator';
import type {
  Achievement,
  Duty,
  Experience,
  Profile,
  Project,
  ResumeFooterLink,
  ResumeRenderOptions,
  Skills,
} from './types.js';
import { escapeHtml, sortPositions } from './utils.js';

const EN_DASH = '\u2013';
const EM_DASH = '\u2014';

function buildSkillMap(skills: Skills): Record<string, string> {
  const map: Record<string, string> = {};
  for (const group of skills.groups)
    for (const skill of group.skills) map[skill.id] = skill.label;
  return map;
}

function renderTags(
  tags: string[],
  skillMap: Record<string, string> | undefined,
): string {
  if (!skillMap || !tags.length) return '';
  const chips = tags
    .map(
      (tag) => `<span class="tag">${escapeHtml(skillMap[tag] ?? tag)}</span>`,
    )
    .join('');
  return `<div class="tags">${chips}</div>`;
}

function renderAchievementHtml(
  achievement: Achievement,
  skillMap: Record<string, string> | undefined,
): string {
  return `
        <div class="ach">
          <div class="ach-head">
            <span class="ach-title">${escapeHtml(achievement.title)}</span>${
              achievement.metric
                ? ` <span class="metric">${escapeHtml(achievement.metric)}</span>`
                : ''
            }
          </div>
          <p class="ach-body">${escapeHtml(achievement.body)}</p>
          ${renderTags(achievement.tags, skillMap)}
        </div>`;
}

function renderProjectBulletHtml(
  achievement: Achievement,
  skillMap: Record<string, string> | undefined,
): string {
  return `
        <div class="ach project-bullet">
          <p class="ach-body">${
            achievement.title
              ? `<strong class="ach-title">${escapeHtml(achievement.title)}:</strong> `
              : ''
          }${escapeHtml(achievement.body)}</p>${
            achievement.metric
              ? ` <span class="metric">${escapeHtml(achievement.metric)}</span>`
              : ''
          }
          ${renderTags(achievement.tags, skillMap)}
        </div>`;
}

function renderDutiesHtml(duties: Duty[] | undefined): string {
  if (!duties?.length) return '';
  return `
        <ul class="duties">
          ${duties
            .map((duty) => {
              const label = duty.title
                ? `<strong>${escapeHtml(duty.title)}:</strong> `
                : '';
              return `<li>${label}${escapeHtml(duty.body)}</li>`;
            })
            .join('')}
        </ul>`;
}

function renderQrCode(url: string, className: string): string {
  const code = qrcode(0, 'M');
  code.addData(url);
  code.make();
  const label = `QR code for ${url}`;
  return `<a class="${className}" href="${escapeHtml(url)}" aria-label="${escapeHtml(label)}">${code.createSvgTag({ margin: 0, scalable: true })}</a>`;
}

function renderProjectQrCode(url: string): string {
  return renderQrCode(url, 'project-qr');
}

function renderFooterHtml(footerLink: ResumeFooterLink | undefined): string {
  if (!footerLink) return '';
  return `
  <footer class="resume-foot">
    ${renderQrCode(footerLink.url, 'footer-qr')}
    <a class="footer-link" href="${escapeHtml(footerLink.url)}">${escapeHtml(footerLink.label)}</a>
  </footer>`;
}

function renderProjectsHtml(
  projects: Project[] | undefined,
  skillMap: Record<string, string> | undefined,
): string {
  if (!projects?.length) return '';
  return `
        <div class="projects">
          ${projects
            .map((project) => {
              const dates =
                project.start || project.end
                  ? `<span class="project-dates">${escapeHtml(project.start ?? '')}${project.start && project.end ? ` ${EN_DASH} ` : ''}${escapeHtml(project.end ?? '')}</span>`
                  : '';
              const name = project.url
                ? `<a class="project-link" href="${escapeHtml(project.url)}">${escapeHtml(project.name)}</a>`
                : escapeHtml(project.name);
              const url = project.url
                ? ` <a class="project-url" href="${escapeHtml(project.url)}">${escapeHtml(project.url)}</a>`
                : '';
              const qrCode = project.url
                ? renderProjectQrCode(project.url)
                : '';
              return `
            <section class="project">
              ${qrCode}
              <h4>${name}${url}${dates}</h4>
              ${project.summary ? `<p class="project-summary">${escapeHtml(project.summary)}</p>` : ''}
              ${renderDutiesHtml(project.duties)}
              ${project.achievements.map((achievement) => renderProjectBulletHtml(achievement, skillMap)).join('')}
            </section>`;
            })
            .join('')}
        </div>`;
}

export function renderResumeHtml(
  profile: Profile,
  experience: Experience,
  skills: Skills,
  options: ResumeRenderOptions = {},
): string {
  // Tags render only when a skill map is present; hiding tags drops the map.
  const skillMap = options.hideTags ? undefined : buildSkillMap(skills);
  const positions = sortPositions(experience.positions);

  const contact = [
    `<a href="mailto:${escapeHtml(profile.email)}">${escapeHtml(profile.email)}</a>`,
    ...profile.links.map(
      (link) =>
        `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
    ),
  ].join(' &middot; ');

  const skillsBlock = skills.groups
    .map(
      (group) => `
      <div class="skill-row">
        <div class="skill-label">${escapeHtml(group.label)}</div>
        <div class="skill-values">${group.skills.map((skill) => escapeHtml(skill.label)).join(', ')}</div>
      </div>`,
    )
    .join('');

  const positionsHtml = positions
    .map((position) => {
      const achievements = position.achievements
        .map((achievement) => renderAchievementHtml(achievement, skillMap))
        .join('');

      const companyEl = position.companyHref
        ? `<a href="${escapeHtml(position.companyHref)}">${escapeHtml(position.company)}</a>`
        : escapeHtml(position.company);
      const roleEl = position.url
        ? `<a href="${escapeHtml(position.url)}">${escapeHtml(position.role)}</a>`
        : escapeHtml(position.role);
      return `
      <article class="position">
        <header class="position-head">
          <h3 class="position-company">${companyEl}</h3>
          <div class="position-meta">
            <span class="position-role">${roleEl}</span>
            <span class="position-dates">${escapeHtml(position.start)} ${EN_DASH} ${escapeHtml(position.end)}</span>
          </div>
        </header>
        ${position.blurb ? `<p class="position-blurb">${escapeHtml(position.blurb)}</p>` : ''}
        ${renderDutiesHtml(position.duties)}
        ${renderProjectsHtml(position.projects, skillMap)}
        <div class="achievements">${achievements}</div>
      </article>`;
    })
    .join('');

  const other =
    experience.other.length === 0
      ? ''
      : `
      <section class="section">
        <h2 class="section-title">Other Experience</h2>
        <div class="other-grid">
          ${experience.other
            .map(
              (role) => `
            <div class="other-card">
              <div class="other-role">${escapeHtml(role.role)}</div>
              <div class="other-co"><span>${escapeHtml(role.company)}</span> <span class="period">· ${escapeHtml(role.period)}</span></div>
              ${role.body ? `<p class="other-body">${escapeHtml(role.body)}</p>` : ''}
              ${renderTags(role.tags ?? [], skillMap)}
            </div>`,
            )
            .join('')}
        </div>
      </section>`;

  const education =
    experience.education.length === 0
      ? ''
      : `
      <section class="section">
        <h2 class="section-title">Education &amp; Certifications</h2>
        <ul class="edu-list">
          ${experience.education
            .map(
              (educationItem) => `
            <li class="edu-item">
              <div class="edu-title">${escapeHtml(educationItem.title)}</div>
              ${educationItem.institution ? `<div class="edu-inst">${escapeHtml(educationItem.institution)}</div>` : ''}
              <div class="edu-detail">${escapeHtml(educationItem.detail)}</div>
            </li>`,
            )
            .join('')}
        </ul>
      </section>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(profile.name)} ${EM_DASH} Resume</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&family=Inter+Tight:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
  <style>${PDF_STYLES}</style>
</head>
<body>
  <header class="resume-head">
    <h1 class="name">${escapeHtml(profile.name)}</h1>
    <div class="brand-role">${escapeHtml(profile.title)}</div>
    <div class="contact">${contact}</div>
  </header>

  <section class="section summary-section">
    <p class="summary">${escapeHtml(profile.summary)}</p>
  </section>

  ${
    options.hideSkills
      ? ''
      : `<section class="section">
    <h2 class="section-title">Technical Skills</h2>
    <div class="skills-block">${skillsBlock}</div>
  </section>`
  }

  <section class="section">
    <h2 class="section-title">Experience</h2>
    ${positionsHtml}
  </section>

  ${other}

  ${education}
  ${renderFooterHtml(options.footerLink)}
</body>
</html>`;
}

function footerMarkdown(footerLink: ResumeFooterLink): string {
  return `[${footerLink.label}](${footerLink.url})`;
}

export function renderResumeMarkdown(
  profile: Profile,
  experience: Experience,
  skills: Skills,
  options: ResumeRenderOptions = {},
): string {
  const lines: string[] = [];

  lines.push(`# ${profile.name}`, '', `**${profile.title}**`, '');
  lines.push(
    [
      `[${profile.email}](mailto:${profile.email})`,
      ...profile.links.map((link) => `[${link.label}](${link.href})`),
    ].join(' | '),
    '',
  );

  lines.push('## Summary', '', profile.summary, '');

  if (!options.hideSkills) {
    lines.push('## Technical Skills', '');
    for (const group of skills.groups) {
      lines.push(
        `- **${group.label}:** ${group.skills.map((skill) => skill.label).join(', ')}`,
      );
    }
    lines.push('');
  }

  lines.push('## Professional Experience', '');
  for (const position of sortPositions(experience.positions)) {
    const roleMd = position.url
      ? `[${position.role}](${position.url})`
      : position.role;
    const companyMd = position.companyHref
      ? `[${position.company}](${position.companyHref})`
      : position.company;
    lines.push(
      `### ${companyMd}`,
      '',
      `*${roleMd} | ${position.start} ${EN_DASH} ${position.end}*`,
      '',
    );
    if (position.blurb) lines.push(position.blurb, '');
    for (const duty of position.duties ?? []) {
      const label = duty.title ? `**${duty.title}:** ` : '';
      lines.push(`- ${label}${duty.body}`);
    }
    if (position.duties?.length) lines.push('');
    for (const project of position.projects ?? []) {
      const projectDates =
        project.start || project.end
          ? ` *(${[project.start, project.end].filter(Boolean).join(` ${EN_DASH} `)})*`
          : '';
      const projectName = project.url
        ? `[${project.name}](${project.url})`
        : project.name;
      const projectUrl = project.url ? ` ${EM_DASH} ${project.url}` : '';
      lines.push(`#### ${projectName}${projectUrl}${projectDates}`, '');
      if (project.summary) lines.push(project.summary, '');
      for (const duty of project.duties ?? []) {
        const label = duty.title ? `**${duty.title}:** ` : '';
        lines.push(`- ${label}${duty.body}`);
      }
      for (const achievement of project.achievements) {
        const metric = achievement.metric ? ` *(${achievement.metric})*` : '';
        const label = achievement.title ? `**${achievement.title}:** ` : '';
        lines.push(`- ${label}${achievement.body}${metric}`);
      }
      lines.push('');
    }
    for (const achievement of position.achievements) {
      const metric = achievement.metric ? ` *(${achievement.metric})*` : '';
      lines.push(`- **${achievement.title}:** ${achievement.body}${metric}`);
    }
    lines.push('');
  }

  if (experience.other.length > 0) {
    lines.push('## Other Experience', '');
    for (const role of experience.other) {
      const body = role.body ? ` ${EM_DASH} ${role.body}` : '';
      lines.push(
        `- **${role.role}**, ${role.company} *(${role.period})*${body}`,
      );
    }
    lines.push('');
  }

  if (experience.education.length > 0) {
    lines.push('## Education & Certifications', '');
    for (const educationItem of experience.education) {
      const institution = educationItem.institution
        ? ` ${EM_DASH} ${educationItem.institution}`
        : '';
      lines.push(
        `- **${educationItem.title}**${institution}: ${educationItem.detail}`,
      );
    }
    lines.push('');
  }

  if (options.footerLink) lines.push(footerMarkdown(options.footerLink), '');

  return lines.join('\n');
}

export function renderResumeText(
  markdown: string,
  options: ResumeRenderOptions = {},
): string {
  const withFooter = options.footerLink
    ? markdown.replace(
        footerMarkdown(options.footerLink),
        `${options.footerLink.label}: ${options.footerLink.url}`,
      )
    : markdown;
  return withFooter
    .replace(/^#{1,6} /gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

const PDF_STYLES = `
  :root {
    --bg-elev: #ffffff;
    --border: #e7e3d8;
    --border-strong: #d6d1c2;
    --ink: #1a1814;
    --ink-2: #3a3630;
    --ink-3: #6a665e;
    --ink-4: #9a958a;
    --accent: #b1542d;
    --accent-soft: #f5e8df;
    --accent-ink: #8a3f1f;
    --tag-bg: #efece4;
    --tag-ink: #4a463e;
    --font-serif: 'Source Serif 4', Georgia, serif;
    --font-sans: 'Inter Tight', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  }
  @page { size: letter; margin: 0.45in 0.55in; }
  * { box-sizing: border-box; }
  html, body {
    background: transparent;
    color: var(--ink);
    font-family: var(--font-serif);
    font-size: 9.4pt;
    line-height: 1.36;
    margin: 0;
    padding: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  a { color: var(--accent-ink); text-decoration: none; }
  h1, h2, h3 { margin: 0; }
  p { margin: 0; }

  .resume-head { padding-bottom: 7pt; border-bottom: 1px solid var(--border-strong); margin-bottom: 8pt; }
  .name {
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: 24pt;
    letter-spacing: -0.015em;
    line-height: 1.05;
    color: var(--ink);
  }
  .brand-role {
    font-family: var(--font-mono);
    font-size: 8pt;
    color: var(--ink-3);
    text-transform: lowercase;
    letter-spacing: 0.04em;
    margin: 2pt 0 5pt;
  }
  .contact {
    font-family: var(--font-mono);
    font-size: 7.8pt;
    color: var(--ink-2);
  }
  .contact a { color: var(--ink-2); }

  .section { margin: 0 0 8pt; break-inside: auto; }
  .section-title {
    font-family: var(--font-mono);
    font-size: 7.8pt;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-4);
    margin: 0 0 5pt;
    padding-bottom: 2.5pt;
    border-bottom: 1px solid var(--border);
    break-after: avoid;
    page-break-after: avoid;
  }

  .summary-section .summary {
    font-family: var(--font-serif);
    font-size: 9.8pt;
    line-height: 1.38;
    color: var(--ink-2);
    font-style: italic;
  }

  .skills-block { display: grid; gap: 2.5pt; }
  .skill-row {
    display: grid;
    grid-template-columns: 98pt 1fr;
    gap: 6pt;
    font-size: 8.6pt;
  }
  .skill-label {
    font-family: var(--font-mono);
    font-size: 7.2pt;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-3);
    padding-top: 1pt;
  }
  .skill-values { color: var(--ink-2); }

  .position {
    break-inside: auto;
    margin: 0 0 6pt;
    padding-top: 4pt;
  }
  .position + .position { border-top: 1px dashed var(--border); }
  .position-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6pt;
    margin-bottom: 2pt;
    break-after: avoid;
    page-break-after: avoid;
  }
  .position-company {
    font-family: var(--font-serif);
    font-size: 11pt;
    font-weight: 600;
    color: var(--ink);
    margin: 0 0 1pt;
  }
  .position-company a,
  .position-role a {
    color: inherit;
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-decoration-thickness: 0.5pt;
    text-underline-offset: 1pt;
  }
  .position-meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8pt;
  }
  .position-role {
    font: 500 8.7pt/1.2 var(--font-sans);
    color: var(--ink-3);
  }
  .position-dates {
    font-family: var(--font-mono);
    font-size: 7.7pt;
    color: var(--ink-3);
    white-space: nowrap;
  }
  .position-blurb {
    font-style: italic;
    color: var(--ink-3);
    font-size: 8.7pt;
    margin: 1pt 0 4pt;
  }
  .duties {
    margin: 0 0 4pt 0;
    padding-left: 12pt;
    color: var(--ink-2);
    font-size: 8.6pt;
  }
  .duties li { margin: 0 0 2pt; }
  .projects {
    display: grid;
    gap: 4pt;
    margin: 0 0 4pt;
  }
  .project {
    border-left: 2pt solid var(--border-strong);
    padding-left: 6pt;
    break-inside: auto;
  }
  .project h4 {
    margin: 0 0 2pt;
    color: var(--ink);
    font: 600 9.4pt/1.15 var(--font-sans);
    break-after: avoid;
    page-break-after: avoid;
  }
  .project::after { content: ''; display: block; clear: both; }
  .project-link { color: inherit; text-decoration: none; }
  .project-url {
    margin-left: 5pt;
    color: var(--ink-3);
    font: 500 6.7pt/1.15 var(--font-mono);
    overflow-wrap: anywhere;
  }
  .project-qr {
    float: right;
    display: block;
    width: 38pt;
    height: 38pt;
    margin: 0 0 4pt 7pt;
    padding: 2pt;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 2pt;
  }
  .project-qr svg { display: block; width: 100%; height: 100%; }
  .resume-foot {
    display: flex;
    align-items: center;
    gap: 8pt;
    margin-top: 10pt;
    padding-top: 6pt;
    border-top: 1px solid var(--border);
    break-inside: avoid;
  }
  .footer-qr {
    display: block;
    flex: none;
    width: 44pt;
    height: 44pt;
    padding: 2pt;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 2pt;
  }
  .footer-qr svg { display: block; width: 100%; height: 100%; }
  .footer-link {
    font-family: var(--font-mono);
    font-size: 8pt;
    color: var(--ink-2);
  }
  .project-dates {
    margin-left: 6pt;
    color: var(--ink-3);
    font: 500 7.5pt/1.15 var(--font-mono);
    white-space: nowrap;
  }
  .project-summary {
    margin: 0 0 3pt;
    color: var(--ink-2);
    font-size: 8.5pt;
  }

  .achievements { display: grid; gap: 3.5pt; }
  .ach {
    border-left: 2pt solid var(--accent);
    padding: 2.5pt 0 2.5pt 6pt;
    break-inside: avoid;
  }
  .ach-head { display: flex; align-items: baseline; gap: 6pt; flex-wrap: wrap; }
  .ach-title {
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: 9.4pt;
    color: var(--ink);
  }
  .project-bullet .ach-title {
    font-size: inherit;
  }
  .metric {
    font-family: var(--font-mono);
    font-size: 6.8pt;
    color: var(--accent-ink);
    background: var(--accent-soft);
    padding: 0.5pt 4pt;
    border-radius: 2pt;
  }
  .ach-body {
    color: var(--ink-2);
    font-size: 8.6pt;
    margin: 1pt 0 2.5pt;
  }

  .tags { display: flex; flex-wrap: wrap; gap: 2pt; margin-top: 2pt; }
  .tag {
    font-family: var(--font-mono);
    font-size: 6.4pt;
    background: var(--tag-bg);
    color: var(--tag-ink);
    padding: 0.5pt 4pt;
    border-radius: 2pt;
    white-space: nowrap;
  }

  .other-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5pt;
  }
  .other-card {
    border: 1px solid var(--border);
    border-radius: 3pt;
    background: var(--bg-elev);
    padding: 4pt 6pt;
    break-inside: avoid;
  }
  .other-role {
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: 9pt;
    color: var(--ink);
  }
  .other-co {
    font-size: 8pt;
    color: var(--ink-3);
    margin: 1pt 0 2pt;
  }
  .other-co .period { color: var(--ink-4); }
  .other-body {
    font-size: 8pt;
    color: var(--ink-2);
    margin: 0 0 3pt;
  }

  .edu-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 4pt; }
  .edu-item {
    break-inside: avoid;
  }
  .edu-title {
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: 9pt;
    color: var(--ink);
  }
  .edu-inst {
    font-size: 8pt;
    color: var(--ink-3);
  }
  .edu-detail {
    font-size: 8pt;
    color: var(--ink-2);
    margin-top: 1pt;
  }
`;
