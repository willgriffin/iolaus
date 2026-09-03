<script lang="ts">
import AdminResourcePage from '$lib/components/admin/AdminResourcePage.svelte';

let { data } = $props();
</script>

<AdminResourcePage {data} />
