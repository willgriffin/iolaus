import {
  taskAssigneeRoleDefinitions,
  workflowLabel,
} from '$lib/objects/workflow';
import {
  assessmentEligibilityLabels,
  assessmentMatchReadinessLabel,
  getOpportunityAssessmentProjection,
} from '$lib/opportunity-assessment-projection';

export type OverviewTask = {
  id: string;
  title: string;
  assignee: string;
  status: string;
  priority: string;
  dueAt: string;
  href: string;
};

export type OverviewOpportunity = {
  id: string;
  title: string;
  company: string;
  location: string;
  fitScore: number | null;
  eligibility: string;
  readiness: string;
  href: string;
};

export type AdminOverview = {
  tasks: OverviewTask[];
  opportunities: OverviewOpportunity[];
  pendingOpportunities: OverviewOpportunity[];
};

type RecordData = Record<string, unknown>;

function text(record: RecordData, key: string): string {
  return typeof record[key] === 'string' ? record[key] : '';
}

function taskRank(record: RecordData, now: number): number {
  if (record.status === 'blocked') return 5;
  const due = Date.parse(text(record, 'dueAt'));
  if (Number.isFinite(due) && due <= now) return 0;
  if (
    record.assigneeRole === 'owner' &&
    [
      'ready_for_user_review',
      'needs_user_decision',
      'manual_submission',
      'needs_account_credentials',
    ].includes(text(record, 'kanbanColumn'))
  )
    return 1;
  if (record.status === 'in_progress') return 2;
  return record.assigneeRole === 'owner' ? 3 : 4;
}

/** Presentation-only ordering over the server's subject-owned active tasks. */
export function prioritizeOverviewTasks(
  records: RecordData[],
  now = Date.now(),
): OverviewTask[] {
  const due = (record: RecordData) => {
    const value = Date.parse(text(record, 'dueAt'));
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return records
    .filter(
      (record) =>
        text(record, 'id') &&
        ['open', 'in_progress', 'blocked'].includes(text(record, 'status')),
    )
    .sort(
      (a, b) =>
        taskRank(a, now) - taskRank(b, now) ||
        due(a) - due(b) ||
        text(a, 'id').localeCompare(text(b, 'id')),
    )
    .slice(0, 8)
    .map((record) => ({
      id: text(record, 'id'),
      title: text(record, 'title') || 'Untitled task',
      assignee:
        taskAssigneeRoleDefinitions.find(
          (role) => role.value === record.assigneeRole,
        )?.label ?? workflowLabel(record.assigneeRole || 'unassigned'),
      status: workflowLabel(record.status),
      priority: [
        'Overdue',
        'Needs your action',
        'In progress',
        'Your next task',
        'Agent or automation',
        'Blocked',
      ][taskRank(record, now)],
      dueAt: text(record, 'dueAt'),
      href: `/admin/tasks/${encodeURIComponent(text(record, 'id'))}`,
    }));
}

/** Never turn legacy evaluation scores or incomplete assessments into matches. */
export function overviewOpportunity(
  record: RecordData,
): OverviewOpportunity | null {
  if (
    !text(record, 'id') ||
    text(record, 'applicationId') ||
    !['found', 'recommended', 'needs_input'].includes(text(record, 'status'))
  )
    return null;
  const assessment = getOpportunityAssessmentProjection(
    record.assessmentProjection,
  );
  const raw = record.assessmentProjection as
    | { ranking?: { excluded?: boolean } }
    | null
    | undefined;
  if (
    raw?.ranking?.excluded === true ||
    assessment.buckets.some(
      (bucket) => bucket === 'location_restriction' || bucket === 'conflicting',
    )
  )
    return null;
  const fitScore =
    assessment.sourceStatus === 'current' &&
    assessment.matchReadiness === 'assessable' &&
    assessment.buckets.some(
      (bucket) => bucket === 'eligible' || bucket === 'sponsorship_possible',
    ) &&
    assessment.fitScore >= 0 &&
    assessment.fitScore <= 100
      ? assessment.fitScore
      : null;
  return {
    id: text(record, 'id'),
    title: text(record, 'title') || 'Untitled opportunity',
    company: text(record, 'companyName'),
    location: text(record, 'location'),
    fitScore,
    eligibility: assessmentEligibilityLabels[assessment.buckets[0]],
    readiness: assessmentMatchReadinessLabel(assessment),
    href: `/admin/opportunities/${encodeURIComponent(text(record, 'id'))}`,
  };
}
