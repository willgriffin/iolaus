import { json, type RequestHandler } from '@sveltejs/kit';
import { getMyOpportunityMatches } from '$lib/server/opportunity-matching.js';
import {
  isOwnerAuthorityDenial,
  runAsOwner,
} from '$lib/server/owner-principal.js';
import {
  requireCandidateWorkspaceSubject,
  WorkspaceSubjectError,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject.js';
import { workspaceWorkflowOperation } from '$lib/server/workspace-workflow-capabilities.js';

const headers = {
  'Cache-Control': 'private, no-store',
  Vary: 'Authorization, Cookie',
};
export const GET: RequestHandler = async (event) => {
  try {
    if (!event.locals.user)
      return json(
        { error: 'Authentication required.' },
        { status: 401, headers },
      );
    const raw = event.url.searchParams.get('limit');
    const limit = raw === null ? 25 : Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return json(
        { error: 'limit must be an integer from 1 to 100.' },
        { status: 400, headers },
      );
    const items = await runAsOwner(event.locals, async (run) => {
      const operation = workspaceWorkflowOperation('application.inspect');
      await run.assertOperation(operation.collection, operation.action);
      return getMyOpportunityMatches(
        requireCandidateWorkspaceSubject(
          workspaceSubjectFromLocals(event.locals),
        ),
        { limit },
      );
    });
    return json({ items, model_calls: 0, calibrated: false }, { headers });
  } catch (error) {
    return json(
      {
        error:
          error instanceof WorkspaceSubjectError
            ? error.message
            : 'Private matching unavailable.',
      },
      {
        status:
          error instanceof WorkspaceSubjectError
            ? error.status
            : isOwnerAuthorityDenial(error)
              ? 403
              : 503,
        headers,
      },
    );
  }
};
