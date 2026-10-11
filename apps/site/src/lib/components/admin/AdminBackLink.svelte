<script lang="ts">
import ArrowLeft from '@lucide/svelte/icons/arrow-left';

let {
  href,
  label,
  title = label,
}: { href: string; label: string; title?: string } = $props();
</script>

<a class="admin-header-back-link" {href} {title} aria-label={label}>
  <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
  <span>{label}</span>
</a>

<style>
  a { display:inline-flex; align-items:center; gap:.4rem; min-height:36px; padding:0 .4rem; border-radius:.4rem; color:var(--smrt-color-on-surface-variant); font-size:.85rem; font-weight:600; text-decoration:none; }
  a:hover { background:var(--smrt-color-surface-container); color:var(--smrt-color-on-surface); }
  a:focus-visible { outline:2px solid var(--smrt-color-on-surface); outline-offset:2px; }
  @media(max-width:640px) {
    :global(.admin-app-bar) a { width:36px; justify-content:center; }
    :global(.admin-app-bar) span { position:absolute; width:1px; height:1px; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
  }
</style>
