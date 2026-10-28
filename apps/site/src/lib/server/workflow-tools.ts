import type { User } from '@happyvertical/smrt-users';
import {
  archiveApplicationForCleanup,
  ensureCompanyResearch,
  processRecommendationTask,
  syncRecommendedOpportunityDecisionTasks,
} from './application-workflow.js';
import {
  acceptFactCandidate,
  createFactIntakeFromText,
} from './fact-workflow.js';
import {
  enqueueOpportunityIntelligenceWithStatus,
  isOpportunityIntelligenceEnqueueError,
} from './opportunity-intelligence-job.js';
import { getPrivateRecord } from './private-workspace.js';
import {
  type ToolArgumentSource,
  type ToolArgumentValidation,
  validateToolArguments,
} from './tool-arguments.js';

type ToolInputSchema = Parameters<typeof validateToolArguments>[1];

import {
  APPLICATION_ARCHIVE_TOOL,
  COMPANY_RESEARCH_REQUEST_TOOL,
  FACT_CANDIDATE_ACCEPT_TOOL,
  FACT_INTAKE_CREATE_TOOL,
  OPPORTUNITY_ASSESS_TOOL,
  OPPORTUNITY_REVIEW_TOOL,
  RECOMMENDATION_TASK_PROCESS_TOOL,
  RECOMMENDATION_TASKS_SYNC_TOOL,
  workflowToolContract,
} from './workflow-tool-contracts.js';
import { requireCandidateWorkspaceSubject } from './workspace-resource-policy.js';

/**
 * Execution of the owner-principal workflow tools (`workflow-tool-contracts`).
 * The caller has entered the owner principal, asserted the tool's operations
 * and bound the verified workspace subject; every handler reads that subject
 * from the context (`requireCandidateWorkspaceSubject`), never from the
 * arguments, and calls the same service function as the page action.
 */

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function validateWorkflowToolArguments(
  name: string,
  input: Record<string, unknown>,
  source: ToolArgumentSource = 'body',
): ToolArgumentValidation {
  const contract = workflowToolContract(name);
  if (!contract) {
    return { details: [], error: `Unknown workflow tool: ${name}`, ok: false };
  }
  return validateToolArguments(
    name,
    contract.inputSchema as unknown as ToolInputSchema,
    input,
    source,
  );
}

export async function executeWorkflowTool(
  name: string,
  args: Record<string, unknown>,
  user: Pick<User, 'id'>,
): Promise<Record<string, unknown>> {
  const subject = requireCandidateWorkspaceSubject();
  switch (name) {
    case OPPORTUNITY_REVIEW_TOOL: {
      const { updateOpportunityReview } = await import(
        './application-package.js'
      );
      return (await updateOpportunityReview({
        humanRating: args.humanRating,
        humanReviewNotes: text(args.humanReviewNotes),
        humanReviewStatus: text(args.humanReviewStatus),
        opportunityId: text(args.opportunityId),
        subject,
        user,
      })) as Record<string, unknown>;
    }
    case OPPORTUNITY_ASSESS_TOOL: {
      try {
        const result = await enqueueOpportunityIntelligenceWithStatus(
          text(args.opportunityId),
          { modes: 'assessment' },
        );
        return {
          jobId: result.job.id,
          sourceDependency: result.sourceDependency,
          stage: result.stage,
          status: 'queued',
        };
      } catch (cause) {
        if (isOpportunityIntelligenceEnqueueError(cause)) {
          return { message: cause.message, status: 'error' };
        }
        throw cause;
      }
    }
    case RECOMMENDATION_TASKS_SYNC_TOOL:
      return {
        ...(await syncRecommendedOpportunityDecisionTasks(subject)),
        status: 'synced',
      };
    case RECOMMENDATION_TASK_PROCESS_TOOL:
      return (await processRecommendationTask({
        decision: text(args.decision),
        preflightOverrideReason: text(args.preflightOverrideReason),
        reason: text(args.reason),
        subject,
        taskId: text(args.taskId),
        user,
      })) as unknown as Record<string, unknown>;
    case COMPANY_RESEARCH_REQUEST_TOOL: {
      const result = await ensureCompanyResearch({
        companyId: text(args.companyId),
        createdBy: 'owner',
        opportunityId: text(args.opportunityId) || undefined,
        reason: text(args.reason),
        subject,
      });
      return {
        ...result,
        status: result.researchTaskId ? 'queued' : 'error',
      } as Record<string, unknown>;
    }
    case FACT_INTAKE_CREATE_TOOL:
      return (await createFactIntakeFromText({
        intakeContext: text(args.intakeContext) || undefined,
        rawText: text(args.rawText),
        sourceKind: text(args.sourceKind) || undefined,
        subject,
        targetEntityId: text(args.targetEntityId) || undefined,
        targetEntityType: text(args.targetEntityType) || undefined,
      })) as unknown as Record<string, unknown>;
    case FACT_CANDIDATE_ACCEPT_TOOL:
      return (await acceptFactCandidate({
        candidateId: text(args.candidateId),
        subject,
      })) as unknown as Record<string, unknown>;
    case APPLICATION_ARCHIVE_TOOL: {
      const application = await getPrivateRecord(
        'Application',
        text(args.applicationId),
        subject,
      );
      if (!application) {
        return { message: 'Application not found.', status: 'error' };
      }
      return {
        ...(await archiveApplicationForCleanup(application, subject)),
      };
    }
    default:
      throw new Error(`Unknown workflow tool: ${name}`);
  }
}
