<script lang="ts">
import { Provider } from '@happyvertical/smrt-svelte';
import type { ColorScheme } from '@happyvertical/smrt-ui/themes';
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
import { browser } from '$app/environment';
import { navigating, page } from '$app/state';
import {
  commandCenterWebMcpConfig,
  jobSearchWebMcpToolDefinitions,
} from '$lib/webmcp';
import '../lib/styles.css';

let { children } = $props();

// The studio ThemeProvider persists the user's scheme to localStorage, but its
// prop-sync effect re-asserts the `colorScheme` prop on every mount — so a
// hardcoded "system" clobbers the persisted choice on reload (a toggled
// light/dark would snap back to the OS preference). Seed the prop from the same
// persisted value the app.html pre-paint script reads, so the prop agrees with
// storage and the toggle survives a refresh. SSR has no storage and falls back
// to "system"; it resolves client-side without a visible flash because the
// public palette tracks <html data-color-scheme>, already set before paint.
function persistedColorScheme(): ColorScheme {
  try {
    const raw = localStorage.getItem('smrt-theme');
    if (!raw) return 'system';
    try {
      return (JSON.parse(raw).colorScheme as ColorScheme) || 'system';
    } catch {
      return (raw as ColorScheme) || 'system';
    }
  } catch {
    return 'system';
  }
}

const initialColorScheme: ColorScheme = browser
  ? persistedColorScheme()
  : 'system';
// `navigating.to` flips as soon as SvelteKit starts a client navigation, before
// any load resolves, so the bar gives immediate feedback on click.
const isNavigating = $derived(Boolean(navigating.to));
const webmcp = $derived(
  commandCenterWebMcpConfig(
    [...webMcpToolDefinitions, ...jobSearchWebMcpToolDefinitions],
    page.url.pathname,
  ),
);
</script>

{#if isNavigating}
  <!-- Decorative only: routes announce their own loading states. -->
  <div class="nav-progress" aria-hidden="true">
    <div class="nav-progress-bar"></div>
  </div>
{/if}

<Provider {webmcp}>
  <ThemeProvider preset="studio" colorScheme={initialColorScheme}>
    {@render children?.()}
  </ThemeProvider>
</Provider>

<style>
  .nav-progress {
    position: fixed;
    inset-block-start: 0;
    inset-inline: 0;
    block-size: 3px;
    z-index: 2147483647;
    overflow: hidden;
    pointer-events: none;
  }

  .nav-progress-bar {
    block-size: 100%;
    inline-size: 40%;
    background: var(--smrt-color-primary, currentColor);
    animation: nav-progress-slide 1s ease-in-out infinite;
  }

  @keyframes nav-progress-slide {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(250%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .nav-progress-bar {
      animation: none;
      inline-size: 100%;
    }
  }
</style>
