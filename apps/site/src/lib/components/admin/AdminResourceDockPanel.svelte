<script lang="ts">
import type { AdminResourceDockData } from '$lib/admin/dock';

/**
 * Right-hand dock body. Per-record tools were retired (issue #421); the dock is
 * reserved for high-level, cross-page context — the future chat agent. Until
 * that surface lands, the panel reflects the situational context every admin
 * page already feeds it so the plumbing stays visible and exercised.
 */
let { context } = $props<{
  context: AdminResourceDockData | null;
}>();

function focusedRecordLabel(): string {
  const record = context?.selectedRecord;
  if (!record) return '';
  for (const key of ['title', 'name', 'label', 'profileKey']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return typeof record.id === 'string' ? record.id : 'Focused record';
}
</script>

{#if !context}
  <div class="dock-empty">
    <p>No admin resource is selected.</p>
  </div>
{:else}
  <div class="dock-panel" aria-label="Admin context">
    <p class="dock-kicker">Context</p>
    <h2>{context.resource.label}</h2>
    <dl class="context-list">
      <div>
        <dt>Rows visible</dt>
        <dd>{context.records.length}</dd>
      </div>
      <div>
        <dt>Focused</dt>
        <dd>{focusedRecordLabel() || 'None'}</dd>
      </div>
    </dl>
    <p class="dock-copy">
      This dock is reserved for the site agent. Edit records from their rows and
      detail pages.
    </p>
  </div>
{/if}

<style>
  .dock-panel,
  .dock-empty {
    display: grid;
    gap: 14px;
    color: var(--smrt-color-on-surface);
  }

  .dock-kicker {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-small-font);
  }

  .dock-copy,
  .dock-empty p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.45;
  }

  .context-list {
    display: grid;
    gap: 8px;
    margin: 0;
  }

  .context-list div {
    display: grid;
    gap: 2px;
  }

  .context-list dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .context-list dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
