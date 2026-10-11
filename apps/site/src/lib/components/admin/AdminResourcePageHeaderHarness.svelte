<script lang="ts">
import { type ComponentProps, setContext, untrack } from 'svelte';
import { ADMIN_DOCK_CONTEXT } from '$lib/admin/dock';
import {
  ADMIN_HEADER_ACTIONS,
  type AdminHeaderActions,
} from '$lib/admin/header-actions';
import type { AdminResource } from '$lib/admin/resources';
import AdminResourcePage from './AdminResourcePage.svelte';

let {
  data,
  header,
}: {
  data: ComponentProps<typeof AdminResourcePage>['data'];
  header: AdminHeaderActions;
} = $props();
let currentData = $state(untrack(() => data));
const initialHeader = untrack(() => header);

setContext(ADMIN_DOCK_CONTEXT, { setResourceContext: () => undefined });
setContext(ADMIN_HEADER_ACTIONS, initialHeader);

export function setResource(resource: AdminResource) {
  currentData = { ...currentData, resource };
}
</script>

<AdminResourcePage data={currentData} />
