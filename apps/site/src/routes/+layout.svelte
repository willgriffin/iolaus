<script lang="ts">
import { Provider } from '@happyvertical/smrt-svelte';
import type { ColorScheme } from '@happyvertical/smrt-ui/themes';
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
import { browser } from '$app/environment';
import { page } from '$app/state';
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
const webmcp = $derived(
  commandCenterWebMcpConfig(
    [...webMcpToolDefinitions, ...jobSearchWebMcpToolDefinitions],
    page.url.pathname,
  ),
);
</script>

<Provider {webmcp}>
  <ThemeProvider preset="studio" colorScheme={initialColorScheme}>
    {@render children?.()}
  </ThemeProvider>
</Provider>
