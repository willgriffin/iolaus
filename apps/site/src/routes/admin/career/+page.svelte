<script lang="ts">
import CareerResume from '$lib/components/admin/CareerResume.svelte';

let { data } = $props();
</script>

<CareerResume {data} />
