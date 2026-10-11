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
<AdminRecordViewPage data={currentData} />
