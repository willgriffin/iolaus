<script lang="ts">
import CandidateSkillDiscovery from '$lib/components/admin/CandidateSkillDiscovery.svelte';

let { data, form } = $props();
</script>
<CandidateSkillDiscovery snapshot={data.snapshot} {form} />
