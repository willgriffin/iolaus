import type { User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import type { AdminListPagination } from '$lib/admin/pagination';
import {
  createAdminListPagination,
  positiveIntegerSearchParam,
} from '$lib/admin/pagination';
import type { AdminResource } from '$lib/admin/resources';
import experienceData from '$lib/data/experience.json';
import skillsData from '$lib/data/skills.json';
import {
  EMPTY_OPPORTUNITY_FILTER_OPTIONS,
  filterStateFromSearchParams,
  type OpportunityFilterOptions,
} from '$lib/opportunity-filters';
import { candidateSkillTermsFromData } from '$lib/skill-matching';
import type { AdminRecord } from './admin-data';
import {
  countAdminResourceRecords,
  createAdminRecord,
  DEFAULT_ADMIN_RECORD_PAGE_SIZE,
  deleteAdminRecord,
  getAdminRecord,
  listAdminRecords,
  listComboOptions,
  listReferenceOptions,
  requireAdminResource,
  serializeRecord,
  updateAdminRecord,
} from './admin-data';
import {
  countOpportunityRecords,
  createOpportunityQueryFingerprint,
  listOpportunityFilterOptions,
  listOpportunityPageIds,
  OPPORTUNITY_TABLE_PAGE_SIZE,
} from './admin-opportunity-query';
import {
  acceptOpportunityForApplication,
  ensureCompanyResearch,
  processRecommendationTask,
  syncRecommendedOpportunityDecisionTasks,
} from './application-workflow';
import { acceptFactCandidate, createFactIntakeFromText } from './fact-workflow';
import { loadOpportunityDetails } from './opportunity-details';
import { parseOpportunityReasonJson } from './opportunity-intelligence';
import {
  enqueueOpportunityIntelligence,
  isOpportunityIntelligenceEnqueueError,
} from './opportunity-intelligence-job';
import { sweepInactiveSourceOpportunities } from './opportunity-sweep';
import {
  isOwnerAuthorityDenial,
  type OwnerPrincipalLocals,
  runAsOwner,
} from './owner-principal';
import { latestPostingPreflightStatus } from './posting-preflight-status';
import { getCollection } from './smrt';
import {
  enqueueSourceCrawl,
  isSourceCrawlEnqueueError,
} from './source-schedules';
import {
  opportunityDigDeeperOperations,
  opportunityReviewOperations,
  opportunitySweepOperations,
  postingPreflightOperations,
  taskSyncOperations,
} from './workflow-operations';

type AdminActor = Pick<User, 'id'> | null | undefined;

interface AdminOperation {
  action: 'create' | 'delete' | 'read' | 'update';
  collection: string;
}

/**
 * Run an agent-drivable admin mutation as the signed-in owner. Every generated
 * `(collection, action)` permission the workflow needs is asserted inside the
 * principal run before any read or write, so the form action and the
 * MCP/WebMCP surfaces share one authorization gate.
 */
async function runOwnerMutation<T>(
  locals: OwnerPrincipalLocals,
  action: string,
  operations: AdminOperation | readonly AdminOperation[],
  fn: (user: AdminActor) => Promise<T>,
): Promise<T> {
  const required = Array.isArray(operations)
    ? (operations as readonly AdminOperation[])
    : [operations as AdminOperation];
  try {
    return await runAsOwner(
      locals,
      async (run) => {
        for (const operation of required) {
          await run.assertOperation(operation.collection, operation.action);
        }
        return await fn(locals.user);
      },
      {
        action: `admin.${action}`,
        auditMetadata: { operations: required.map((entry) => ({ ...entry })) },
      },
    );
  } catch (cause) {
    if (isOwnerAuthorityDenial(cause)) error(403, 'Forbidden');
    throw cause;
  }
}

/**
 * `createDraftApplicationForOpportunity()`: runs the posting preflight
 * (`postingPreflightOperations`: the opportunity re-read under the lifecycle
 * lock plus the `AgentRun` audit surrogate), reads the opportunity, lists and
 * creates or updates its application, reads the published resume asset for the
 * default resume mode, moves the opportunity into the apply workflow, and
 * syncs (lists, creates, closes) the application's workflow tasks. A closed
 * posting archives the applications and cancels their tasks instead.
 */
const createDraftApplicationOperations = [
  ...postingPreflightOperations,
  { action: 'update', collection: 'opportunities' },
  { action: 'read', collection: 'applications' },
  { action: 'create', collection: 'applications' },
  { action: 'update', collection: 'applications' },
  { action: 'read', collection: 'resumeassets' },
  ...taskSyncOperations,
] satisfies AdminOperation[];

/**
 * `createFactIntakeFromText()`: creates the intake, creates one candidate per
 * extracted fact, then updates the intake with the extraction result.
 */
const createFactIntakeOperations = [
  { action: 'create', collection: 'factintakes' },
  { action: 'update', collection: 'factintakes' },
  { action: 'create', collection: 'factcandidates' },
] satisfies AdminOperation[];

/**
 * `processRecommendationTask()`: reads and closes/blocks the review task,
 * reads and re-statuses the opportunity, records the decision, lists
 * applications for the non-apply guard, and creates follow-up tasks
 * (research, revise-score). Accepting additionally runs the posting preflight,
 * creates or updates the application and its packet/account tasks, re-saves
 * the decision with the application id, kicks off company research (company
 * update, careers source lookup/create), and plans the accepted opportunity
 * from its evaluation scores.
 */
function recommendationTaskOperations(decision: string): AdminOperation[] {
  return [
    ...taskSyncOperations,
    { action: 'read', collection: 'opportunities' },
    { action: 'update', collection: 'opportunities' },
    { action: 'create', collection: 'decisions' },
    { action: 'read', collection: 'decisions' },
    { action: 'read', collection: 'applications' },
    ...(decision === 'accept_to_apply'
      ? ([
          ...postingPreflightOperations,
          { action: 'update', collection: 'decisions' },
          { action: 'create', collection: 'applications' },
          { action: 'update', collection: 'applications' },
          { action: 'read', collection: 'companies' },
          { action: 'update', collection: 'companies' },
          { action: 'read', collection: 'sources' },
          { action: 'create', collection: 'sources' },
          { action: 'read', collection: 'evaluationscores' },
        ] satisfies AdminOperation[])
      : []),
  ];
}

/**
 * `acceptOpportunityForApplication()` is the accept-to-apply branch entered
 * from the opportunity itself: it either completes the active review task
 * through `processRecommendationTask()` or records the decision directly, and
 * runs the same preflight, application, research, and planning writes. A
 * closed posting archives the applications and cancels their tasks instead.
 */
const acceptOpportunityOperations =
  recommendationTaskOperations('accept_to_apply');
export interface RelatedAdminRecordLink {
  href: string;
  id: string;
  label: string;
  record: AdminRecord;
  summary: string;
}

export interface RelatedProjectBulletLink {
  body: string;
  href: string;
  id: string;
  label: string;
  metric: string;
  record: AdminRecord;
}

export interface RelatedProjectLink extends RelatedAdminRecordLink {
  achievements: RelatedProjectBulletLink[];
}

export interface RelatedProjectEditorData {
  comboOptions: Record<string, Array<{ label: string; value: string }>>;
  createRecord: AdminRecord;
  referenceOptions: import('$lib/admin/resources').ReferenceOptionsByField;
  resource: AdminResource;
}

export type RelatedProjectBulletEditorData = RelatedProjectEditorData;

/**
 * Membership joins edited from the opportunity detail page (issue #421). Each
 * kind maps to an existing admin resource so the generic create/delete
 * machinery and its validation stay the single source of truth.
 */
export type OpportunityRelationKind = 'places' | 'roles' | 'tags';

export interface OpportunityRelationEditorData {
  comboOptions: Record<string, Array<{ label: string; value: string }>>;
  kind: OpportunityRelationKind;
  label: string;
  records: AdminRecord[];
  referenceOptions: import('$lib/admin/resources').ReferenceOptionsByField;
  resource: AdminResource;
}

export const OPPORTUNITY_RELATION_KINDS: readonly OpportunityRelationKind[] = [
  'tags',
  'roles',
  'places',
];

const opportunityRelationDefinitions: Record<
  OpportunityRelationKind,
  { collection: string; label: string; slug: string }
> = {
  places: {
    collection: 'opportunityplaces',
    label: 'Places',
    slug: 'opportunity-places',
  },
  roles: {
    collection: 'opportunityroles',
    label: 'Roles',
    slug: 'opportunity-roles',
  },
  tags: {
    collection: 'opportunitytags',
    label: 'Tags',
    slug: 'opportunity-tags',
  },
};

export function isOpportunityRelationKind(
  value: string,
): value is OpportunityRelationKind {
  return (OPPORTUNITY_RELATION_KINDS as readonly string[]).includes(value);
}

export interface AdminResourcePageData {
  activeReviewFilter: string;
  activeTaskOwnerFilter: string;
  activeTaskStatusFilter: string;
  candidateSkills: string[];
  comboOptions: Record<string, Array<{ label: string; value: string }>>;
  error?: string | null;
  loading?: boolean;
  opportunityFilterOptions: OpportunityFilterOptions;
  /**
   * Digest of the filter state this page was resolved under (opportunities
   * only). A bulk action over "all matching rows" hands this back instead of
   * a list of ids, so the server can re-resolve the set and refuse the action
   * if the caller's filters have drifted from the ones the operator saw.
   */
  opportunityQueryFingerprint?: string;
  pagination: import('$lib/admin/pagination').AdminListPagination;
  records: AdminRecord[];
  referenceOptions: import('$lib/admin/resources').ReferenceOptionsByField;
  refreshing?: boolean;
  resource: AdminResource;
  stale?: boolean;
  tenantId?: string | null;
  user?: { id?: string | null } | null;
}

const OPPORTUNITY_DEFAULT_REVIEW_FILTER = 'unsorted';

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function lastStringValue(form: FormData, key: string): string {
  const values = form.getAll(key);
  return stringValue(values.at(-1) ?? null);
}

function stringValues(form: FormData, key: string): string[] {
  return form.getAll(key).map(stringValue).filter(Boolean);
}

async function optionalRelatedRecords(
  className: string,
  options: Record<string, unknown>,
): Promise<AdminRecord[]> {
  try {
    const records = await (await getCollection(className)).list(options);
    return records.map(serializeRecord);
  } catch {
    return [];
  }
}

export interface OpportunityContextOptions {
  /**
   * Attach the `AgentRun` and `FactIntake` activity trail (issue #452).
   *
   * The list's detail surfaces render it; the triage deck does not read a
   * single field of it, and it is by far the heaviest thing in the payload —
   * an `AgentRun` carries its whole `inputJson`/`outputJson`, so the trail is
   * roughly 20KB per card against about 5KB for everything the card actually
   * shows. Opting out removes two of the five hydration reads and about 80% of
   * the bytes on the deck's first window.
   */
  includeActivity?: boolean;
}

export async function attachOpportunityContext(
  records: AdminRecord[],
  options: OpportunityContextOptions = {},
): Promise<AdminRecord[]> {
  const includeActivity = options.includeActivity !== false;
  // Only fetch applications for opportunities on this page. A global row cap can
  // silently drop applications and misclassify the planning review filter.
  const opportunityIds = Array.from(
    new Set(
      records
        .map((record) => record.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  if (opportunityIds.length === 0) return records;

  const companyIds = Array.from(
    new Set(
      records
        .map((record) => record.companyId)
        .filter(
          (companyId): companyId is string =>
            typeof companyId === 'string' && companyId.length > 0,
        ),
    ),
  );

  const [applicationCollection, factIntakeCollection, companyCollection] =
    await Promise.all([
      getCollection('Application'),
      includeActivity ? getCollection('FactIntake') : Promise.resolve(null),
      companyIds.length > 0 ? getCollection('Company') : Promise.resolve(null),
    ]);
  const [
    applications,
    factIntakes,
    latestScoreByOpportunity,
    agentRuns,
    companies,
  ] = await Promise.all([
    applicationCollection.list({
      where: { 'opportunityId in': opportunityIds },
      orderBy: 'updated_at DESC',
    }),
    factIntakeCollection
      ? factIntakeCollection.list({
          where: {
            targetEntityType: 'Opportunity',
            'targetEntityId in': opportunityIds,
          },
          orderBy: 'updated_at DESC',
        })
      : [],
    latestEvaluationScoresByOpportunity(records),
    includeActivity
      ? optionalRelatedRecords('AgentRun', {
          limit: 500,
          where: { 'opportunityId in': opportunityIds },
          orderBy: 'updated_at DESC',
        })
      : [],
    companyCollection
      ? companyCollection.list({ where: { 'id in': companyIds } })
      : [],
  ]);

  const companyById = new Map<string, AdminRecord>();
  for (const company of companies) {
    const serialized = serializeRecord(company);
    if (typeof serialized.id === 'string' && serialized.id) {
      companyById.set(serialized.id, serialized);
    }
  }

  const byOpportunity = new Map<string, AdminRecord>();
  for (const application of applications) {
    const serialized = serializeRecord(application);
    const opportunityId =
      typeof serialized.opportunityId === 'string'
        ? serialized.opportunityId
        : '';
    if (opportunityId && !byOpportunity.has(opportunityId)) {
      byOpportunity.set(opportunityId, serialized);
    }
  }

  const factIntakesByOpportunity = new Map<string, AdminRecord[]>();
  for (const factIntake of factIntakes) {
    const serialized = serializeRecord(factIntake);
    const opportunityId =
      typeof serialized.targetEntityId === 'string'
        ? serialized.targetEntityId
        : '';
    if (!opportunityId) continue;
    const items = factIntakesByOpportunity.get(opportunityId) ?? [];
    items.push(serialized);
    factIntakesByOpportunity.set(opportunityId, items);
  }

  const agentRunsByOpportunity = new Map<string, AdminRecord[]>();
  for (const agentRun of agentRuns) {
    const opportunityId =
      typeof agentRun.opportunityId === 'string' ? agentRun.opportunityId : '';
    if (!opportunityId) continue;
    const items = agentRunsByOpportunity.get(opportunityId) ?? [];
    if (items.length < 8) items.push(agentRun);
    agentRunsByOpportunity.set(opportunityId, items);
  }

  return records.map((record) => {
    const application = record.id ? byOpportunity.get(record.id) : null;
    const factIntakes = record.id
      ? (factIntakesByOpportunity.get(record.id) ?? [])
      : [];
    const latestScore = record.id
      ? latestScoreByOpportunity.get(record.id)
      : null;
    const reason = latestScore
      ? parseOpportunityReasonJson(latestScore.reasonJson)
      : null;
    const agentRuns = record.id
      ? (agentRunsByOpportunity.get(record.id) ?? [])
      : [];
    const company =
      typeof record.companyId === 'string'
        ? companyById.get(record.companyId)
        : null;
    const relatedRecord = {
      ...record,
      // Omitted rather than emptied when the activity trail was not read: an
      // empty array would claim this posting has no runs, which is a different
      // statement from "this surface did not ask".
      ...(includeActivity
        ? {
            agentRunCount: agentRuns.length,
            agentRuns,
            factIntakeCount: factIntakes.length,
            factIntakes,
          }
        : {}),
      companyName: typeof company?.name === 'string' ? company.name : '',
      evidenceMatrix: reason?.evidenceMatrix ?? [],
      latestDataQualityWarnings: reason?.dataQualityWarnings ?? [],
      latestEvaluationScore: latestScore ?? null,
      latestEvaluationScoreId: latestScore?.id ?? '',
      latestFitReasons: reason?.fitReasons ?? [],
      latestMissingInfo: reason?.missingInfo ?? [],
      latestRecommendation: latestScore?.recommendation ?? '',
      latestRisks: reason?.risks ?? [],
      latestScore: latestScore?.score ?? null,
      latestScoreSummary: latestScore?.summary ?? '',
    };

    if (!application) return relatedRecord;

    return {
      ...relatedRecord,
      application,
      applicationApplyMethod: application.applyMethod ?? '',
      applicationCoverLetterMode: application.coverLetterMode ?? '',
      applicationDueAt: application.dueAt ?? '',
      applicationId: application.id ?? '',
      applicationInstructions: application.applicationInstructions ?? '',
      applicationRequiredAnswers: application.requiredAnswers ?? '',
      applicationResumeMode: application.resumeMode ?? '',
      applicationStatus: application.status ?? '',
    };
  });
}

function opportunityIdsFrom(records: AdminRecord[]): string[] {
  return Array.from(
    new Set(
      records
        .map((record) => record.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
}

async function latestEvaluationScoresByOpportunity(
  opportunities: AdminRecord[],
): Promise<Map<string, AdminRecord>> {
  const latestScoreByOpportunity = new Map<string, AdminRecord>();
  const opportunityIds = opportunityIdsFrom(opportunities);
  if (opportunityIds.length === 0) return latestScoreByOpportunity;
  const fingerprints = new Map(
    opportunities.map((opportunity) => [
      opportunity.id,
      typeof opportunity.sourceContentFingerprint === 'string'
        ? opportunity.sourceContentFingerprint
        : '',
    ]),
  );

  let scoreCollection: Awaited<ReturnType<typeof getCollection>>;
  try {
    scoreCollection = await getCollection('EvaluationScore');
  } catch {
    return latestScoreByOpportunity;
  }

  try {
    const scores = await scoreCollection.list({
      orderBy: 'updated_at DESC',
      where: { 'opportunityId in': opportunityIds },
    });
    for (const score of scores) {
      const serialized = serializeRecord(score);
      const opportunityId =
        typeof serialized.opportunityId === 'string'
          ? serialized.opportunityId
          : '';
      const expectedFingerprint = fingerprints.get(opportunityId) ?? '';
      const scoreFingerprint =
        typeof serialized.sourceContentFingerprint === 'string'
          ? serialized.sourceContentFingerprint
          : '';
      if (scoreFingerprint !== expectedFingerprint) {
        continue;
      }
      const existing = latestScoreByOpportunity.get(opportunityId);
      const existingFingerprint =
        typeof existing?.sourceContentFingerprint === 'string'
          ? existing.sourceContentFingerprint
          : '';
      const exactCurrentVersion =
        Boolean(expectedFingerprint) &&
        scoreFingerprint === expectedFingerprint;
      const existingIsExactCurrentVersion =
        Boolean(expectedFingerprint) &&
        existingFingerprint === expectedFingerprint;
      if (
        opportunityId &&
        (!existing || (exactCurrentVersion && !existingIsExactCurrentVersion))
      ) {
        latestScoreByOpportunity.set(opportunityId, serialized);
      }
    }
  } catch {
    // Scores are optional context. A missing/invalid score collection should
    // not break the core opportunity list.
  }

  return latestScoreByOpportunity;
}

function taskWhereForFilters(
  owner: string,
  status: string,
): Record<string, unknown> | undefined {
  const where: Record<string, unknown> = {};
  const normalizedOwner = owner.trim();
  const normalizedStatus = status.trim();

  if (normalizedOwner && normalizedOwner !== 'all') {
    where.assigneeRole = normalizedOwner;
  }
  if (normalizedStatus && normalizedStatus !== 'all') {
    where.status = normalizedStatus;
  }

  return Object.keys(where).length > 0 ? where : undefined;
}

// Resolve each application's opportunity title + company name (two batched
// hops) so the applications list can show "Senior Engineer · Acme" instead of a
// raw opportunity UUID, plus a clickable link back to the opportunity.
async function attachApplicationContext(
  records: AdminRecord[],
): Promise<AdminRecord[]> {
  const opportunityIds = Array.from(
    new Set(
      records
        .map((record) =>
          typeof record.opportunityId === 'string' ? record.opportunityId : '',
        )
        .filter((id) => id.length > 0),
    ),
  );
  if (opportunityIds.length === 0) return records;

  const opportunities = await (await getCollection('Opportunity')).list({
    where: { 'id in': opportunityIds },
  });
  const opportunityById = new Map<string, AdminRecord>();
  const companyIds = new Set<string>();
  for (const opportunity of opportunities) {
    const serialized = serializeRecord(opportunity);
    const id = typeof serialized.id === 'string' ? serialized.id : '';
    if (!id) continue;
    opportunityById.set(id, serialized);
    if (typeof serialized.companyId === 'string' && serialized.companyId) {
      companyIds.add(serialized.companyId);
    }
  }

  const companyById = new Map<string, AdminRecord>();
  if (companyIds.size > 0) {
    const companies = await (await getCollection('Company')).list({
      where: { 'id in': Array.from(companyIds) },
    });
    for (const company of companies) {
      const serialized = serializeRecord(company);
      const id = typeof serialized.id === 'string' ? serialized.id : '';
      if (id) companyById.set(id, serialized);
    }
  }

  return records.map((record) => {
    const opportunityId =
      typeof record.opportunityId === 'string' ? record.opportunityId : '';
    const opportunity = opportunityId
      ? opportunityById.get(opportunityId)
      : null;
    const companyId =
      opportunity && typeof opportunity.companyId === 'string'
        ? opportunity.companyId
        : '';
    const company = companyId ? companyById.get(companyId) : null;
    return {
      ...record,
      companyName:
        company && typeof company.name === 'string' ? company.name : '',
      opportunityHref: opportunityId
        ? `/admin/opportunities/${encodeURIComponent(opportunityId)}`
        : '',
      opportunityTitle:
        opportunity && typeof opportunity.title === 'string'
          ? opportunity.title
          : '',
    };
  });
}

async function attachExperienceContext(
  records: AdminRecord[],
): Promise<AdminRecord[]> {
  const experienceIds = Array.from(
    new Set(
      records
        .map((record) => record.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  if (experienceIds.length === 0) return records;

  const projects = await (await getCollection('Project')).list({
    where: { 'experienceId in': experienceIds },
    orderBy: 'sortOrder ASC',
  });
  const projectsByExperience = new Map<string, string[]>();
  for (const project of projects) {
    const serialized = serializeRecord(project);
    const experienceId =
      typeof serialized.experienceId === 'string'
        ? serialized.experienceId
        : '';
    if (!experienceId) continue;
    const name =
      typeof serialized.name === 'string' && serialized.name.trim()
        ? serialized.name.trim()
        : typeof serialized.projectKey === 'string'
          ? serialized.projectKey.trim()
          : '';
    if (!name) continue;
    const names = projectsByExperience.get(experienceId) ?? [];
    names.push(name);
    projectsByExperience.set(experienceId, names);
  }

  return records.map((record) => ({
    ...record,
    projectNames: record.id
      ? (projectsByExperience.get(record.id)?.join(', ') ?? '')
      : '',
  }));
}

function projectLabel(project: AdminRecord): string {
  const name = typeof project.name === 'string' ? project.name.trim() : '';
  if (name) return name;

  const projectKey =
    typeof project.projectKey === 'string' ? project.projectKey.trim() : '';
  return projectKey || 'Untitled project';
}

function projectBulletLabel(achievement: AdminRecord): string {
  const body = projectBulletBody(achievement);
  if (body) return body.length > 96 ? `${body.slice(0, 93)}...` : body;

  const title =
    typeof achievement.title === 'string' ? achievement.title.trim() : '';
  if (title) return title;

  return 'Untitled bullet';
}

function projectBulletBody(achievement: AdminRecord): string {
  return typeof achievement.body === 'string' ? achievement.body.trim() : '';
}

function projectBulletMetric(achievement: AdminRecord): string {
  return typeof achievement.metric === 'string'
    ? achievement.metric.trim()
    : '';
}

async function listProjectAchievementLinks(
  projectIds: string[],
): Promise<Map<string, RelatedProjectBulletLink[]>> {
  const byProject = new Map<string, RelatedProjectBulletLink[]>();
  if (projectIds.length === 0) return byProject;

  const achievements = await (await getCollection('Achievement')).list({
    where: { 'projectId in': projectIds },
    orderBy: 'sortOrder ASC',
  });

  for (const achievement of achievements) {
    const record = serializeRecord(achievement);
    const id = typeof record.id === 'string' ? record.id : '';
    const projectId =
      typeof record.projectId === 'string' ? record.projectId : '';
    if (!id || !projectId) continue;
    const projectAchievements = byProject.get(projectId) ?? [];
    projectAchievements.push({
      body: projectBulletBody(record),
      href: `/admin/achievements/${encodeURIComponent(id)}`,
      id,
      label: projectBulletLabel(record),
      metric: projectBulletMetric(record),
      record,
    });
    byProject.set(projectId, projectAchievements);
  }

  return byProject;
}

async function listExperienceProjectLinks(
  experienceId: string,
): Promise<RelatedProjectLink[]> {
  if (!experienceId) return [];

  const projects = await (await getCollection('Project')).list({
    where: { experienceId },
    orderBy: 'sortOrder ASC',
  });
  const projectRecords = projects
    .map((project) => serializeRecord(project))
    .filter(
      (project): project is AdminRecord => typeof project.id === 'string',
    );
  const achievementsByProject = await listProjectAchievementLinks(
    projectRecords.map((project) => String(project.id)),
  );

  return projectRecords.map((project) => ({
    achievements: achievementsByProject.get(String(project.id)) ?? [],
    href: `/admin/projects/${encodeURIComponent(String(project.id))}`,
    id: String(project.id),
    label: projectLabel(project),
    record: project,
    summary: typeof project.summary === 'string' ? project.summary.trim() : '',
  }));
}

async function requireExperienceProjectRecord(
  experienceId: string,
  projectId: string,
): Promise<AdminRecord> {
  if (!projectId) {
    error(400, 'Missing project id');
  }

  const project = await getAdminRecord(
    requireAdminResource('projects'),
    projectId,
  );
  if (!project) {
    error(404, 'Project not found');
  }

  if (project.experienceId !== experienceId) {
    error(400, 'Project is not associated with this experience item.');
  }

  return project;
}

async function requireExperienceProjectAchievementRecord(
  experienceId: string,
  achievementId: string,
): Promise<AdminRecord> {
  if (!achievementId) {
    error(400, 'Missing bullet id');
  }

  const resource = requireAdminResource('achievements');
  const achievement = await getAdminRecord(resource, achievementId);
  if (!achievement) {
    error(404, 'Project bullet not found');
  }

  const projectId =
    typeof achievement.projectId === 'string' ? achievement.projectId : '';
  await requireExperienceProjectRecord(experienceId, projectId);

  return achievement;
}

function projectIdFromForm(form: FormData): string {
  return stringValue(form.get('projectId'));
}

export function safeAdminReturnTo(value: string | null | undefined): string {
  if (!value) return '';

  let parsed: URL;
  try {
    parsed = new URL(value, 'http://localhost');
  } catch {
    return '';
  }

  if (parsed.origin !== 'http://localhost') return '';
  if (parsed.pathname !== '/admin' && !parsed.pathname.startsWith('/admin/')) {
    return '';
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Build the synchronous portion of an admin list route.
 *
 * The resource schema and URL state are safe to render immediately. Records
 * and editor metadata deliberately arrive through the authenticated list API
 * after navigation, rather than delaying the route transition.
 */
export function loadAdminResourcePageShellData(
  resourceSlug: string,
  url: URL,
  identity: {
    tenantId?: string | null;
    user?: { id?: string | null } | null;
  } = {},
): AdminResourcePageData {
  const resource = requireAdminResource(resourceSlug);
  const requestedPage = positiveIntegerSearchParam(url, 'page', 1);
  const reviewFilter =
    resource.slug === 'opportunities'
      ? (url.searchParams.get('review') ?? OPPORTUNITY_DEFAULT_REVIEW_FILTER)
      : 'all';
  const taskOwnerFilter =
    resource.slug === 'tasks'
      ? (url.searchParams.get('owner') ?? 'all')
      : 'all';
  const taskStatusFilter =
    resource.slug === 'tasks'
      ? (url.searchParams.get('status') ?? 'all')
      : 'all';
  const pageSize =
    resource.slug === 'opportunities'
      ? OPPORTUNITY_TABLE_PAGE_SIZE
      : DEFAULT_ADMIN_RECORD_PAGE_SIZE;

  return {
    activeReviewFilter: reviewFilter,
    activeTaskOwnerFilter: taskOwnerFilter,
    activeTaskStatusFilter: taskStatusFilter,
    candidateSkills: [],
    comboOptions: {},
    loading: true,
    opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
    pagination: createPendingAdminListPagination(requestedPage, pageSize),
    records: [],
    referenceOptions: {},
    resource,
    tenantId: identity.tenantId ?? null,
    user: identity.user ?? null,
  };
}

/**
 * Keep the requested page visible while the real total is still loading.
 * `createAdminListPagination` correctly clamps page numbers against a known
 * total, but a shell total of zero must not erase a deep-linked page.
 */
function createPendingAdminListPagination(
  requestedPage: number,
  pageSize: number,
): AdminListPagination {
  return {
    end: 0,
    hasNextPage: false,
    hasPreviousPage: requestedPage > 1,
    offset: (requestedPage - 1) * pageSize,
    page: requestedPage,
    pageSize,
    recordCount: 0,
    start: 0,
    totalPages: requestedPage,
    totalRecords: 0,
  };
}

export async function loadAdminResourcePageData(
  resourceSlug: string,
  url: URL,
): Promise<AdminResourcePageData> {
  const resource = requireAdminResource(resourceSlug);
  const requestedPage = positiveIntegerSearchParam(url, 'page', 1);
  const reviewFilter =
    resource.slug === 'opportunities'
      ? (url.searchParams.get('review') ?? OPPORTUNITY_DEFAULT_REVIEW_FILTER)
      : 'all';
  const taskOwnerFilter =
    resource.slug === 'tasks'
      ? (url.searchParams.get('owner') ?? 'all')
      : 'all';
  const taskStatusFilter =
    resource.slug === 'tasks'
      ? (url.searchParams.get('status') ?? 'all')
      : 'all';
  if (resource.slug === 'opportunities') {
    const opportunityFilters = filterStateFromSearchParams(url.searchParams);
    const candidateSkills = candidateSkillSlugs();
    const shouldLoadFacetOptions = url.searchParams.has('facets');
    // Fingerprint exactly the query the count and page listing run, so the
    // digest the browser receives describes the rows the operator is shown.
    const opportunityQuery = {
      candidateSkills,
      filters: opportunityFilters,
      reviewFilter,
    };
    const opportunityQueryFingerprint =
      createOpportunityQueryFingerprint(opportunityQuery);
    const [totalRecords, opportunityFilterOptions] = await Promise.all([
      countOpportunityRecords(opportunityQuery),
      shouldLoadFacetOptions
        ? listOpportunityFilterOptions(reviewFilter)
        : Promise.resolve(EMPTY_OPPORTUNITY_FILTER_OPTIONS),
    ]);
    const pagination = createAdminListPagination(
      totalRecords,
      requestedPage,
      OPPORTUNITY_TABLE_PAGE_SIZE,
    );
    const pageIds = await listOpportunityPageIds({
      candidateSkills,
      filters: opportunityFilters,
      limit: pagination.pageSize,
      offset: pagination.offset,
      reviewFilter,
    });
    const rawRecords =
      pageIds.length > 0
        ? await listAdminRecords(resource, {
            limit: pageIds.length,
            where: { 'id in': pageIds },
          })
        : [];
    const recordById = new Map(
      rawRecords
        .map((record) => [record.id, record] as const)
        .filter(
          (entry): entry is readonly [string, AdminRecord] =>
            typeof entry[0] === 'string',
        ),
    );
    const records = await attachOpportunityContext(
      pageIds
        .map((id) => recordById.get(id))
        .filter((record): record is AdminRecord => Boolean(record)),
    );

    return {
      activeReviewFilter: reviewFilter,
      activeTaskOwnerFilter: taskOwnerFilter,
      activeTaskStatusFilter: taskStatusFilter,
      candidateSkills,
      comboOptions: {},
      opportunityFilterOptions,
      opportunityQueryFingerprint,
      pagination: createAdminListPagination(
        totalRecords,
        requestedPage,
        OPPORTUNITY_TABLE_PAGE_SIZE,
        records.length,
      ),
      referenceOptions: {},
      records,
      resource,
    };
  }

  const pageSize = DEFAULT_ADMIN_RECORD_PAGE_SIZE;
  const recordWhere =
    resource.slug === 'tasks'
      ? taskWhereForFilters(taskOwnerFilter, taskStatusFilter)
      : undefined;
  // The total, combo options, and reference options are independent queries;
  // load them concurrently instead of serializing the round-trips.
  const [totalRecords, comboOptions, referenceOptions] = await Promise.all([
    countAdminResourceRecords(resource, { where: recordWhere }),
    listComboOptions(resource),
    listReferenceOptions(resource),
  ]);

  const pagination = createAdminListPagination(
    totalRecords,
    requestedPage,
    pageSize,
  );
  const rawRecords = await listAdminRecords(resource, {
    limit: pagination.pageSize,
    offset: pagination.offset,
    where: recordWhere,
  });
  const records =
    resource.slug === 'applications'
      ? await attachApplicationContext(rawRecords)
      : resource.slug === 'experience'
        ? await attachExperienceContext(rawRecords)
        : rawRecords;

  return {
    activeReviewFilter: reviewFilter,
    activeTaskOwnerFilter: taskOwnerFilter,
    activeTaskStatusFilter: taskStatusFilter,
    candidateSkills: [],
    comboOptions,
    opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
    pagination: createAdminListPagination(
      totalRecords,
      requestedPage,
      pageSize,
      records.length,
    ),
    referenceOptions,
    records,
    resource,
  };
}

// Normalized terms from reviewed resume skills and achievements used to color
// opportunity skill chips as supported/missing. This intentionally includes
// curated achievement titles such as "Hybrid Cloud Infrastructure" so broad
// posting phrases don't require a one-off exact skill slug to turn green.
export function candidateSkillSlugs(): string[] {
  return candidateSkillTermsFromData({
    experience: experienceData,
    skills: skillsData,
  });
}

export async function loadAdminCreatePageData(resourceSlug: string) {
  const resource = requireAdminResource(resourceSlug);
  const [comboOptions, referenceOptions] = await Promise.all([
    listComboOptions(resource),
    listReferenceOptions(resource),
  ]);
  return {
    comboOptions,
    referenceOptions,
    resource,
  };
}

export async function loadAdminRecordPageData(
  resourceSlug: string,
  recordId: string,
  options: {
    includeOpportunityRelations?: boolean;
    includeRelatedProjects?: boolean;
    returnTo?: string;
  } = {},
) {
  const resource = requireAdminResource(resourceSlug);
  // Combo/reference options only depend on the resource, so load them
  // concurrently with the record. Keep them inside the Promise.all (rather than
  // firing them early and awaiting later) so a rejection from any one is always
  // observed — a dangling option promise on the 404/error path would otherwise
  // surface as an unhandled rejection.
  const [comboOptions, referenceOptions, record] = await Promise.all([
    listComboOptions(resource),
    listReferenceOptions(resource),
    getAdminRecord(resource, recordId),
  ]);
  if (!record) {
    error(404, `${resource.singularLabel} not found`);
  }

  const records =
    resource.slug === 'opportunities'
      ? await attachOpportunityContext([record])
      : [record];

  let company: AdminRecord | null = null;
  let opportunityRelations: OpportunityRelationEditorData[] = [];
  if (resource.slug === 'opportunities') {
    const companyId =
      typeof records[0]?.companyId === 'string' ? records[0].companyId : '';
    const [foundCompany, relations] = await Promise.all([
      companyId
        ? (async () => {
            try {
              const found = await (await getCollection('Company')).get(
                companyId,
              );
              return found ? serializeRecord(found) : null;
            } catch {
              return null;
            }
          })()
        : Promise.resolve(null),
      options.includeOpportunityRelations
        ? listOpportunityRelationEditors(recordId)
        : Promise.resolve([]),
    ]);
    company = foundCompany;
    opportunityRelations = relations;
  }

  let relatedProjectEditor: RelatedProjectEditorData | null = null;
  let relatedProjectBulletEditor: RelatedProjectBulletEditorData | null = null;
  let relatedProjects: RelatedProjectLink[] = [];
  if (resource.slug === 'experience' && options.includeRelatedProjects) {
    const projectResource = requireAdminResource('projects');
    const achievementResource = requireAdminResource('achievements');
    const [
      projectComboOptions,
      projectReferenceOptions,
      projectLinks,
      achievementComboOptions,
      achievementReferenceOptions,
    ] = await Promise.all([
      listComboOptions(projectResource),
      listReferenceOptions(projectResource),
      listExperienceProjectLinks(recordId),
      listComboOptions(achievementResource),
      listReferenceOptions(achievementResource),
    ]);
    relatedProjectEditor = {
      comboOptions: projectComboOptions,
      createRecord: {
        endPrecision: 'year',
        experienceId: recordId,
        sortOrder: projectLinks.length,
        startPrecision: 'year',
      },
      referenceOptions: projectReferenceOptions,
      resource: projectResource,
    };
    relatedProjectBulletEditor = {
      comboOptions: achievementComboOptions,
      createRecord: {
        experienceId: recordId,
        sortOrder: 0,
      },
      referenceOptions: achievementReferenceOptions,
      resource: achievementResource,
    };
    relatedProjects = projectLinks;
  }

  return {
    company,
    comboOptions,
    opportunityRelations,
    referenceOptions,
    record: records[0],
    relatedProjectBulletEditor,
    relatedProjectEditor,
    relatedProjects,
    resource,
    returnTo: safeAdminReturnTo(options.returnTo),
  };
}

export async function createExperienceProjectAction(
  experienceId: string,
  request: Request,
  user: AdminActor,
) {
  const resource = requireAdminResource('projects');
  const form = await request.formData();
  form.set('experienceId', experienceId);
  return await createAdminRecord(resource, form, user);
}

export async function updateExperienceProjectAction(
  experienceId: string,
  request: Request,
  user: AdminActor,
) {
  const resource = requireAdminResource('projects');
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  if (!id) {
    error(400, 'Missing project id');
  }

  const current = await getAdminRecord(resource, id);
  if (!current) {
    error(404, 'Project not found');
  }

  if (current.experienceId !== experienceId) {
    error(400, 'Project is not associated with this experience item.');
  }

  form.set('experienceId', experienceId);
  return await updateAdminRecord(resource, form, user);
}

export async function createExperienceProjectBulletAction(
  experienceId: string,
  request: Request,
  user: AdminActor,
) {
  const resource = requireAdminResource('achievements');
  const form = await request.formData();
  const projectId = projectIdFromForm(form);
  await requireExperienceProjectRecord(experienceId, projectId);

  form.set('experienceId', experienceId);
  form.set('projectId', projectId);
  form.set('title', '');
  return await createAdminRecord(resource, form, user);
}

export async function updateExperienceProjectBulletAction(
  experienceId: string,
  request: Request,
  user: AdminActor,
) {
  const resource = requireAdminResource('achievements');
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const current = await requireExperienceProjectAchievementRecord(
    experienceId,
    id,
  );
  const projectId =
    typeof current.projectId === 'string' ? current.projectId : '';

  form.set('experienceId', experienceId);
  form.set('projectId', projectId);
  form.set('title', '');
  return await updateAdminRecord(resource, form, user);
}

function opportunityRelationKindFromForm(
  form: FormData,
): OpportunityRelationKind {
  const kind = stringValue(form.get('relation'));
  if (!isOpportunityRelationKind(kind)) {
    error(400, 'Unknown opportunity relation.');
  }
  return kind;
}

async function listOpportunityRelationEditors(
  opportunityId: string,
): Promise<OpportunityRelationEditorData[]> {
  return await Promise.all(
    OPPORTUNITY_RELATION_KINDS.map(async (kind) => {
      const definition = opportunityRelationDefinitions[kind];
      const resource = requireAdminResource(definition.slug);
      const [comboOptions, referenceOptions, records] = await Promise.all([
        listComboOptions(resource),
        listReferenceOptions(resource),
        listAdminRecords(resource, { where: { opportunityId } }),
      ]);
      return {
        comboOptions,
        kind,
        label: definition.label,
        records,
        referenceOptions,
        resource,
      };
    }),
  );
}

export async function createOpportunityRelationAction(
  opportunityId: string,
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const form = await request.formData();
  const kind = opportunityRelationKindFromForm(form);
  const definition = opportunityRelationDefinitions[kind];
  const resource = requireAdminResource(definition.slug);
  form.set('opportunityId', opportunityId);
  return await runOwnerMutation(
    locals,
    'createOpportunityRelation',
    { action: 'create', collection: definition.collection },
    (user) => createAdminRecord(resource, form, user),
  );
}

export async function deleteOpportunityRelationAction(
  opportunityId: string,
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const form = await request.formData();
  const kind = opportunityRelationKindFromForm(form);
  const definition = opportunityRelationDefinitions[kind];
  const resource = requireAdminResource(definition.slug);
  // The lookup and the association check run inside the principal run, after
  // both the read and the delete permission are asserted: a caller lacking
  // either gets a uniform 403 and cannot distinguish a missing, associated, or
  // differently associated id, and the read is part of the audited execution.
  return await runOwnerMutation(
    locals,
    'deleteOpportunityRelation',
    [
      { action: 'read', collection: definition.collection },
      { action: 'delete', collection: definition.collection },
    ],
    async () => {
      const id = stringValue(form.get('id'));
      if (!id) {
        error(400, 'Missing relation id');
      }
      const current = await getAdminRecord(resource, id);
      if (!current) {
        error(404, `${resource.singularLabel} not found`);
      }
      if (current.opportunityId !== opportunityId) {
        error(400, 'Relation is not associated with this opportunity.');
      }
      return await deleteAdminRecord(resource, form);
    },
  );
}

export async function createAdminResourceAction(
  resourceSlug: string,
  request: Request,
  user: AdminActor,
) {
  const resource = requireAdminResource(resourceSlug);
  return await createAdminRecord(resource, await request.formData(), user);
}

export async function updateAdminResourceAction(
  resourceSlug: string,
  request: Request,
  user: AdminActor,
) {
  const resource = requireAdminResource(resourceSlug);
  return await updateAdminRecord(resource, await request.formData(), user);
}

export async function deleteAdminResourceAction(
  resourceSlug: string,
  request: Request,
) {
  const resource = requireAdminResource(resourceSlug);
  return await deleteAdminRecord(resource, await request.formData());
}

export async function crawlSourceNowAction(
  resourceSlug: string,
  request: Request,
) {
  const resource = requireAdminResource(resourceSlug);
  if (resource.className !== 'Source') {
    return {
      message: 'Crawl jobs can only be queued for sources.',
      status: 'error',
    };
  }

  const form = await request.formData();
  let job: Awaited<ReturnType<typeof enqueueSourceCrawl>>;
  try {
    job = await enqueueSourceCrawl(stringValue(form.get('sourceId')));
  } catch (cause) {
    if (isSourceCrawlEnqueueError(cause)) {
      return {
        message: cause.message.slice(0, 300),
        status: 'error',
      };
    }
    throw cause;
  }
  return {
    jobId: job.id,
    message: 'Crawl queued.',
    status: 'queued',
  };
}

export async function reviewOpportunityAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const { updateOpportunityReview } = await import('./application-package.js');
  const form = await request.formData();
  return await runOwnerMutation(
    locals,
    'reviewOpportunity',
    opportunityReviewOperations,
    (user) =>
      updateOpportunityReview({
        humanRating: stringValue(form.get('humanRating')),
        humanReviewNotes: stringValue(form.get('humanReviewNotes')),
        humanReviewStatus: lastStringValue(form, 'humanReviewStatus'),
        opportunityId: stringValue(form.get('opportunityId')),
        reviewedByProfileId: stringValue(form.get('reviewedByProfileId')),
        user,
      }),
  );
}

export async function bulkReviewOpportunitiesAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const { bulkUpdateOpportunityReviews } = await import(
    './application-package.js'
  );
  const form = await request.formData();
  return await runOwnerMutation(
    locals,
    'bulkReviewOpportunities',
    opportunityReviewOperations,
    (user) =>
      bulkUpdateOpportunityReviews({
        humanRating: stringValue(form.get('humanRating')),
        humanReviewNotes: stringValue(form.get('humanReviewNotes')),
        humanReviewStatus: lastStringValue(form, 'humanReviewStatus'),
        opportunityIds: stringValues(form, 'opportunityId'),
        reviewedByProfileId: stringValue(form.get('reviewedByProfileId')),
        user,
      }),
  );
}

export async function loadOpportunityDetailsAction(request: Request) {
  const form = await request.formData();
  return await loadOpportunityDetails(stringValue(form.get('opportunityId')));
}

export async function processOpportunityWithLlmAction(
  request: Request,
  user: AdminActor,
) {
  const form = await request.formData();
  let job: Awaited<ReturnType<typeof enqueueOpportunityIntelligence>>;
  try {
    job = await enqueueOpportunityIntelligence(
      stringValue(form.get('opportunityId')),
      { modes: 'all' },
      { user },
    );
  } catch (cause) {
    if (isOpportunityIntelligenceEnqueueError(cause)) {
      return {
        message: cause.message,
        status: 'error',
      };
    }
    throw cause;
  }
  return {
    jobId: job.id,
    message: `Opportunity intelligence queued as job ${job.id}.`,
    status: 'queued',
  };
}

export async function processOpportunityAction(
  request: Request,
  user: AdminActor,
) {
  return await processOpportunityWithLlmAction(request, user);
}

/**
 * Stage 0 sweep trigger for the opportunities list. The dry run reports the
 * matching count and a sample and writes nothing; archiving is a separate,
 * explicitly confirmed submission.
 */
async function runInactiveOpportunitySweep(
  request: Request,
  locals: OwnerPrincipalLocals,
  dryRun: boolean,
) {
  const form = await request.formData();
  const notSeenDaysValue = stringValue(form.get('notSeenDays'));
  const result = await runOwnerMutation(
    locals,
    dryRun
      ? 'previewInactiveOpportunitySweep'
      : 'applyInactiveOpportunitySweep',
    opportunitySweepOperations,
    (user) =>
      sweepInactiveSourceOpportunities({
        dryRun,
        notSeenDays: notSeenDaysValue || undefined,
        user,
      }),
  );
  return {
    applied: result.applied,
    archivedCount: result.archivedCount,
    count: result.count,
    message: result.message,
    notSeenDays: result.filter.notSeenDays,
    reviewTasksClosed: result.reviewTasksClosed,
    sample: result.sample,
    // Rows the apply locked but then refused to archive because they gained a
    // protecting artifact after the preview (#437).
    skippedCount: result.skippedCount,
    status: result.applied ? 'archived' : 'preview',
    sweep: true,
  };
}

export async function previewInactiveOpportunitySweepAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  return await runInactiveOpportunitySweep(request, locals, true);
}

export async function applyInactiveOpportunitySweepAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  return await runInactiveOpportunitySweep(request, locals, false);
}

export async function createDraftApplicationAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const { createDraftApplicationForOpportunity } = await import(
    './application-package.js'
  );
  const form = await request.formData();
  return await runOwnerMutation(
    locals,
    'createDraftApplication',
    createDraftApplicationOperations,
    (user) =>
      createDraftApplicationForOpportunity({
        applicationInstructions: stringValue(
          form.get('applicationInstructions'),
        ),
        applyMethod: stringValue(form.get('applyMethod')),
        coverLetterMode: stringValue(form.get('coverLetterMode')),
        dueAt: stringValue(form.get('dueAt')),
        opportunityId: stringValue(form.get('opportunityId')),
        preflightOverrideReason: stringValue(
          form.get('preflightOverrideReason'),
        ),
        requiredAnswers: stringValue(form.get('requiredAnswers')),
        resumeMode: stringValue(form.get('resumeMode')),
        user,
      }),
  );
}

export async function createFactIntakeAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const form = await request.formData();
  return await runOwnerMutation(
    locals,
    'createFactIntake',
    createFactIntakeOperations,
    (user) =>
      createFactIntakeFromText({
        intakeContext: stringValue(form.get('intakeContext')),
        createdByProfileId: stringValue(form.get('createdByProfileId')),
        rawText: stringValue(form.get('rawText')),
        sourceKind: stringValue(form.get('sourceKind')),
        targetEntityId: stringValue(form.get('targetEntityId')),
        targetEntityType: stringValue(form.get('targetEntityType')),
        user,
      }),
  );
}

export async function syncRecommendationTasksAction(resourceSlug: string) {
  const resource = requireAdminResource(resourceSlug);
  if (resource.className !== 'Task') {
    return {
      message: 'Recommendation tasks can only be synced from the task board.',
      status: 'error',
    };
  }
  return {
    ...(await syncRecommendedOpportunityDecisionTasks()),
    status: 'synced',
  };
}

export async function processRecommendationTaskAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const form = await request.formData();
  const decision = stringValue(form.get('decision'));
  return await runOwnerMutation(
    locals,
    'processRecommendationTask',
    recommendationTaskOperations(decision),
    (user) =>
      processRecommendationTask({
        deciderProfileId: stringValue(form.get('deciderProfileId')),
        decision,
        preflightOverrideReason: stringValue(
          form.get('preflightOverrideReason'),
        ),
        reason: stringValue(form.get('reason')),
        taskId: stringValue(form.get('taskId')),
        user,
      }),
  );
}

export async function acceptOpportunityAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const form = await request.formData();
  return await runOwnerMutation(
    locals,
    'acceptOpportunity',
    acceptOpportunityOperations,
    (user) =>
      acceptOpportunityForApplication({
        deciderProfileId: stringValue(form.get('reviewedByProfileId')),
        opportunityId: stringValue(form.get('opportunityId')),
        preflightOverrideReason: stringValue(
          form.get('preflightOverrideReason'),
        ),
        reason: stringValue(form.get('humanReviewNotes')),
        user,
      }),
  );
}

/**
 * The triage right-swipe: record the `maybe` verdict and queue the deep dive
 * (opportunity intelligence, one posting preflight, a company-research task) in
 * the same request, as the signed-in owner.
 *
 * Triage is a queue for deciding what deserves a deeper look, so there is no
 * apply here: the verdict is always `maybe`, and applying happens from the
 * shortlist or the record page. A failed queue step is reported in `steps`
 * (and `failed`); it never unseats the verdict.
 */
export async function digDeeperOpportunityAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const form = await request.formData();
  const notes = form.get('humanReviewNotes');
  const rating = form.get('humanRating');
  return await runOwnerMutation(
    locals,
    'digDeeperOpportunity',
    opportunityDigDeeperOperations,
    async (user) => {
      const { digDeeperOnOpportunity } = await import(
        './opportunity-deep-dive.js'
      );
      return await digDeeperOnOpportunity({
        // `null` means the form omitted the field; only a present field may
        // overwrite the notes or rating the opportunity already carries.
        humanRating: rating === null ? undefined : stringValue(rating),
        humanReviewNotes: notes === null ? undefined : stringValue(notes),
        opportunityId: stringValue(form.get('opportunityId')),
        reviewedByProfileId: stringValue(form.get('reviewedByProfileId')),
        user,
      });
    },
  );
}

/**
 * Run one bounded live-posting preflight and record its verdict, as the
 * signed-in owner. Same audited writer as the `job_search_verify_posting`
 * tool: it records evidence and never archives, overrides, or submits.
 */
export async function verifyOpportunityPostingAction(
  request: Request,
  locals: OwnerPrincipalLocals,
) {
  const form = await request.formData();
  const opportunityId = stringValue(form.get('opportunityId'));
  return await runOwnerMutation(
    locals,
    'verifyOpportunityPosting',
    postingPreflightOperations,
    async (user) => {
      if (!user?.id) error(403, 'Forbidden');
      const { verifyJobPosting } = await import('./job-search-webmcp.js');
      return await verifyJobPosting({ opportunityId }, user);
    },
  );
}

/**
 * The triage deck's queue read (issue #425).
 *
 * The deck is a modal over this list, not a route of its own, so it has no page
 * load: it posts the list's own filter parameters here and gets one window of
 * the queue back. The read is `loadTriageQueue` verbatim — the same preset the
 * agent-facing `job_search_next_triage_candidate` reads — so the deck, the
 * list, and the agent can never disagree about what is decidable.
 */
export async function triageQueueAction(request: Request) {
  const form = await request.formData();
  const { loadTriageQueue, triageFiltersFromSearchParams, TRIAGE_QUEUE_SIZE } =
    await import('./opportunity-triage.js');
  const params = new URLSearchParams(stringValue(form.get('search')));
  const filters = triageFiltersFromSearchParams(params);
  const limit = Number(stringValue(form.get('limit')));
  const offset = Number(stringValue(form.get('offset')));
  const queue = await loadTriageQueue({
    candidateSkills: candidateSkillSlugs(),
    filters,
    limit:
      Number.isFinite(limit) && limit > 0
        ? Math.min(Math.trunc(limit), TRIAGE_QUEUE_SIZE)
        : TRIAGE_QUEUE_SIZE,
    offset: Number.isFinite(offset) ? offset : 0,
    search: params.get('q') ?? undefined,
  });

  // The preflight verdict is the one decision input the opportunity row does
  // not carry: it lives in the `posting_preflight` audit trail. Read it for the
  // window in hand — bounded by the queue size — so the card can show whether
  // the posting was ever checked before committing to a deeper look.
  const preflights = Object.fromEntries(
    await Promise.all(
      queue.candidates.map(async (record) => {
        const id = typeof record.id === 'string' ? record.id : '';
        return [id, await latestPostingPreflightStatus(id)] as const;
      }),
    ),
  );

  return {
    candidates: queue.candidates,
    offset: queue.offset,
    preflights,
    total: queue.total,
  };
}

export async function researchCompanyAction(request: Request) {
  const form = await request.formData();
  const companyId = stringValue(form.get('companyId'));
  if (!companyId) {
    return { message: 'No company id provided.', status: 'error' };
  }
  const result = await ensureCompanyResearch({
    companyId,
    createdBy: 'owner',
    reason: stringValue(form.get('reason')),
  });
  if (!result.researchTaskId) {
    return { message: 'Company not found.', status: 'error' };
  }
  const sourceNote = result.careersSourceCreated
    ? ' Added the careers page as a source.'
    : result.careersSourceId
      ? ' Careers page already tracked as a source.'
      : ' No careers URL on file yet — research will find and add one.';
  return {
    message: `Company research queued.${sourceNote}`,
    status: 'queued',
  };
}

export async function acceptFactCandidateAction(
  request: Request,
  user: AdminActor,
) {
  const form = await request.formData();
  return await acceptFactCandidate({
    candidateId: stringValue(form.get('candidateId')),
    reviewedByProfileId: stringValue(form.get('reviewedByProfileId')),
    user,
  });
}
