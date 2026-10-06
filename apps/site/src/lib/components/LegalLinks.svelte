<script lang="ts">
import type { PublicLink, PublicLinks } from '$lib/public-links';

let { links, label = 'Legal and support' } = $props<{
  links: Pick<PublicLinks, 'privacy' | 'support' | 'terms'> | null | undefined;
  label?: string;
}>();

const items = $derived(
  [links?.terms, links?.privacy, links?.support].filter(
    (link: PublicLink | null | undefined): link is PublicLink => Boolean(link),
  ),
);
</script>

{#if items.length > 0}
  <nav class="legal-links" aria-label={label}>
    <ul>
      {#each items as link (link.label)}
        <li>
          <a
            href={link.href}
            rel="noopener noreferrer"
            target={link.href.startsWith('mailto:') ? undefined : '_blank'}
          >{link.label}</a>
        </li>
      {/each}
    </ul>
  </nav>
{/if}

<style>
  .legal-links {
    margin-top: var(--legal-links-gap, 0);
  }
  .legal-links ul {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  a {
    color: var(--ink-3, var(--smrt-color-on-surface-variant, inherit));
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  a:hover {
    color: var(--ink, var(--smrt-color-on-surface, inherit));
  }
  a:focus-visible {
    outline: 2px solid var(--accent, currentColor);
    outline-offset: 2px;
    border-radius: 2px;
  }
</style>
