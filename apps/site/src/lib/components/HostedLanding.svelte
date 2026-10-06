<script lang="ts">
import LogIn from '@lucide/svelte/icons/log-in';
import type { PublicLinks } from '$lib/public-links';
import LegalLinks from './LegalLinks.svelte';

let { appName, links, signedIn } = $props<{
  appName: string;
  links: PublicLinks;
  signedIn: boolean;
}>();
</script>

<svelte:head>
  <title>{appName}</title>
  <meta
    name="description"
    content={`${appName} is an invite-only workspace for managing your employment search.`}
  />
</svelte:head>

<main class="landing-shell">
  <section class="landing-panel">
    <p class="eyebrow">{appName}</p>
    <h1>Your employment search, in one workspace</h1>
    <p class="copy">
      {appName} keeps your resume, opportunities and applications together in
      a private workspace of your own. Access is currently by invitation.
    </p>
    <a class="cta" href={signedIn ? '/admin/' : '/login'}>
      <LogIn size={17} strokeWidth={2.2} aria-hidden="true" />
      <span>{signedIn ? 'Open your workspace' : 'Sign in'}</span>
    </a>
  </section>
  <footer class="landing-footer">
    <LegalLinks links={links} />
  </footer>
</main>

<style>
  .landing-shell {
    min-height: 100vh;
    display: grid;
    grid-template-rows: 1fr auto;
    justify-items: center;
    padding: 24px;
    background: var(--bg, #fbfaf7);
    color: var(--ink, #1a1814);
    font-family: var(--font-sans, system-ui, sans-serif);
  }

  .landing-panel {
    align-self: center;
    width: min(100%, 520px);
    border: 1px solid var(--border-strong, #d6d1c2);
    background: var(--bg-elev, #fff);
    padding: clamp(20px, 5vw, 36px);
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--ink-3, #6a665e);
    font: 700 11px/1.2 var(--font-mono, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font: 600 clamp(26px, 6vw, 34px) / 1.12 var(--font-serif, Georgia, serif);
  }

  .copy {
    margin: 14px 0 24px;
    color: var(--ink-2, #3a3630);
    line-height: 1.55;
  }

  .cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    border: 1px solid var(--ink, #1a1814);
    border-radius: 6px;
    background: var(--ink, #1a1814);
    color: var(--bg, #fff);
    font-weight: 700;
    text-decoration: none;
  }

  .cta:focus-visible {
    outline: 2px solid var(--accent, currentColor);
    outline-offset: 3px;
  }

  .landing-footer {
    padding-top: 20px;
  }
</style>
