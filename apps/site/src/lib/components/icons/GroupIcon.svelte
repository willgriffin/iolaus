<script lang="ts">
interface Props {
  id: string;
}
const { id }: Props = $props();
</script>

{#if id === 'g-sql'}
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4">
    <ellipse cx="10" cy="5" rx="6" ry="2" />
    <path d="M4 5v5c0 1.1 2.7 2 6 2s6-.9 6-2V5" />
    <path d="M4 10v5c0 1.1 2.7 2 6 2s6-.9 6-2v-5" />
  </svg>
{:else if id === 'g-devops'}
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
    <path d="M14 9a4 4 0 0 0-7.9-.5A3 3 0 0 0 6 14h8a3 3 0 0 0 0-5z" />
  </svg>
{:else if id === 'g-ai'}
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
    <path d="M10 2.5 11.4 6 15 7.4 11.4 8.8 10 12.3 8.6 8.8 5 7.4 8.6 6z" />
    <path d="M15 13l.7 1.7L17.5 15.5l-1.8.8L15 18l-.7-1.7-1.8-.8 1.8-.8z" />
  </svg>
{:else if id === 'g-frontend'}
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
    <rect x="2.5" y="3.5" width="15" height="11" rx="1.5" />
    <path d="M2.5 7h15M5 5h0M7 5h0" />
    <path d="M7 17h6" />
  </svg>
{:else if id === 'g-backend'}
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4">
    <rect x="3" y="3.5" width="14" height="5" rx="1" />
    <rect x="3" y="11.5" width="14" height="5" rx="1" />
    <circle cx="6" cy="6" r=".7" fill="currentColor" />
    <circle cx="6" cy="14" r=".7" fill="currentColor" />
  </svg>
{:else if id === 'g-architecture'}
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
    <path d="M10 2 3 6v1h14V6zM4.5 8v8M15.5 8v8M8 8v8M12 8v8M2.5 17h15" />
  </svg>
{:else if id === 'g-leadership'}
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4">
    <circle cx="7" cy="7" r="2.5" />
    <circle cx="13" cy="8" r="2" />
    <path d="M2.5 16c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4M11.5 16c.4-2 1.8-3 3.5-3s2.6.8 3 3" />
  </svg>
{:else if id === 'g-fullstack-js'}
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
    <path d="M5 4 2 10l3 6M15 4l3 6-3 6M12 4 8 16" />
  </svg>
{:else}
  <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3" fill="currentColor" /></svg>
{/if}
