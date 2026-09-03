<script lang="ts">
type IconName =
  | 'search'
  | 'chev'
  | 'sun'
  | 'moon'
  | 'sliders'
  | 'close'
  | 'menu'
  | 'pdf'
  | 'email'
  | 'linkedin'
  | 'github';

interface Props {
  name: IconName;
  size?: number;
}

const { name, size }: Props = $props();
</script>

{#if name === 'search'}
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="7" cy="7" r="5" />
    <path d="m11 11 3 3" />
  </svg>
{:else if name === 'chev'}
  <svg viewBox="0 0 8 8" fill="currentColor"><path d="M1 2.5 4 6l3-3.5z" /></svg>
{:else if name === 'sun'}
  <svg width={size ?? 13} height={size ?? 13} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5 13 13M3 13l1.5-1.5M11.5 4.5 13 3" />
  </svg>
{:else if name === 'moon'}
  <svg width={size ?? 13} height={size ?? 13} viewBox="0 0 16 16" fill="currentColor">
    <path d="M6 1a7 7 0 1 0 9 9 5.5 5.5 0 0 1-9-9z" />
  </svg>
{:else if name === 'sliders'}
  <svg width={size ?? 14} height={size ?? 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <path d="M2 4h7M13 4h1M2 8h2M8 8h6M2 12h9M14 12h0" />
    <circle cx="11" cy="4" r="1.5" />
    <circle cx="6" cy="8" r="1.5" />
    <circle cx="13" cy="12" r="1.5" />
  </svg>
{:else if name === 'close'}
  <svg width={size ?? 14} height={size ?? 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
{:else if name === 'menu'}
  <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <path d="M2 4h12M2 8h12M2 12h12" />
  </svg>
{:else if name === 'pdf'}
  <svg width={size ?? 14} height={size ?? 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
    <path d="M3 1.5h6l3 3v10H3z" />
    <path d="M9 1.5v3h3" />
    <path d="M8 7.5v4M6.2 10l1.8 1.8L9.8 10" stroke-linecap="round" />
  </svg>
{:else if name === 'email'}
  <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
    <rect x="2" y="3.5" width="12" height="9" rx="1.2" />
    <path d="M2.5 4.2 8 8.6l5.5-4.4" />
  </svg>
{:else if name === 'linkedin'}
  <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 16 16" fill="currentColor">
    <path d="M3 5.7h2.5v8.3H3zM4.25 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
    <path d="M7 5.7h2.4v1.15c.4-.7 1.4-1.4 2.85-1.4 3.05 0 3.6 2 3.6 4.6V14h-2.5v-3.95c0-1.3-.4-2.2-1.7-2.2-.95 0-1.5.65-1.75 1.3-.1.25-.1.6-.1 1V14H7V5.7z" />
  </svg>
{:else if name === 'github'}
  <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
{/if}
