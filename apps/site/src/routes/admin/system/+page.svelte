<script lang="ts">
import AdminCategoryOverview from '$lib/components/admin/AdminCategoryOverview.svelte';

let { data } = $props();
</script>

<AdminCategoryOverview category="system" resources={data.resources} />
