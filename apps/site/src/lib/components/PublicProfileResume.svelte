<script lang="ts">
import type { PublicProfileSnapshotV1 } from '$lib/public-profile-contract';
import { formatPublicProfileDateRange } from '$lib/public-profile-dates';

let { snapshot }: { snapshot: PublicProfileSnapshotV1 } = $props();
</script>

<!-- Section order and type hierarchy mirror the standalone document in
     $lib/server/public-profile-render.ts, which feeds the PDF. -->
<main class="profile">
  <header class="masthead">
    <h1>{snapshot.name}</h1>
    <p class="title">{snapshot.title}</p>
    {#if snapshot.email || snapshot.phone || snapshot.location || snapshot.links.length}
      <p class="contact">
        {#if snapshot.email}<a href={`mailto:${snapshot.email}`}>{snapshot.email}</a>{/if}
        {#if snapshot.phone}<a href={`tel:${snapshot.phone}`}>{snapshot.phone}</a>{/if}
        {#if snapshot.location}<span>{snapshot.location}</span>{/if}
        {#each snapshot.links as link}<a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>{/each}
      </p>
    {/if}
  </header>
  <section><h2>Profile</h2><p>{snapshot.summary}</p></section>
  {#if snapshot.skills.length}<section class="skills"><h2>Skills</h2><ul>{#each snapshot.skills as group}<li><strong>{group.label}</strong> {group.skills.join(', ')}</li>{/each}</ul></section>{/if}
  {#if snapshot.experience.length}
    <section><h2>Experience</h2>
      {#each snapshot.experience as position}
        <article>
          <div class="keep">
            <h3><span class="lead">{position.role}</span><span class="follow">{position.company}</span>{#if position.start || position.end}<span class="when">{formatPublicProfileDateRange(position.start, position.end)}</span>{/if}</h3>
            {#if position.summary}<p>{position.summary}</p>{/if}
          </div>
          {#if position.bullets.length}<ul>{#each position.bullets as bullet}<li>{bullet}</li>{/each}</ul>{/if}
          {#if position.projects.length}
            <ul class="projects">
              {#each position.projects as project}
                <li><strong>{#if project.url}<a href={project.url} target="_blank" rel="noopener noreferrer">{project.name}</a>{:else}{project.name}{/if}</strong>{#if project.summary} <span class="dash" aria-hidden="true">—</span> {project.summary}{/if}{#if project.bullets?.length}<ul>{#each project.bullets as bullet}<li>{bullet}</li>{/each}</ul>{/if}</li>
              {/each}
            </ul>
          {/if}
        </article>
      {/each}
    </section>
  {/if}
  {#if snapshot.education.length}
    <section><h2>Education</h2>
      {#each snapshot.education as education}
        <article class="keep">
          <h3><span class="lead">{education.institution}</span><span class="follow">{education.credential}</span>{#if education.start || education.end}<span class="when">{formatPublicProfileDateRange(education.start, education.end)}</span>{/if}</h3>
          {#if education.summary}<p>{education.summary}</p>{/if}
        </article>
      {/each}
    </section>
  {/if}
  {#if snapshot.other.length}<section class="other"><h2>Additional experience</h2><ul>{#each snapshot.other as item}<li><strong>{item.label}</strong> {item.value}</li>{/each}</ul></section>{/if}
</main>

<style>
  /* The public resume owns its palette.  It never inherits ink or surface
     colours from the admin ThemeProvider wrapper, which paints the studio
     background but does not define the --smrt-color-* tokens on public
     routes, so a dark system scheme used to leave light-theme ink on a dark
     surface.  Light is the base; the dark set applies for a dark system
     scheme and for the persisted toggle on <html data-color-scheme>, and an
     explicit light toggle wins over the system preference.  Every ink/surface
     pair stays above WCAG AA (muted ink 6.7:1 light, 7.3:1 dark). */
  .profile {
    --profile-bg: #fbfaf7;
    --profile-ink: #1a1814;
    --profile-ink-soft: #3a3630;
    --profile-muted: #5c584f;
    --profile-rule: #d6d1c2;
    --profile-accent: #8a3f1f;
    --profile-serif: "Source Serif 4", Georgia, "Times New Roman", serif;
    --profile-sans: "Inter Tight", "Liberation Sans", Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    .profile {
      --profile-bg: #15140f;
      --profile-ink: #f1ede2;
      --profile-ink-soft: #d5d0c2;
      --profile-muted: #a8a397;
      --profile-rule: #3d3a30;
      --profile-accent: #f0a880;
    }
  }
  :global(:root[data-color-scheme='dark']) .profile {
    --profile-bg: #15140f;
    --profile-ink: #f1ede2;
    --profile-ink-soft: #d5d0c2;
    --profile-muted: #a8a397;
    --profile-rule: #3d3a30;
    --profile-accent: #f0a880;
  }
  :global(:root[data-color-scheme='light']) .profile {
    --profile-bg: #fbfaf7;
    --profile-ink: #1a1814;
    --profile-ink-soft: #3a3630;
    --profile-muted: #5c584f;
    --profile-rule: #d6d1c2;
    --profile-accent: #8a3f1f;
  }
  /* Same hierarchy as the PDF document, scaled for the screen: serif body,
     sans headings, small-caps section labels, dates on the heading line. */
  .profile { width: min(100%, 46rem); margin: 0 auto; padding: clamp(1.25rem, 4vw, 3rem) clamp(1rem, 4vw, 3rem); background: var(--profile-bg); color: var(--profile-ink); font: 1.0625rem/1.5 var(--profile-serif); overflow-wrap: anywhere; }
  h1, h2, h3, p, ul { margin: 0; }
  h1 { font: 600 clamp(1.9rem, 6vw, 2.5rem)/1.1 var(--profile-sans); letter-spacing: -.01em; }
  .title { font: 500 1.15rem/1.3 var(--profile-sans); color: var(--profile-ink-soft); margin-top: .3rem; }
  .contact { display: flex; flex-wrap: wrap; gap: .25rem 1rem; font: .9rem/1.4 var(--profile-sans); color: var(--profile-muted); margin-top: .5rem; }
  h2 { font: 600 .8rem/1.2 var(--profile-sans); letter-spacing: .09em; text-transform: uppercase; color: var(--profile-ink-soft); border-bottom: 1px solid var(--profile-rule); margin: 1.75rem 0 .6rem; padding-bottom: .3rem; }
  h3 { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: .5em; font: 600 1.05rem/1.3 var(--profile-sans); }
  h3 .follow { font-weight: 500; color: var(--profile-ink-soft); }
  h3 .follow::before { content: "·"; color: var(--profile-muted); margin-right: .5em; }
  h3 .when { margin-left: auto; font: 500 .9rem/1.3 var(--profile-sans); color: var(--profile-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  article { margin: 0 0 1rem; }
  article .keep p { margin-top: .15rem; }
  ul { padding-left: 1.2em; margin-top: .3rem; }
  li { margin: 0 0 .2rem; }
  li::marker { color: var(--profile-muted); }
  ul.projects { list-style: none; padding-left: 1.2em; margin-top: .4rem; border-left: 1px solid var(--profile-rule); }
  ul.projects > li { margin-bottom: .3rem; }
  ul.projects strong { font: 600 1rem/1.3 var(--profile-sans); }
  ul.projects .dash { color: var(--profile-muted); }
  ul.projects ul { font-size: .95rem; margin-top: .15rem; }
  .skills ul, .other ul { list-style: none; padding-left: 0; margin-top: 0; }
  .skills li { font-size: .95rem; margin-bottom: .15rem; }
  .skills strong, .other strong { font: 600 .8rem/1.3 var(--profile-sans); color: var(--profile-ink-soft); margin-right: .2em; }
  .other li { margin-bottom: .3rem; }
  a { color: var(--profile-accent); text-decoration: underline; text-underline-offset: .15em; }
  :is(a):focus-visible { outline: 2px solid var(--profile-accent); outline-offset: 3px; }
  /* Print pins light and paginates like the PDF: headings keep their first
     lines, lists flow.  The toggle selector must be repeated here so this
     rule ties its specificity and wins by source order. */
  @media print { .profile, :global(:root[data-color-scheme]) .profile { --profile-bg: #ffffff; --profile-ink: #1a1814; --profile-ink-soft: #3a3630; --profile-muted: #5c584f; --profile-rule: #d6d1c2; --profile-accent: #1a1814; } a { text-decoration: none; } h2, h3 { break-after: avoid; } .keep, li { break-inside: avoid; } ul.projects > li { break-inside: auto; } ul.projects > li > ul { break-before: avoid; } p { orphans: 2; widows: 2; } }
</style>
