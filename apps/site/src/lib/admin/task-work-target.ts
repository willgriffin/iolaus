export type TaskWorkTarget = {
  description: string;
  href: string;
  label: string;
};

type TaskRecord = Record<string, unknown>;

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function adminRecordHref(resourceSlug: string, recordId: string): string {
  return `/admin/${resourceSlug}/${encodeURIComponent(recordId)}`;
}

function adminEditHref(resourceSlug: string, recordId: string): string {
  return `${adminRecordHref(resourceSlug, recordId)}/edit`;
}

function adminSelectedRecordHref(
  resourceSlug: string,
  recordId: string,
): string {
  const params = new URLSearchParams({ selected: recordId });
  return `/admin/${resourceSlug}?${params.toString()}`;
}

export function taskWorkTargetForRecord(
  task: TaskRecord | null | undefined,
): TaskWorkTarget | null {
  if (!task) return null;

  const taskType = stringValue(task.taskType);
  const applicationId = stringValue(task.applicationId);
  const opportunityId = stringValue(task.opportunityId);
  const companyId = stringValue(task.companyId);
  const sourceId = stringValue(task.sourceId);

  if (taskType === 'approve_application' && applicationId) {
    return {
      description: 'Open the application package review page.',
      href: `/admin/applications/${encodeURIComponent(applicationId)}`,
      label: 'Review application',
    };
  }

  if (
    [
      'prepare_application_packet',
      'draft_materials',
      'submit_application',
      'follow_up',
      'check_status',
      'interview_prep',
    ].includes(taskType) &&
    applicationId
  ) {
    return {
      description: 'Open the application workspace for this task.',
      href: adminRecordHref('applications', applicationId),
      label:
        taskType === 'submit_application'
          ? 'Open application'
          : 'Work application',
    };
  }

  if (
    ['review_recommendation', 'score_opportunity'].includes(taskType) &&
    opportunityId
  ) {
    return {
      description: 'Open the opportunity row drawer for review.',
      href: adminSelectedRecordHref('opportunities', opportunityId),
      label: 'Review opportunity',
    };
  }

  if (taskType === 'research_company' && companyId) {
    return {
      description: 'Open the company research record.',
      href: adminRecordHref('companies', companyId),
      label: 'Research company',
    };
  }

  if (taskType === 'account_setup' && sourceId) {
    return {
      description:
        'Open the source setup form. Store only the secret reference here.',
      href: adminEditHref('sources', sourceId),
      label: 'Set up source',
    };
  }

  if (['gather_source', 'source_research'].includes(taskType) && sourceId) {
    return {
      description: 'Open the source record for this task.',
      href: adminRecordHref('sources', sourceId),
      label: 'Open source',
    };
  }

  if (taskType === 'account_setup' && applicationId) {
    return {
      description: 'Open the application connected to this account setup.',
      href: adminRecordHref('applications', applicationId),
      label: 'Open application',
    };
  }

  if (opportunityId) {
    return {
      description: 'Open the opportunity connected to this task.',
      href: adminSelectedRecordHref('opportunities', opportunityId),
      label: 'Open opportunity',
    };
  }
  if (applicationId) {
    return {
      description: 'Open the application connected to this task.',
      href: adminRecordHref('applications', applicationId),
      label: 'Open application',
    };
  }
  if (companyId) {
    return {
      description: 'Open the company connected to this task.',
      href: adminRecordHref('companies', companyId),
      label: 'Open company',
    };
  }
  if (sourceId) {
    return {
      description: 'Open the source connected to this task.',
      href: adminRecordHref('sources', sourceId),
      label: 'Open source',
    };
  }
  return null;
}
