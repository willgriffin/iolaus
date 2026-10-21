<script lang="ts">
import AdminWorkspaceShell from '$lib/components/admin/AdminWorkspaceShell.svelte';

let { data, children } = $props();
</script>
<AdminWorkspaceShell {data}>{@render children()}</AdminWorkspaceShell>
