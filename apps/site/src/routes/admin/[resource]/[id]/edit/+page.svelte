<script lang="ts">
import AdminRecordFormPage from '$lib/components/admin/AdminRecordFormPage.svelte';

let { data } = $props();
</script>

<AdminRecordFormPage {data} mode="edit" />
