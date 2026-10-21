import { error, redirect } from '@sveltejs/kit';
import { getResumeImportHost } from '$lib/server/resume-import-runtime';
import { resumeImportTransportError } from '$lib/server/resume-import-transport';
import {
  requireCandidateWorkspaceSubject,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
  if (!locals.user) redirect(303, '/login');
  requireCandidateWorkspaceSubject(workspaceSubjectFromLocals(locals));
  setHeaders({ 'cache-control': 'no-store' });
  const id = url.searchParams.get('id');
  if (!id) return { import: null };
  try {
    return { import: await (await getResumeImportHost(locals)).get(id) };
  } catch (cause) {
    const response = resumeImportTransportError(cause);
    const body = await response.json();
    error(response.status, body.error);
  }
};
