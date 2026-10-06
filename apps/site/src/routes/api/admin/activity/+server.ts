import { json, type RequestHandler } from '@sveltejs/kit';
import {
  isOwnerAuthorityDenial,
  runAsOwner,
} from '$lib/server/owner-principal.js';
import { loadWorkspaceActivity } from '$lib/server/workspace-activity.js';
import {
  requireCandidateWorkspaceSubject,
  WorkspaceSubjectError,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject.js';
import { workspaceWorkflowOperation } from '$lib/server/workspace-workflow-capabilities.js';

const headers = { 'Cache-Control': 'private, no-store' };

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user)
    return json({ error: 'Unauthorized' }, { status: 401, headers });
  try {
    const snapshot = await runAsOwner(
      locals,
      async (run) => {
        const operation = workspaceWorkflowOperation('application.inspect');
        await run.assertOperation(operation.collection, operation.action);
        const subject = requireCandidateWorkspaceSubject(
          workspaceSubjectFromLocals(locals),
        );
        return await loadWorkspaceActivity(subject);
      },
      { action: 'admin.activity.read' },
    );
    return json(snapshot, { headers });
  } catch (cause) {
    if (cause instanceof WorkspaceSubjectError || isOwnerAuthorityDenial(cause))
      return json({ error: 'Forbidden' }, { status: 403, headers });
    return json({ error: 'Activity unavailable' }, { status: 503, headers });
  }
};
