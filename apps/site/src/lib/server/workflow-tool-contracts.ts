import type { MCPTool } from '@happyvertical/smrt-core/generators/mcp';
import type { WorkflowOperation } from './workflow-operations.js';
import {
  type WorkspaceWorkflowCapability,
  workspaceWorkflowOperation,
} from './workspace-workflow-capabilities.js';

/**
 * Owner-principal workflow tools for admin form actions that had no agent
 * equivalent (willgriffin/iolaus#263, `docs/surface-parity.md` section D).
 * Each tool is a thin wrapper over the service function its page action
 * calls and asserts the same curated capabilities that action asserts
 * (`admin-resource-route.ts`). This module holds names, schemas and the
 * permission sets only, so the MCP catalog and the owner allow-list can load
 * it; execution lives in `workflow-tools.ts`.
 */

const JSON_SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

function cap(capability: WorkspaceWorkflowCapability): WorkflowOperation {
  return workspaceWorkflowOperation(capability);
}

const id = (description: string) => ({
  description,
  maxLength: 160,
  minLength: 1,
  type: 'string',
});

export interface WorkflowToolContract extends MCPTool {
  /** Curated capabilities and generated permissions the tool asserts. */
  operations: (args: Record<string, unknown>) => readonly WorkflowOperation[];
  readOnly: boolean;
}

export const OPPORTUNITY_REVIEW_TOOL = 'opportunity_review';
export const OPPORTUNITY_ASSESS_TOOL = 'opportunity_assess';
export const RECOMMENDATION_TASKS_SYNC_TOOL = 'recommendation_tasks_sync';
export const RECOMMENDATION_TASK_PROCESS_TOOL = 'recommendation_task_process';
export const COMPANY_RESEARCH_REQUEST_TOOL = 'company_research_request';
export const FACT_INTAKE_CREATE_TOOL = 'fact_intake_create';
export const FACT_CANDIDATE_ACCEPT_TOOL = 'fact_candidate_accept';
export const APPLICATION_ARCHIVE_TOOL = 'application_archive';

export const workflowToolContracts: readonly WorkflowToolContract[] = [
  {
    description:
      'Record the owner’s review of one opportunity (needs_input, maybe, apply, reject or archived) with an optional rating and notes, exactly as the opportunity list’s review action does: an immutable Decision revision plus the audited side effects. Never approves or submits an application.',
    inputSchema: {
      $schema: JSON_SCHEMA,
      additionalProperties: false,
      properties: {
        humanRating: { maximum: 5, minimum: 0, type: 'integer' },
        humanReviewNotes: { maxLength: 4000, type: 'string' },
        humanReviewStatus: {
          enum: ['needs_input', 'maybe', 'apply', 'reject', 'archived'],
          type: 'string',
        },
        opportunityId: id('Opportunity id.'),
      },
      required: ['opportunityId', 'humanReviewStatus'],
      type: 'object',
    },
    name: OPPORTUNITY_REVIEW_TOOL,
    operations: () => [cap('application.review')],
    outputSchema: { additionalProperties: true, type: 'object' },
    readOnly: false,
  },
  {
    description:
      'Queue the owner’s private assessment of one opportunity (the “Process with LLM” action). Returns the queued job and stage; the assessment itself runs asynchronously under the AI budget.',
    inputSchema: {
      $schema: JSON_SCHEMA,
      additionalProperties: false,
      properties: { opportunityId: id('Opportunity id.') },
      required: ['opportunityId'],
      type: 'object',
    },
    name: OPPORTUNITY_ASSESS_TOOL,
    operations: () => [cap('assessment.execute')],
    outputSchema: { additionalProperties: true, type: 'object' },
    readOnly: false,
  },
  {
    description:
      'Create or cancel review_recommendation tasks so the task board matches the currently recommended opportunities (the task board’s “Sync recommendations” action).',
    inputSchema: {
      $schema: JSON_SCHEMA,
      additionalProperties: false,
      properties: {},
      type: 'object',
    },
    name: RECOMMENDATION_TASKS_SYNC_TOOL,
    operations: () => [cap('task.sync')],
    outputSchema: { additionalProperties: true, type: 'object' },
    readOnly: false,
  },
  {
    description:
      'Decide one review_recommendation task: accept_to_apply (runs the posting preflight and opens the application workspace), or another recorded decision with a reason. Never approves or submits.',
    inputSchema: {
      $schema: JSON_SCHEMA,
      additionalProperties: false,
      properties: {
        decision: { maxLength: 64, minLength: 1, type: 'string' },
        preflightOverrideReason: { maxLength: 1000, type: 'string' },
        reason: { maxLength: 4000, type: 'string' },
        taskId: id('Task id of the review_recommendation task.'),
      },
      required: ['taskId', 'decision'],
      type: 'object',
    },
    name: RECOMMENDATION_TASK_PROCESS_TOOL,
    operations: (args) => [
      cap('application.review'),
      cap('task.sync'),
      ...(String(args.decision ?? '') === 'accept_to_apply'
        ? [cap('application.prepare')]
        : []),
    ],
    outputSchema: { additionalProperties: true, type: 'object' },
    readOnly: false,
  },
  {
    description:
      'Queue company research for one company (creates or reuses its research_company task and tracks its careers page as a source when known), as the opportunity page’s “Research company” action does.',
    inputSchema: {
      $schema: JSON_SCHEMA,
      additionalProperties: false,
      properties: {
        companyId: id('Company id.'),
        opportunityId: { maxLength: 160, type: 'string' },
        reason: { maxLength: 1000, type: 'string' },
      },
      required: ['companyId'],
      type: 'object',
    },
    name: COMPANY_RESEARCH_REQUEST_TOOL,
    // The page action runs under the session only; the deep-dive action that
    // performs the same research asserts the review capability.
    operations: () => [
      { action: 'read', collection: 'companies' },
      cap('application.review'),
      cap('task.sync'),
    ],
    outputSchema: { additionalProperties: true, type: 'object' },
    readOnly: false,
  },
  {
    description:
      'Create a fact intake from pasted text and extract fact candidates for review (the “Add facts” action). Candidates are not applied until accepted.',
    inputSchema: {
      $schema: JSON_SCHEMA,
      additionalProperties: false,
      properties: {
        intakeContext: { maxLength: 1000, type: 'string' },
        rawText: { maxLength: 50000, minLength: 1, type: 'string' },
        sourceKind: { maxLength: 64, type: 'string' },
        targetEntityId: { maxLength: 160, type: 'string' },
        targetEntityType: { maxLength: 64, type: 'string' },
      },
      required: ['rawText'],
      type: 'object',
    },
    name: FACT_INTAKE_CREATE_TOOL,
    operations: () => [cap('profile.manage')],
    outputSchema: { additionalProperties: true, type: 'object' },
    readOnly: false,
  },
  {
    description:
      'Accept one extracted fact candidate into the owner’s facts (the fact intake review action).',
    inputSchema: {
      $schema: JSON_SCHEMA,
      additionalProperties: false,
      properties: { candidateId: id('FactCandidate id.') },
      required: ['candidateId'],
      type: 'object',
    },
    name: FACT_CANDIDATE_ACCEPT_TOOL,
    operations: () => [cap('profile.manage')],
    outputSchema: { additionalProperties: true, type: 'object' },
    readOnly: false,
  },
  {
    description:
      'Archive one owned application and cancel its active tasks (the review page’s “Archive application” action).',
    inputSchema: {
      $schema: JSON_SCHEMA,
      additionalProperties: false,
      properties: { applicationId: id('Application id.') },
      required: ['applicationId'],
      type: 'object',
    },
    name: APPLICATION_ARCHIVE_TOOL,
    operations: () => [cap('application.review'), cap('task.sync')],
    outputSchema: { additionalProperties: true, type: 'object' },
    readOnly: false,
  },
];

const byName = new Map(workflowToolContracts.map((tool) => [tool.name, tool]));

export function workflowToolContract(
  name: string,
): WorkflowToolContract | undefined {
  return byName.get(name);
}

export function isWorkflowToolName(name: string): boolean {
  return byName.has(name);
}

export function workflowMcpTools(): MCPTool[] {
  return workflowToolContracts.map(
    ({ description, inputSchema, name, outputSchema }) => ({
      description,
      inputSchema,
      name,
      outputSchema,
    }),
  );
}
