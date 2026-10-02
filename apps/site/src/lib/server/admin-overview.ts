import {
  type AdminOverview,
  overviewOpportunity,
  prioritizeOverviewTasks,
} from '$lib/admin/overview';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';
import {
  listAdminRecords,
  requireAdminResource,
  serializeRecord,
} from './admin-data';
import { listOpportunityPageIds } from './admin-opportunity-query';
import { attachOpportunityContext } from './admin-resource-route';
import { loadOpportunityAssessmentQueryContext } from './opportunity-assessment-store';
import { listPrivateRecords } from './private-workspace';
import {
  requireCandidateWorkspaceSubject,
  type WorkspaceSubject,
} from './workspace-subject';

/** Read-only dashboard; all private reads retain the hook-verified subject. */
export async function loadAdminOverview(
  workspaceSubject: WorkspaceSubject,
): Promise<AdminOverview> {
  const subject = requireCandidateWorkspaceSubject(workspaceSubject);
  const [tasks, assessmentContext] = await Promise.all([
    listPrivateRecords('Task', subject, {
      where: { 'status in': ['open', 'in_progress', 'blocked'] },
      orderBy: 'due_at ASC',
      limit: 250,
    }),
    loadOpportunityAssessmentQueryContext(subject),
  ]);
  const overview: AdminOverview = {
    tasks: prioritizeOverviewTasks(tasks.map(serializeRecord)),
    opportunities: [],
    pendingOpportunities: [],
  };
  const resource = requireAdminResource('opportunities');
  const displayedTaskIds = new Set(overview.tasks.map((task) => task.id));
  const displayedTasks = tasks.filter((task) =>
    displayedTaskIds.has(String(task.id)),
  );
  const applicationIds = [
    ...new Set(
      displayedTasks.flatMap((task) =>
        typeof task.applicationId === 'string' && task.applicationId
          ? [task.applicationId]
          : [],
      ),
    ),
  ];
  if (applicationIds.length) {
    const applications = await listPrivateRecords('Application', subject, {
      where: { 'id in': applicationIds },
      limit: applicationIds.length,
    });
    const opportunityIds = [
      ...new Set(
        applications.flatMap((application) =>
          typeof application.opportunityId === 'string' &&
          application.opportunityId
            ? [application.opportunityId]
            : [],
        ),
      ),
    ];
    const applicationById = new Map(
      applications.map((application) => [application.id, application]),
    );
    const postings = opportunityIds.length
      ? await attachOpportunityContext(
          await listAdminRecords(resource, {
            where: { 'id in': opportunityIds },
            limit: opportunityIds.length,
          }),
          { includeActivity: false, workspaceSubject: subject },
        )
      : [];
    const postingById = new Map(
      postings.map((posting) => [posting.id, posting]),
    );
    for (const task of overview.tasks) {
      const record = displayedTasks.find(
        (candidate) => candidate.id === task.id,
      );
      const application = applicationById.get(record?.applicationId);
      const posting = postingById.get(application?.opportunityId as string);
      if (
        posting &&
        typeof posting.title === 'string' &&
        posting.title.trim() &&
        typeof record?.applicationId === 'string' &&
        task.title.endsWith(record.applicationId)
      ) {
        const context = `${posting.title}${posting.companyName ? ` · ${posting.companyName}` : ''}`;
        task.title = `${task.title.slice(0, -record.applicationId.length)}${context}`;
      }
    }
  }
  // Keep startup work bounded. Continue past existing applications rather than
  // letting a needs_input review make an active draft look like a new posting.
  for (const pending of [false, true]) {
    const target = pending
      ? overview.pendingOpportunities
      : overview.opportunities;
    const desired = pending ? 3 : 6;
    for (let page = 0; page < 3 && target.length < desired; page += 1) {
      const ids = await listOpportunityPageIds({
        ...assessmentContext,
        candidateSkills: [],
        workspaceSubject: subject,
        reviewFilter: 'unsorted',
        filters: {
          ...DEFAULT_OPPORTUNITY_FILTERS,
          excludeExpired: true,
          excludeStale: true,
          eligibilityBuckets: pending
            ? ['eligible', 'sponsorship_possible', 'unknown']
            : ['eligible', 'sponsorship_possible'],
          sort: pending ? 'newest' : 'score',
        },
        limit: 30,
        offset: page * 30,
      });
      if (!ids.length) break;
      const records = await listAdminRecords(resource, {
        where: { 'id in': ids },
        limit: ids.length,
      });
      const byId = new Map(records.map((record) => [record.id, record]));
      const contextual = await attachOpportunityContext(
        ids.flatMap((id) => {
          const record = byId.get(id);
          return record ? [record] : [];
        }),
        { includeActivity: false, workspaceSubject: subject },
      );
      for (const record of contextual) {
        const card = overviewOpportunity(record);
        if (
          card &&
          (card.fitScore === null) === pending &&
          !target.some((existing) => existing.id === card.id)
        )
          target.push(card);
        if (target.length === desired) break;
      }
      if (ids.length < 30) break;
    }
  }
  return overview;
}
