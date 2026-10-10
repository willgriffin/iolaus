<script lang="ts">
import type { PublicProfileSnapshotV1 } from '$lib/public-profile-contract';

let { snapshot }: { snapshot: PublicProfileSnapshotV1 } = $props();
</script>

<main class="profile">
  <header>
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
  {#if snapshot.experience.length}<section><h2>Experience</h2>{#each snapshot.experience as position}<article><h3>{position.role} · {position.company}</h3><p class="muted">{position.start} – {position.end}</p><p>{position.summary}</p>{#if position.bullets.length}<ul>{#each position.bullets as bullet}<li>{bullet}</li>{/each}</ul>{/if}{#each position.projects as project}<section class="project"><strong>{#if project.url}<a href={project.url} target="_blank" rel="noopener noreferrer">{project.name}</a>{:else}{project.name}{/if}</strong><p>{project.summary}</p></section>{/each}</article>{/each}</section>{/if}
  {#if snapshot.education.length}<section><h2>Education</h2>{#each snapshot.education as education}<article><h3>{education.credential}</h3><p>{education.institution}</p>{#if education.start || education.end}<p class="muted">{education.start ?? ''}{education.start && education.end ? ' – ' : ''}{education.end ?? ''}</p>{/if}{#if education.summary}<p>{education.summary}</p>{/if}</article>{/each}</section>{/if}
  {#if snapshot.other.length}<section><h2>Additional experience</h2><ul>{#each snapshot.other as item}<li><strong>{item.label}</strong>: {item.value}</li>{/each}</ul></section>{/if}
  {#if snapshot.skills.length}<section><h2>Skills</h2><ul>{#each snapshot.skills as group}<li><strong>{group.label}</strong>: {group.skills.join(', ')}</li>{/each}</ul></section>{/if}
</main>

<style>
  .profile { width: min(100%, 48rem); margin: 0 auto; padding: clamp(1rem, 4vw, 3rem); color: var(--smrt-color-on-surface, #172033); overflow-wrap: anywhere; }
  h1, h2, h3, p { margin: 0 0 .65rem; } h1 { font-size: clamp(2rem, 8vw, 3rem); line-height: 1.1; } h2 { margin-top: 2rem; padding-bottom: .35rem; border-bottom: 1px solid var(--smrt-color-outline-variant, #cbd5e1); } h3 { font-size: 1.05rem; } p, li { line-height: 1.55; } .title { color: var(--smrt-color-on-surface-variant, #475569); font-size: 1.2rem; } .contact { display: flex; flex-wrap: wrap; gap: .5rem 1rem; } a { color: var(--smrt-color-primary, #075985); } .muted { color: var(--smrt-color-on-surface-variant, #475569); } article { margin: 0 0 1.5rem; } ul { padding-left: 1.3rem; } .project { margin: .8rem 0 .8rem 1rem; } :is(a):focus-visible { outline: 2px solid var(--smrt-color-primary, #075985); outline-offset: 3px; }
</style>
