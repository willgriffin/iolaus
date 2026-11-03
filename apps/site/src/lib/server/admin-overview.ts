import {
  type AdminOverview,
  overviewOpportunity,
  prioritizeOverviewTasks,
} from '$lib/admin/overview';
import { taskWorkTargetForRecord } from '$lib/admin/task-work-target';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';
import {
  type AdminRecord,
  listAdminRecords,
  requireAdminResource,
  serializeRecord,
} from './admin-data';
import {
  listOpportunityPageIds,
  loadCurrentSourceOpportunityEligibility,
} from './admin-opportunity-query';
import { loadOpportunityAssessmentReader } from './opportunity-assessment-store';
import { listPrivateRecords } from './private-workspace';
import {
  type CandidateWorkspaceSubject,
  requireCandidateWorkspaceSubject,
  type WorkspaceSubject,
} from './workspace-subject';

async function companyNames(
  postings: AdminRecord[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      postings.flatMap((posting) =>
        typeof posting.companyId === 'string' && posting.companyId
          ? [posting.companyId]
          : [],
      ),
    ),
  ];
  if (!ids.length) return new Map();
  const companies = await listAdminRecords(requireAdminResource('companies'), {
    where: { 'id in': ids },
    limit: ids.length,
    select: ['id', 'name'],
  });
  return new Map(
    companies.flatMap((company) =>
      typeof company.id === 'string' && typeof company.name === 'string'
        ? [[company.id, company.name] as const]
        : [],
    ),
  );
}

async function loadOverviewTasks(subject: CandidateWorkspaceSubject) {
  const tasks = await listPrivateRecords('Task', subject, {
    where: { 'status in': ['open', 'in_progress', 'blocked'] },
    orderBy: 'due_at ASC',
    limit: 250,
  });
  const overviewTasks = prioritizeOverviewTasks(tasks.map(serializeRecord));
  const resource = requireAdminResource('opportunities');
  const displayedTaskIds = new Set(overviewTasks.map((task) => task.id));
  const displayedTasks = tasks.filter((task) =>
    displayedTaskIds.has(String(task.id)),
  );
  const targetByTaskId = new Map(
    displayedTasks.map((task) => [
      String(task.id),
      taskWorkTargetForRecord(task),
    ]),
  );
  const targetIds = (recordClass: 'Source' | 'Opportunity' | 'Company') => [
    ...new Set(
      [...targetByTaskId.values()].flatMap((target) =>
        target?.recordClass === recordClass ? [target.recordId] : [],
      ),
    ),
  ];
  const applicationIds = [
    ...new Set(
      displayedTasks.flatMap((task) =>
        typeof task.applicationId === 'string' && task.applicationId
          ? [task.applicationId]
          : [],
      ),
    ),
  ];
  const sourceIds = targetIds('Source');
  const opportunityTargetIds = targetIds('Opportunity');
  const companyIds = targetIds('Company');
  const [applications, sources, opportunityTargets, companies] =
    await Promise.all([
      applicationIds.length
        ? listPrivateRecords('Application', subject, {
            where: { 'id in': applicationIds },
            limit: applicationIds.length,
          })
        : Promise.resolve([]),
      sourceIds.length
        ? listAdminRecords(requireAdminResource('sources'), {
            where: { 'id in': sourceIds },
            limit: sourceIds.length,
            select: ['id', 'ownerProfileId'],
          })
        : Promise.resolve([]),
      opportunityTargetIds.length
        ? listAdminRecords(resource, {
            where: { 'id in': opportunityTargetIds },
            limit: opportunityTargetIds.length,
            select: ['id'],
          })
        : Promise.resolve([]),
      companyIds.length
        ? listAdminRecords(requireAdminResource('companies'), {
            where: { 'id in': companyIds },
            limit: companyIds.length,
            select: ['id'],
          })
        : Promise.resolve([]),
    ]);
  const applicationById = new Map(
    applications.map((application) => [application.id, application]),
  );
  const validTargets = new Set([
    ...applications.map((application) => `Application:${application.id}`),
    ...sources
      .filter(
        (source) =>
          !source.ownerProfileId || source.ownerProfileId === subject.profileId,
      )
      .map((source) => `Source:${source.id}`),
    ...opportunityTargets.map((opportunity) => `Opportunity:${opportunity.id}`),
    ...companies.map((company) => `Company:${company.id}`),
  ]);
  for (const task of overviewTasks) {
    const target = targetByTaskId.get(task.id);
    if (target && validTargets.has(`${target.recordClass}:${target.recordId}`))
      task.href = target.href;
  }
  if (applicationIds.length) {
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
    const postings = opportunityIds.length
      ? await listAdminRecords(resource, {
          where: { 'id in': opportunityIds },
          limit: opportunityIds.length,
          select: ['id', 'title', 'companyId'],
        })
      : [];
    const postingById = new Map(
      postings.map((posting) => [posting.id, posting]),
    );
    const names = await companyNames(postings);
    for (const task of overviewTasks) {
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
        const name = names.get(String(posting.companyId));
        const context = `${posting.title}${name ? ` · ${name}` : ''}`;
        task.title = `${task.title.slice(0, -record.applicationId.length)}${context}`;
      }
    }
  }
  return overviewTasks;
}

async function loadOverviewOpportunities(subject: CandidateWorkspaceSubject) {
  const [reader, sourceEligibility] = await Promise.all([
    loadOpportunityAssessmentReader(subject),
    loadCurrentSourceOpportunityEligibility(subject),
  ]);
  const list = (pending: boolean) =>
    listOpportunityPageIds({
      ...reader.query,
      candidateSkills: [],
      workspaceSubject: subject,
      reviewFilter: 'unsorted',
      scoreSource: 'assessment',
      sourceEligibilitySnapshot: sourceEligibility,
      filters: {
        ...DEFAULT_OPPORTUNITY_FILTERS,
        excludeExpired: true,
        excludeStale: true,
        eligibilityBuckets: pending
          ? ['eligible', 'sponsorship_possible', 'unknown']
          : ['eligible', 'sponsorship_possible'],
        sort: pending ? 'newest' : 'score',
      },
      // Preserve the same ordered window as the former three pages of 30.
      limit: 90,
      offset: 0,
    });
  const [scoredIds, pendingIds] = await Promise.all([list(false), list(true)]);
  const ids = [...new Set([...scoredIds, ...pendingIds])];
  if (!ids.length) return { opportunities: [], pendingOpportunities: [] };

  const [postings, applications] = await Promise.all([
    listAdminRecords(requireAdminResource('opportunities'), {
      where: { 'id in': ids },
      limit: ids.length,
      select: [
        'id',
        'title',
        'status',
        'locations',
        'companyId',
        'sourceContentFingerprint',
        'sourceContentVersion',
      ],
    }),
    listPrivateRecords('Application', subject, {
      where: { 'opportunityId in': ids },
      select: [
        'id',
        'opportunityId',
        'tenantId',
        'ownerUserId',
        'candidateProfileId',
      ],
    }),
  ]);
  const applicationsByOpportunity = new Set(
    applications.map((row) => row.opportunityId),
  );
  const unclaimed = postings.filter(
    (posting) => !applicationsByOpportunity.has(posting.id),
  );
  const [names, projections] = await Promise.all([
    companyNames(unclaimed),
    reader.project(
      unclaimed.map((posting) => ({
        id: posting.id,
        sourceContentFingerprint: posting.sourceContentFingerprint,
        sourceContentVersion: posting.sourceContentVersion,
      })),
    ),
  ]);
  const byId = new Map(
    unclaimed.map((posting) => [
      posting.id,
      overviewOpportunity({
        ...posting,
        companyName: names.get(String(posting.companyId)),
        location: posting.locations,
        assessmentProjection: projections.get(String(posting.id)),
      }),
    ]),
  );
  const cards = (orderedIds: string[], pending: boolean, limit: number) =>
    [...new Set(orderedIds)]
      .flatMap((id) => {
        const card = byId.get(id);
        return card && (card.fitScore === null) === pending ? [card] : [];
      })
      .slice(0, limit);

  return {
    opportunities: cards(scoredIds, false, 6),
    pendingOpportunities: cards(pendingIds, true, 3),
  };
}

/** Read-only dashboard; all private reads retain the hook-verified subject. */
export async function loadAdminOverview(
  workspaceSubject: WorkspaceSubject,
): Promise<AdminOverview> {
  const subject = requireCandidateWorkspaceSubject(workspaceSubject);
  const [tasks, cards] = await Promise.all([
    loadOverviewTasks(subject),
    loadOverviewOpportunities(subject),
  ]);
  return { tasks, ...cards };
}
