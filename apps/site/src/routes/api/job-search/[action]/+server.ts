import { error, json, type RequestHandler } from '@sveltejs/kit';
import { jobSearchToolContracts } from '$lib/job-search-tool-schemas';
import { inspectJobApplication } from '$lib/server/application-inspect-webmcp';
import {
  browseJobOpportunities,
  digDeeperOnJobOpportunity,
  importJobOpportunity,
  inspectJobOpportunity,
  nextJobTriageCandidate,
  openJobApplication,
  recordJobOpportunityDecision,
  sweepJobOpportunities,
  verifyJobPosting,
} from '$lib/server/job-search-webmcp';
import {
  isOwnerAuthorityDenial,
  type PrincipalRun,
  runAsOwner,
} from '$lib/server/owner-principal';
import {
  LEGACY_RESUME_READ_PLAN,
  NORMALIZED_RESUME_READ_PLAN,
} from '$lib/server/resume-read-plans';
import { readJobSearchResume } from '$lib/server/resume-webmcp';
import {
  enqueueRootSourceCrawl,
  listRootSourceHealth,
  listSourceCrawlStatus,
  setRootSourceActive,
} from '$lib/server/source-webmcp';
import {
  type ToolArgumentSource,
  validateToolArguments,
} from '$lib/server/tool-arguments';
import {
  agentRunAuditOperations,
  opportunityDigDeeperOperations,
  opportunitySweepOperations,
  postingPreflightOperations,
} from '$lib/server/workflow-operations';

function unauthorized(): Response {
  return json({ error: 'Unauthorized' }, { status: 401 });
}

function forbidden(): Response {
  return json({ error: 'Forbidden' }, { status: 403 });
}

type Collection =
  | 'agentruns'
  | 'applicationmaterialcomments'
  | 'applications'
  | 'companies'
  | 'decisions'
  | 'evaluationscores'
  | 'opportunities'
  | 'resumeassets'
  | 'resumetailoringconfigs'
  | 'sourcecrawls'
  | 'sourcecrawlitems'
  | 'sources'
  | 'tasks'
  | ResumeReadCollection;

/**
 * Generated collection slug for a resume read-plan class. Every class in the
 * plans is app-owned except `Tag` (`@happyvertical/smrt-tags`), and every slug
 * is the lower-cased plural the manifest publishes.
 */
const resumeReadCollections = [
  'achievements',
  'achievementattachments',
  'achievementtags',
  'attachments',
  'candidateprofilelinks',
  'candidateprofiles',
  'companies',
  'companyattachments',
  'duties',
  'dutytags',
  'educations',
  'educationtags',
  'employmentroles',
  'employmentroletags',
  'experiencecompanies',
  'experienceroles',
  'experiences',
  'experiencetags',
  'projectattachments',
  'projects',
  'projecttags',
  'resumeachievements',
  'resumeeducations',
  'resumelinks',
  'resumeotherroles',
  'resumepositions',
  'resumeprofiles',
  'resumeskillcategories',
  'resumeskillgroups',
  'resumeskills',
  'skillcategories',
  'skillcategorymembers',
  'skillgroupmembers',
  'skillgroups',
  'tags',
] as const;
type ResumeReadCollection = (typeof resumeReadCollections)[number];

/** Read-plan class → collection slug, so a plan change fails the route spec. */
const resumeReadPlanCollections = new Map<string, ResumeReadCollection>([
  ['Achievement', 'achievements'],
  ['AchievementAttachment', 'achievementattachments'],
  ['AchievementTag', 'achievementtags'],
  ['Attachment', 'attachments'],
  ['CandidateProfile', 'candidateprofiles'],
  ['CandidateProfileLink', 'candidateprofilelinks'],
  ['Company', 'companies'],
  ['CompanyAttachment', 'companyattachments'],
  ['Duty', 'duties'],
  ['DutyTag', 'dutytags'],
  ['Education', 'educations'],
  ['EducationTag', 'educationtags'],
  ['EmploymentRole', 'employmentroles'],
  ['EmploymentRoleTag', 'employmentroletags'],
  ['Experience', 'experiences'],
  ['ExperienceCompany', 'experiencecompanies'],
  ['ExperienceRole', 'experienceroles'],
  ['ExperienceTag', 'experiencetags'],
  ['Project', 'projects'],
  ['ProjectAttachment', 'projectattachments'],
  ['ProjectTag', 'projecttags'],
  ['ResumeAchievement', 'resumeachievements'],
  ['ResumeEducation', 'resumeeducations'],
  ['ResumeLink', 'resumelinks'],
  ['ResumeOtherRole', 'resumeotherroles'],
  ['ResumePosition', 'resumepositions'],
  ['ResumeProfile', 'resumeprofiles'],
  ['ResumeSkill', 'resumeskills'],
  ['ResumeSkillCategory', 'resumeskillcategories'],
  ['ResumeSkillGroup', 'resumeskillgroups'],
  ['SkillCategory', 'skillcategories'],
  ['SkillCategoryMember', 'skillcategorymembers'],
  ['SkillGroup', 'skillgroups'],
  ['SkillGroupMember', 'skillgroupmembers'],
  ['Tag', 'tags'],
]);

function resumeReadPlanClassNames(): string[] {
  const names = new Set<string>();
  for (const plan of [NORMALIZED_RESUME_READ_PLAN, LEGACY_RESUME_READ_PLAN]) {
    for (const [className] of Object.values(plan)) names.add(className);
  }
  return [...names].sort();
}

interface RequiredOperation {
  action: 'create' | 'delete' | 'read' | 'update';
  collection: Collection;
}

const contextReadOperations = [
  { action: 'read', collection: 'applications' },
  { action: 'read', collection: 'companies' },
  { action: 'read', collection: 'evaluationscores' },
  { action: 'read', collection: 'opportunities' },
] satisfies RequiredOperation[];

const sourceReadOperations = [
  { action: 'read', collection: 'sources' },
  { action: 'read', collection: 'sourcecrawls' },
] satisfies RequiredOperation[];

/** Inspect adds the recorded posting-preflight verdict from the audit log. */
const inspectReadOperations = [
  ...contextReadOperations,
  ...agentRunAuditOperations,
] satisfies RequiredOperation[];

/**
 * `AgentRun` is system-authored (no generated create permission exists), so
 * every mutation below that records an audit run — the posting verification,
 * the source activation and crawl-enqueue audits, the import audit, and the
 * posting preflight the Apply paths run — asserts `agentRunAuditOperations`
 * (`workflow-operations.ts`): the owner's right to read the audit log.
 */
const verifyPostingOperations = [
  ...postingPreflightOperations,
] satisfies RequiredOperation[];

/**
 * Dig deeper records the `maybe` review, then queues the intelligence job, one
 * posting preflight, and the company's research task. The whole set is asserted
 * before the verdict is written, so a principal that may review but not queue
 * the follow-up is refused rather than left with half a deep dive.
 */
const digDeeperOperations = [
  ...opportunityDigDeeperOperations,
] satisfies RequiredOperation[];

/**
 * The inactive-source sweep reads its matched set — including the applications
 * and owner decisions that exclude an already-decided posting — and, on apply,
 * batch-updates those rows and records one audit run. The write authority is
 * asserted for the dry run too, so a principal that cannot archive never
 * receives a count.
 */
const sweepOpportunitiesOperations = [
  ...opportunitySweepOperations,
] satisfies RequiredOperation[];

const inspectApplicationOperations = [
  { action: 'read', collection: 'applications' },
  { action: 'read', collection: 'applicationmaterialcomments' },
  ...agentRunAuditOperations,
  { action: 'read', collection: 'opportunities' },
  { action: 'read', collection: 'resumeassets' },
  { action: 'read', collection: 'tasks' },
] satisfies RequiredOperation[];

/**
 * The published resume is assembled from every read-plan collection (the
 * normalized plan plus the legacy fallback), and the tailoring selection reads
 * stored configs. `CandidateProfile` is read for name/title/summary only; the
 * response never carries its contact facts.
 */
const readResumeOperations = [
  ...resumeReadPlanClassNames().map((className) => {
    const collection = resumeReadPlanCollections.get(className);
    if (!collection) {
      throw new Error(`Unmapped resume read-plan class: ${className}`);
    }
    return { action: 'read', collection } satisfies RequiredOperation;
  }),
  { action: 'read', collection: 'resumetailoringconfigs' },
] satisfies RequiredOperation[];

/** Records a `webmcp_source_crawl_enqueue` audit run inside the transaction. */
const crawlSourceOperations = [
  ...agentRunAuditOperations,
  { action: 'read', collection: 'sources' },
  { action: 'create', collection: 'sources' },
  { action: 'update', collection: 'sources' },
  { action: 'read', collection: 'sourcecrawls' },
  { action: 'read', collection: 'sourcecrawlitems' },
  { action: 'read', collection: 'opportunities' },
  { action: 'create', collection: 'opportunities' },
  { action: 'update', collection: 'opportunities' },
  { action: 'read', collection: 'companies' },
  { action: 'create', collection: 'companies' },
  { action: 'update', collection: 'companies' },
  { action: 'read', collection: 'tasks' },
  { action: 'create', collection: 'tasks' },
  { action: 'update', collection: 'tasks' },
  { action: 'read', collection: 'evaluationscores' },
  { action: 'create', collection: 'evaluationscores' },
  { action: 'update', collection: 'evaluationscores' },
] satisfies RequiredOperation[];

/** Route action → the WebMCP tool name it executes. */
const toolNames = {
  browse: 'job_search_browse_opportunities',
  'crawl-source': 'job_search_crawl_source',
  'dig-deeper': 'job_search_dig_deeper',
  import: 'job_search_import_opportunity',
  inspect: 'job_search_inspect_opportunity',
  'next-triage-candidate': 'job_search_next_triage_candidate',
  'inspect-application': 'job_search_inspect_application',
  'open-application': 'job_search_open_application',
  'read-resume': 'job_search_read_resume',
  'record-decision': 'job_search_record_decision',
  'set-source-active': 'job_search_set_source_active',
  'source-crawl-status': 'job_search_source_crawl_status',
  'source-health': 'job_search_list_source_health',
  sweep: 'job_search_sweep_opportunities',
  'verify-posting': 'job_search_verify_posting',
} as const;

type ToolAction = keyof typeof toolNames;

function isToolAction(action: string | undefined): action is ToolAction {
  return typeof action === 'string' && Object.hasOwn(toolNames, action);
}

/**
 * Execute one WebMCP tool as the signed-in owner. Every generated operation
 * the tool's curated response and workflow side effects need is asserted
 * against the principal's published permission snapshot before the handler
 * reads or mutates data.
 */
async function executeAsOwnerTool(
  locals: App.Locals,
  action: ToolAction,
  operations: RequiredOperation[],
  handler: (run: PrincipalRun) => Promise<unknown>,
): Promise<Response> {
  const tool = toolNames[action];
  try {
    const result = await runAsOwner(
      locals,
      async (run) => {
        run.assertToolAllowed(tool);
        for (const { action: operation, collection } of operations) {
          await run.assertOperation(collection, operation);
        }
        return await handler(run);
      },
      { action: `webmcp.${tool}`, auditMetadata: { tool } },
    );
    return json(result);
  } catch (cause) {
    if (isOwnerAuthorityDenial(cause)) return forbidden();
    throw cause;
  }
}

/**
 * Enforce the tool's published `inputSchema` before any handler runs, so a
 * wrong argument name or type is named precisely instead of surfacing as an
 * opaque `HTTP 400`. Runs only after authentication; authority denials keep
 * their non-descriptive bodies. Returns `undefined` when the arguments are
 * acceptable.
 */
function rejectInvalidArguments(
  action: ToolAction,
  input: Record<string, unknown>,
  source: ToolArgumentSource,
): Response | undefined {
  const tool = toolNames[action];
  const validation = validateToolArguments(
    tool,
    jobSearchToolContracts[tool].inputSchema,
    input,
    source,
  );
  if (validation.ok) return undefined;
  return json(
    { error: validation.error, details: validation.details },
    { status: 400 },
  );
}

function methodOf(action: ToolAction): 'GET' | 'POST' {
  return jobSearchToolContracts[toolNames[action]].method;
}

function unsupported(action: string, method: string): Response {
  return json(
    {
      error: `Unsupported job-search action: ${method} ${action || '(missing)'}`,
    },
    { status: 404 },
  );
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    error(400, 'Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    error(400, 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function decisionForAuthorization(
  value: unknown,
): 'apply' | 'maybe' | 'reject' {
  const decision = typeof value === 'string' ? value.trim() : '';
  if (decision !== 'apply' && decision !== 'maybe' && decision !== 'reject') {
    error(400, 'Invalid decision.');
  }
  return decision;
}

export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) return unauthorized();
  const input = Object.fromEntries(url.searchParams.entries());
  const action = params.action;
  if (!isToolAction(action) || methodOf(action) !== 'GET') {
    return unsupported(action ?? '', 'GET');
  }
  const rejection = rejectInvalidArguments(action, input, 'query');
  if (rejection) return rejection;
  if (action === 'browse') {
    return await executeAsOwnerTool(locals, action, contextReadOperations, () =>
      browseJobOpportunities(input),
    );
  }
  if (action === 'next-triage-candidate') {
    return await executeAsOwnerTool(locals, action, contextReadOperations, () =>
      nextJobTriageCandidate(input),
    );
  }
  if (action === 'inspect') {
    return await executeAsOwnerTool(locals, action, inspectReadOperations, () =>
      inspectJobOpportunity(input),
    );
  }
  if (action === 'inspect-application') {
    return await executeAsOwnerTool(
      locals,
      action,
      inspectApplicationOperations,
      () => inspectJobApplication(input),
    );
  }
  if (action === 'read-resume') {
    return await executeAsOwnerTool(locals, action, readResumeOperations, () =>
      readJobSearchResume(input),
    );
  }
  if (action === 'source-health') {
    return await executeAsOwnerTool(locals, action, sourceReadOperations, () =>
      listRootSourceHealth(input),
    );
  }
  if (action === 'source-crawl-status') {
    return await executeAsOwnerTool(locals, action, sourceReadOperations, () =>
      listSourceCrawlStatus(input),
    );
  }
  return unsupported(action, 'GET');
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const user = locals.user;
  if (!user) return unauthorized();
  const input = await jsonObject(request);
  const action = params.action;
  if (!isToolAction(action) || methodOf(action) !== 'POST') {
    return unsupported(action ?? '', 'POST');
  }
  const rejection = rejectInvalidArguments(action, input, 'body');
  if (rejection) return rejection;
  if (action === 'set-source-active') {
    return await executeAsOwnerTool(
      locals,
      action,
      // Records a `webmcp_source_activation` audit run inside the transaction.
      [
        ...agentRunAuditOperations,
        { action: 'read', collection: 'sources' },
        { action: 'update', collection: 'sources' },
      ],
      () => setRootSourceActive(input, user),
    );
  }
  if (action === 'crawl-source') {
    return await executeAsOwnerTool(locals, action, crawlSourceOperations, () =>
      enqueueRootSourceCrawl(input, user),
    );
  }
  if (action === 'verify-posting') {
    return await executeAsOwnerTool(
      locals,
      action,
      verifyPostingOperations,
      () => verifyJobPosting(input, user),
    );
  }
  if (action === 'sweep') {
    return await executeAsOwnerTool(
      locals,
      action,
      sweepOpportunitiesOperations,
      () => sweepJobOpportunities(input, user),
    );
  }
  if (action === 'import') {
    return await executeAsOwnerTool(
      locals,
      action,
      // Records a `webmcp_import_opportunity` audit run on success and failure.
      [
        ...contextReadOperations,
        ...agentRunAuditOperations,
        { action: 'create', collection: 'opportunities' },
        { action: 'delete', collection: 'opportunities' },
        { action: 'update', collection: 'opportunities' },
      ],
      () => importJobOpportunity(input, user),
    );
  }
  if (action === 'dig-deeper') {
    return await executeAsOwnerTool(locals, action, digDeeperOperations, () =>
      digDeeperOnJobOpportunity(input, user),
    );
  }
  if (action === 'record-decision') {
    const decision = decisionForAuthorization(input.decision);
    return await executeAsOwnerTool(
      locals,
      action,
      [
        ...contextReadOperations,
        { action: 'create', collection: 'decisions' },
        { action: 'read', collection: 'decisions' },
        { action: 'create', collection: 'tasks' },
        { action: 'read', collection: 'tasks' },
        { action: 'update', collection: 'opportunities' },
        { action: 'update', collection: 'tasks' },
        // Apply runs the posting preflight, which records its verdict (and
        // any owner override) as an `AgentRun` before the application opens.
        ...(decision === 'apply'
          ? ([
              ...agentRunAuditOperations,
              { action: 'create', collection: 'applications' },
              { action: 'update', collection: 'applications' },
              { action: 'update', collection: 'companies' },
              { action: 'create', collection: 'sources' },
              { action: 'read', collection: 'sources' },
            ] satisfies RequiredOperation[])
          : []),
      ],
      () => recordJobOpportunityDecision(input, user),
    );
  }
  if (action === 'open-application') {
    return await executeAsOwnerTool(
      locals,
      action,
      // Opening records an Apply decision, so the posting preflight and its
      // `AgentRun` verdict run whenever no application exists yet.
      [
        ...contextReadOperations,
        ...agentRunAuditOperations,
        { action: 'create', collection: 'applications' },
        { action: 'create', collection: 'decisions' },
        { action: 'read', collection: 'decisions' },
        { action: 'create', collection: 'tasks' },
        { action: 'read', collection: 'tasks' },
        { action: 'update', collection: 'applications' },
        { action: 'update', collection: 'companies' },
        { action: 'update', collection: 'opportunities' },
        { action: 'create', collection: 'sources' },
        { action: 'read', collection: 'sources' },
        { action: 'update', collection: 'tasks' },
      ],
      () => openJobApplication(input, user),
    );
  }
  return unsupported(action, 'POST');
};
