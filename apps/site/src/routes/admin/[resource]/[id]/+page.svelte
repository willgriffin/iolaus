<script lang="ts">
import AdminRecordViewPage from '$lib/components/admin/AdminRecordViewPage.svelte';

let { data, form } = $props();
</script>

<AdminRecordViewPage {data} {form} />
