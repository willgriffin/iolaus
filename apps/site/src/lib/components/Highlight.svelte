<script lang="ts">
import { highlight } from '../utils/filter';

interface Props {
  text: string;
  query: string;
}
const { text, query }: Props = $props();
const parts = $derived(highlight(text, query));
</script>

{#each parts as part, i (i)}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
