<script lang="ts">
import SourceCrawlProgress from './SourceCrawlProgress.svelte';
import type { SourceCrawlStatus } from './source-crawl-progress.js';

let {
  crawlId,
  onTerminal,
  sourceId,
}: {
  crawlId: string;
  onTerminal: (status: SourceCrawlStatus) => void;
  sourceId: string;
} = $props();

let terminalCallback = $state<(status: SourceCrawlStatus) => void>(
  () => undefined,
);

$effect(() => {
  terminalCallback = onTerminal;
});

export function replaceTerminalCallback(
  callback: (status: SourceCrawlStatus) => void,
): void {
  terminalCallback = callback;
}
</script>

<SourceCrawlProgress {crawlId} {sourceId} onTerminal={terminalCallback} />
