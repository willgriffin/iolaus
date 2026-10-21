<script lang="ts">
import { getContext } from 'svelte';
import {
  ADMIN_HEADER_ACTIONS,
  type AdminHeaderActions,
} from '$lib/admin/header-actions';
import { adminBackLink } from '$lib/admin/navigation';
import AdminBackLink from '$lib/components/admin/AdminBackLink.svelte';
import ResumeImport from '$lib/components/admin/ResumeImport.svelte';
import type { ResumeImportView } from '$lib/resume-import';

let { data }: { data: { import?: ResumeImportView | null } } = $props();
const adminHeader = getContext<AdminHeaderActions | undefined>(
  ADMIN_HEADER_ACTIONS,
);
const backLink = adminBackLink('Resume', '/admin/career');
$effect(() => adminHeader?.register(importHeaderActions));
</script>
{#snippet importHeaderActions()}<AdminBackLink {...backLink} />{/snippet}
<svelte:head><title>Import resume — Iolaus</title></svelte:head>
<ResumeImport initialImport={data.import ?? null} />
