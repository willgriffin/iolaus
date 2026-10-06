import { loadAdminOverview } from '$lib/server/admin-overview';
import { workspaceSubjectFromLocals } from '$lib/server/workspace-subject';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({
  overview: await loadAdminOverview(workspaceSubjectFromLocals(locals)),
});
