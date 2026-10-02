<script lang="ts">
import AdminOverview from '$lib/components/admin/AdminOverview.svelte';

let { data } = $props();
</script>

<AdminOverview overview={data.overview} />
