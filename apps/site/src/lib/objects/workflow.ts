export const taskAssigneeRoleDefinitions = [
  { label: 'User', value: 'owner' },
  { label: 'Hermes', value: 'hermes' },
  { label: 'Automation', value: 'automation' },
] as const;

export const taskAssigneeRoles = taskAssigneeRoleDefinitions.map(
  (definition) => definition.value,
);

export type TaskAssigneeRole = (typeof taskAssigneeRoles)[number];

export const taskStatusDefinitions = [
  { label: 'Open', value: 'open' },
  { label: 'In progress', value: 'in_progress' },
  { label: 'Blocked', value: 'blocked' },
  { label: 'Done', value: 'done' },
  { label: 'Canceled', value: 'canceled' },
] as const;

export const taskStatuses = taskStatusDefinitions.map(
  (definition) => definition.value,
);

export const activeTaskStatuses = ['open', 'in_progress', 'blocked'] as const;

export const taskKanbanColumnDefinitions = [
  { label: 'Inbox', value: 'inbox' },
  { label: 'Recommended', value: 'recommended' },
  { label: 'Needs User Decision', value: 'needs_user_decision' },
  { label: 'Accepted / Apply', value: 'accepted_apply' },
  { label: 'Researching', value: 'researching' },
  { label: 'Materials Drafting', value: 'materials_drafting' },
  { label: 'Needs Account / Credentials', value: 'needs_account_credentials' },
  { label: 'Ready for User Review', value: 'ready_for_user_review' },
  { label: 'Approved to Submit', value: 'approved_to_submit' },
  { label: 'Pending submission', value: 'submitting' },
  { label: 'Manual submission', value: 'manual_submission' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Follow-up', value: 'follow_up' },
  { label: 'Interviewing', value: 'interviewing' },
  { label: 'Offer / Negotiation', value: 'offer_negotiation' },
  { label: 'Rejected / Archived', value: 'rejected_archived' },
  { label: 'Blocked', value: 'blocked' },
] as const;

export const taskKanbanColumns = taskKanbanColumnDefinitions.map(
  (definition) => definition.value,
);

export const taskKanbanLaneDefinitions = [
  {
    label: 'Intake & Decisions',
    value: 'intake_decisions',
    columns: ['inbox', 'recommended', 'needs_user_decision'],
  },
  {
    label: 'Research',
    value: 'research',
    columns: ['accepted_apply', 'researching'],
  },
  {
    label: 'Application Prep',
    value: 'application_prep',
    columns: [
      'materials_drafting',
      'needs_account_credentials',
      'ready_for_user_review',
    ],
  },
  {
    label: 'Submit',
    value: 'submit',
    columns: ['approved_to_submit', 'submitting', 'manual_submission'],
  },
  {
    label: 'After Submit',
    value: 'after_submit',
    columns: ['submitted', 'follow_up'],
  },
  {
    label: 'Interview / Offer',
    value: 'interview_offer',
    columns: ['interviewing', 'offer_negotiation'],
  },
  {
    label: 'Blocked / Closed',
    value: 'blocked_closed',
    columns: ['blocked', 'rejected_archived'],
  },
] as const;

export const taskKanbanLanes = taskKanbanLaneDefinitions.map(
  (definition) => definition.value,
);

export const taskTypeDefinitions = [
  { label: 'Gather source', value: 'gather_source' },
  { label: 'Source research', value: 'source_research' },
  { label: 'Account setup', value: 'account_setup' },
  { label: 'Review recommendation', value: 'review_recommendation' },
  { label: 'Research company', value: 'research_company' },
  { label: 'Score opportunity', value: 'score_opportunity' },
  { label: 'Prepare application packet', value: 'prepare_application_packet' },
  { label: 'Draft materials', value: 'draft_materials' },
  { label: 'Approve application', value: 'approve_application' },
  {
    label: 'Collect application answers',
    value: 'collect_application_answers',
  },
  { label: 'Submit application', value: 'submit_application' },
  { label: 'Follow up', value: 'follow_up' },
  { label: 'Check status', value: 'check_status' },
  { label: 'Interview prep', value: 'interview_prep' },
  { label: 'Other', value: 'other' },
] as const;

export const taskTypes = taskTypeDefinitions.map(
  (definition) => definition.value,
);

export const recommendationDecisionDefinitions = [
  { label: 'Accept to apply', value: 'accept_to_apply' },
  { label: 'Reject', value: 'reject' },
  { label: 'Defer', value: 'defer' },
  { label: 'Request more research', value: 'request_more_research' },
  { label: 'Revise score', value: 'revise_score' },
  { label: 'Archive', value: 'archive' },
] as const;

export const recommendationDecisions = recommendationDecisionDefinitions.map(
  (definition) => definition.value,
);

export const accountStatusDefinitions = [
  { label: 'None needed', value: 'none_needed' },
  { label: 'Active', value: 'active' },
  { label: 'Logged in', value: 'logged_in' },
  { label: 'Needs login', value: 'needs_login' },
  { label: 'Needs signup', value: 'needs_signup' },
  { label: 'Needs 2FA', value: 'needs_2fa' },
  { label: 'Blocked', value: 'blocked' },
  { label: 'Unknown', value: 'unknown' },
] as const;

export const accountStatuses = accountStatusDefinitions.map(
  (definition) => definition.value,
);

export const submissionMethodDefinitions = [
  { label: 'Company site', value: 'company_site' },
  { label: 'Job board', value: 'job_board' },
  { label: 'Email', value: 'email' },
  { label: 'Recruiter', value: 'recruiter' },
  { label: 'Referral', value: 'referral' },
  { label: 'Other', value: 'other' },
] as const;

export const submissionMethods = submissionMethodDefinitions.map(
  (definition) => definition.value,
);

export const submittedByRoleDefinitions = [
  { label: 'User', value: 'owner' },
  { label: 'Agent with approval', value: 'agent_with_approval' },
  { label: 'Hermes', value: 'hermes' },
  { label: 'Automation', value: 'automation' },
  { label: 'Other', value: 'other' },
] as const;

export const submittedByRoles = submittedByRoleDefinitions.map(
  (definition) => definition.value,
);

export function isActiveTaskStatus(status: unknown): boolean {
  return activeTaskStatuses.includes(
    String(status ?? '') as (typeof activeTaskStatuses)[number],
  );
}

export function workflowLabel(value: unknown): string {
  return String(value ?? '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
