<script lang="ts">
import { getContext } from 'svelte';
import {
  ADMIN_HEADER_ACTIONS,
  type AdminHeaderActions,
} from '$lib/admin/header-actions';
import { adminBackLink } from '$lib/admin/navigation';
import AdminBackLink from '$lib/components/admin/AdminBackLink.svelte';
import CareerResume from '$lib/components/admin/CareerResume.svelte';

let { data } = $props();
const backLink = adminBackLink('Overview', '/admin');
const adminHeader = getContext<AdminHeaderActions | undefined>(
  ADMIN_HEADER_ACTIONS,
);
$effect(() => adminHeader?.register(careerHeaderActions));
</script>

{#snippet careerHeaderActions()}
  <AdminBackLink {...backLink} />
  <a class="import-link" href="/admin/career/import">Upload resume</a>
{/snippet}

<CareerResume {data} />
{#if data.publicProfilesEnabled}<p class="public-profile-link"><a href="/admin/career/public-profile">Manage public profile</a></p>{/if}

<style>.public-profile-link { margin: 1rem 0; } a { color: var(--smrt-color-primary); }.import-link { margin-left: .75rem; }</style>
