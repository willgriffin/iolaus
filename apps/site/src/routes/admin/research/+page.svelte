<script lang="ts">
import AdminCategoryOverview from '$lib/components/admin/AdminCategoryOverview.svelte';

let { data } = $props();
</script>

<AdminCategoryOverview category="research" resources={data.resources} />
