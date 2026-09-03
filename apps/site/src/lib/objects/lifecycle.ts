export const opportunityStatusDefinitions = [
  {
    description:
      'Discovered by source ingestion or manual entry; not yet recommended.',
    label: 'Found',
    value: 'found',
  },
  {
    description:
      'Scored or reviewed as worth the user deciding whether to apply.',
    label: 'Recommended',
    value: 'recommended',
  },
  {
    description: 'The user accepted the opportunity for application workflow.',
    label: 'Apply',
    value: 'apply',
  },
  {
    description: 'A linked application reached submitted status.',
    label: 'Applied',
    value: 'applied',
  },
  {
    description:
      'The opportunity/application has moved into interview activity.',
    label: 'Interviewing',
    value: 'interviewing',
  },
  {
    description: 'The opportunity produced an offer or negotiation path.',
    label: 'Offer',
    value: 'offer',
  },
  {
    description:
      'The company rejected the application or the user rejected the opportunity.',
    label: 'Rejected',
    value: 'rejected',
  },
  {
    description:
      'No further action is expected; retained for history and scoring feedback.',
    label: 'Archived',
    value: 'archived',
  },
] as const;

export type OpportunityStatus =
  (typeof opportunityStatusDefinitions)[number]['value'];

export const opportunityStatuses = opportunityStatusDefinitions.map(
  (definition) => definition.value,
);

export const applicationStatusDefinitions = [
  {
    description:
      'Application record exists, but materials and answers are not yet planned.',
    label: 'Draft',
    value: 'draft',
  },
  {
    description:
      'Hermes, an agent, or automation is preparing materials or answers.',
    label: 'Application Drafting',
    value: 'application_drafting',
  },
  {
    description:
      'Blocked for user input, review, or explicit approval before external action.',
    label: 'Awaiting User',
    value: 'awaiting_user',
  },
  {
    description:
      'The user approved the submission scope; external submission has not happened yet.',
    label: 'Approved',
    value: 'approved',
  },
  {
    description:
      'Approved and queued for submission: an automated/Hermes submission attempt is pending or underway.',
    label: 'Pending submission',
    value: 'submitting',
  },
  {
    description:
      'Automated submission was not possible (e.g. CAPTCHA, 2FA, or a missing answer); the user needs to submit manually.',
    label: 'Manual submission',
    value: 'manual_submission',
  },
  {
    description:
      'The application was submitted and should have submission evidence recorded.',
    label: 'Submitted',
    value: 'submitted',
  },
  {
    description:
      'The submitted application has interview activity or scheduled interviews.',
    label: 'Interviewing',
    value: 'interviewing',
  },
  {
    description:
      'The application produced an offer or active negotiation path.',
    label: 'Offer',
    value: 'offer',
  },
  {
    description: 'The employer rejected the application.',
    label: 'Rejected',
    value: 'rejected',
  },
  {
    description:
      'The user withdrew the application after submission or approval.',
    label: 'Withdrawn',
    value: 'withdrawn',
  },
  {
    description:
      'No further action is expected; retained for audit and future scoring.',
    label: 'Archived',
    value: 'archived',
  },
] as const;

export type ApplicationStatus =
  (typeof applicationStatusDefinitions)[number]['value'];

export const applicationStatuses = applicationStatusDefinitions.map(
  (definition) => definition.value,
);

export const applicationApprovalRequiredStatuses = [
  'approved',
  'submitting',
  'manual_submission',
  'submitted',
] as const;

export const applicationStatusTransitions: Record<
  ApplicationStatus,
  readonly ApplicationStatus[]
> = {
  application_drafting: ['draft', 'awaiting_user', 'rejected', 'archived'],
  approved: [
    'awaiting_user',
    'submitting',
    'manual_submission',
    'submitted',
    'rejected',
    'archived',
  ],
  archived: [],
  awaiting_user: ['application_drafting', 'approved', 'rejected', 'archived'],
  draft: [
    'application_drafting',
    'awaiting_user',
    'approved',
    'rejected',
    'archived',
  ],
  interviewing: ['offer', 'rejected', 'withdrawn', 'archived'],
  manual_submission: [
    'submitted',
    'awaiting_user',
    'rejected',
    'withdrawn',
    'archived',
  ],
  offer: ['rejected', 'archived'],
  rejected: ['archived'],
  submitted: ['interviewing', 'offer', 'rejected', 'withdrawn', 'archived'],
  submitting: [
    'approved',
    'awaiting_user',
    'manual_submission',
    'submitted',
    'rejected',
    'archived',
  ],
  withdrawn: ['archived'],
};

export interface ApplicationTransitionInput {
  approvedByUserId?: unknown;
  currentStatus?: unknown;
  nextStatus?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function toApplicationStatus(value: unknown): ApplicationStatus | null {
  const status = stringValue(value);
  return applicationStatuses.includes(status as ApplicationStatus)
    ? (status as ApplicationStatus)
    : null;
}

export function toOpportunityStatus(value: unknown): OpportunityStatus | null {
  const status = stringValue(value);
  return opportunityStatuses.includes(status as OpportunityStatus)
    ? (status as OpportunityStatus)
    : null;
}

export function normalizeApplicationStatus(
  value: unknown,
  fallback: ApplicationStatus = 'draft',
): ApplicationStatus {
  return toApplicationStatus(value) ?? fallback;
}

export function applicationStatusRequiresApproval(value: unknown): boolean {
  const status = toApplicationStatus(value);
  return Boolean(
    status &&
      applicationApprovalRequiredStatuses.includes(
        status as (typeof applicationApprovalRequiredStatuses)[number],
      ),
  );
}

export function canTransitionApplicationStatus(
  currentStatus: unknown,
  nextStatus: unknown,
): boolean {
  const current = toApplicationStatus(currentStatus);
  const next = toApplicationStatus(nextStatus);
  if (!next) return false;
  if (!current) return true;
  return (
    current === next || applicationStatusTransitions[current].includes(next)
  );
}

export function validateApplicationStatusTransition(
  input: ApplicationTransitionInput,
): string | null {
  const next = toApplicationStatus(input.nextStatus);
  if (!next) {
    return `Invalid application status: ${stringValue(input.nextStatus) || 'blank'}.`;
  }

  const current =
    input.currentStatus === undefined
      ? null
      : toApplicationStatus(input.currentStatus);
  if (input.currentStatus !== undefined && !current) {
    return `Invalid current application status: ${stringValue(input.currentStatus) || 'blank'}.`;
  }

  if (
    current &&
    current !== next &&
    !applicationStatusTransitions[current].includes(next)
  ) {
    return `Application status cannot transition from ${current} to ${next}.`;
  }

  if (
    applicationStatusRequiresApproval(next) &&
    !stringValue(input.approvedByUserId)
  ) {
    return `Application status ${next} requires explicit user approval.`;
  }

  return null;
}
