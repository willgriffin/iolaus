<script lang="ts">
import { type ComponentProps, type Snippet, setContext, untrack } from 'svelte';
import {
  ADMIN_HEADER_ACTIONS,
  type AdminHeaderActions,
} from '$lib/admin/header-actions';
import AdminRecordViewPage from './AdminRecordViewPage.svelte';

let { data }: { data: ComponentProps<typeof AdminRecordViewPage>['data'] } =
  $props();
let currentData = $state(untrack(() => data));
let headerActions = $state<Snippet>();
let currentForm = $state.raw<unknown>();
let showRecord = $state(true);

export function applyActionResult(result: unknown): void {
  currentForm = result;
}

export function leaveRecordRoute(): void {
  currentData = {
    application: { id: 'application-1' },
  } as unknown as typeof currentData;
  showRecord = false;
}

const header: AdminHeaderActions = {
  register(actions) {
    headerActions = actions;
    return () => {
      if (headerActions === actions) headerActions = undefined;
    };
  },
};

setContext(ADMIN_HEADER_ACTIONS, header);

export function removeRecord(): void {
  currentData = {
    ...currentData,
    record: undefined,
  } as unknown as ComponentProps<typeof AdminRecordViewPage>['data'];
}
</script>

<div data-testid="registered-header">{@render headerActions?.()}</div>
{#if showRecord}
  <AdminRecordViewPage data={currentData} form={currentForm} />
{:else}
  <nav aria-label="Application materials">Application review</nav>
{/if}
