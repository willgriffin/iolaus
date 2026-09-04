import type {
  WebMcpRegistrationDefinition,
  WebMcpToolDefinition,
} from '@happyvertical/smrt-web';
import {
  type JobSearchToolName,
  jobSearchToolContracts,
} from './job-search-tool-schemas';

const COMMAND_CENTER_PATH = '/admin';
const COMMAND_CENTER_COLLECTIONS = new Set(['opportunities']);
// Raised deliberately with each application-owned tool: the sweep (#427) took
// this to 15, the triage pair (#425) took it to 17, and the explicit
// provider-root creation action (#23) takes it to 18. Every increment widens
// the browser-native surface, so it is never a silent bump.
const COMMAND_CENTER_MAX_TOOLS = 18;
const COMMAND_CENTER_EFFECTS = ['read', 'write'] as const;
const JOB_SEARCH_COLLECTION = 'job-search';
const JOB_SEARCH_ENDPOINT = '/job-search';
const JOB_SEARCH_RELATIONSHIPS = [
  {
    field: 'opportunityId',
    kind: 'foreignKey' as const,
    relatedCollection: 'opportunities',
  },
  {
    field: 'applicationId',
    kind: 'foreignKey' as const,
    relatedCollection: 'applications',
  },
  {
    field: 'taskId',
    kind: 'foreignKey' as const,
    relatedCollection: 'tasks',
  },
] as const;

function jobSearchTool(
  definition: Pick<
    WebMcpToolDefinition,
    | 'action'
    | 'description'
    | 'effect'
    | 'idempotent'
    | 'openWorld'
    | 'readOnly'
  > & { name: JobSearchToolName; path: [string] },
): WebMcpToolDefinition {
  const { path, ...rest } = definition;
  const contract = jobSearchToolContracts[definition.name];
  return {
    ...rest,
    className: 'Opportunity',
    collection: JOB_SEARCH_COLLECTION,
    endpoint: JOB_SEARCH_ENDPOINT,
    idField: 'id',
    idType: 'uuid',
    // The same schema object the API route validates arguments against.
    inputSchema: contract.inputSchema,
    objectRef: '@willgriffin/iolaus-site:Opportunity',
    relationships: [...JOB_SEARCH_RELATIONSHIPS],
    route: { method: contract.method, scope: 'collection', path },
  };
}

/**
 * Application-owned job-search tools. These deliberately sit beside generated
 * SMRT definitions: they keep the browser contract narrow while their API
 * handlers reuse the authenticated application workflow instead of exposing
 * generic writes.
 */
export const jobSearchWebMcpToolDefinitions = [
  jobSearchTool({
    action: 'create-source',
    name: 'job_search_create_source',
    description:
      'Create and configure one explicit local root source from a public HTTPS provider URL. The source may be marked active for a later crawl, but this action never schedules or contacts the provider.',
    effect: 'write',
    idempotent: false,
    openWorld: true,
    readOnly: false,
    path: ['create-source'],
  }),
  jobSearchTool({
    action: 'source-health',
    name: 'job_search_list_source_health',
    description:
      'List explicitly classified root sources and rank provider health from bounded durable terminal crawl accounting. Credentials and posting-derived sources are excluded.',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    readOnly: true,
    path: ['source-health'],
  }),
  jobSearchTool({
    action: 'source-crawl-status',
    name: 'job_search_source_crawl_status',
    description:
      'Inspect one crawl or a bounded recent set for one explicit source. Returns durable counts and capped sanitized errors only.',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    readOnly: true,
    path: ['source-crawl-status'],
  }),
  jobSearchTool({
    action: 'set-source-active',
    name: 'job_search_set_source_active',
    description:
      'Activate or deactivate one explicit, durably classified root source and synchronize its schedule. Posting-derived and unknown sources are refused.',
    effect: 'write',
    idempotent: true,
    openWorld: false,
    readOnly: false,
    path: ['set-source-active'],
  }),
  jobSearchTool({
    action: 'crawl-source',
    name: 'job_search_crawl_source',
    description:
      'Queue one bounded crawl for one explicit root source. Requires a caller idempotency key and returns stable job and crawl identifiers; there is no crawl-all mode.',
    effect: 'write',
    idempotent: true,
    openWorld: true,
    readOnly: false,
    path: ['crawl-source'],
  }),
  jobSearchTool({
    action: 'browse',
    name: 'job_search_browse_opportunities',
    description:
      'Browse and search local job opportunities with bounded filters. Archived opportunities are excluded from the results and the total unless the status filter names them, so a default total is not the size of the table. Returns concise decision context and local admin links; it never contacts an employer.',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    readOnly: true,
    path: ['browse'],
  }),
  jobSearchTool({
    action: 'next-triage-candidate',
    name: 'job_search_next_triage_candidate',
    description:
      'Return the single highest-scoring undecided local opportunity for one-at-a-time triage, with its queue position and how many remain. Archived, expired, and no-longer-seen postings are excluded. Read-only: record the verdict with job_search_record_decision, or raise offset to pass on a candidate.',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    readOnly: true,
    path: ['next-triage-candidate'],
  }),
  jobSearchTool({
    action: 'inspect',
    name: 'job_search_inspect_opportunity',
    description:
      'Inspect one local opportunity with curated posting, fit, company, score, application, and next-step context. Sensitive candidate profile fields are not returned.',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    readOnly: true,
    path: ['inspect'],
  }),
  jobSearchTool({
    action: 'verify-posting',
    name: 'job_search_verify_posting',
    description:
      'Run one bounded live-posting preflight for one local opportunity and record the verdict (live, closed, or inconclusive) with its evidence reference. It fetches only the known ATS posting URL without credentials, never archives the opportunity, never overrides an inconclusive result, and never submits anything.',
    effect: 'write',
    idempotent: false,
    openWorld: true,
    readOnly: false,
    path: ['verify-posting'],
  }),
  jobSearchTool({
    action: 'sweep',
    name: 'job_search_sweep_opportunities',
    description:
      'Archive local opportunities whose source is inactive and whose posting has not been seen for the given number of days (default 30), restricted to undecided found and recommended rows. Dry run by default: it reports the matching count and a bounded sample and writes nothing unless dryRun is false. Applying records one audit run, never deletes a row, and never touches an opportunity carrying a decision or application.',
    effect: 'write',
    // Not idempotent: every apply records a fresh audit run, and the cutoff
    // moves with wall-clock time, so a repeat of the same arguments archives
    // whatever has aged past the boundary since. `job_search_verify_posting`
    // is declared the same way for the same reason.
    idempotent: false,
    openWorld: false,
    readOnly: false,
    path: ['sweep'],
  }),
  jobSearchTool({
    action: 'inspect-application',
    name: 'job_search_inspect_application',
    description:
      'Inspect one local application: material inventory with review state, unresolved review comments, answers committed to this packet, blocking items with reasons, approval scope and timestamps, and submission evidence. Read-only; approval cannot be recorded here. Candidate profile contact facts, the reusable answer library, employer-account identities, and material bodies are not returned.',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    readOnly: true,
    path: ['inspect-application'],
  }),
  jobSearchTool({
    action: 'read-resume',
    name: 'job_search_read_resume',
    description:
      'Read the published resume as the tailoring pipeline structures it: summary, skill groups, experience with projects and bullets, other experience, and education. Optionally select a stored tailoring config by slug and a candidate profile by key; the canonical resume for the default profile is returned otherwise, and the response lists the selectable profiles. Email, phone, location, work-authorization preference, profile links, attachments, and the candidate answer library are never returned.',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    readOnly: true,
    path: ['read-resume'],
  }),
  jobSearchTool({
    action: 'import',
    name: 'job_search_import_opportunity',
    description:
      'Import a public HTTPS job-posting URL into the local opportunity workflow. Reuses an existing URL match, optionally refreshes supported posting details, and never applies externally.',
    effect: 'write',
    idempotent: false,
    openWorld: true,
    readOnly: false,
    path: ['import'],
  }),
  jobSearchTool({
    action: 'dig-deeper',
    name: 'job_search_dig_deeper',
    description:
      'Mark one local opportunity as worth a deeper look: records the maybe verdict and queues the deep dive — opportunity intelligence, one bounded posting check, and the company research task. Not idempotent: each call records another review write and another posting check. It never starts or submits an application.',
    effect: 'write',
    idempotent: false,
    openWorld: true,
    readOnly: false,
    path: ['dig-deeper'],
  }),
  jobSearchTool({
    action: 'record-decision',
    name: 'job_search_record_decision',
    description:
      'Record an explicit Apply, Maybe, or Reject decision through the existing audited workflow. Apply may create the local application, preparation tasks, and invoke configured AI planning; it never contacts or submits to an employer.',
    effect: 'write',
    idempotent: false,
    openWorld: true,
    readOnly: false,
    path: ['record-decision'],
  }),
  jobSearchTool({
    action: 'open-application',
    name: 'job_search_open_application',
    description:
      'Find the existing local application workspace for an opportunity or create it through an explicit Apply decision and the normal preparation workflow. Creation may invoke configured AI planning; it returns a local admin link and never contacts or submits to an employer.',
    effect: 'write',
    idempotent: false,
    openWorld: true,
    readOnly: false,
    path: ['open-application'],
  }),
] as const satisfies readonly WebMcpToolDefinition[];

const JOB_SEARCH_DEFINITION_ALLOWLIST = new Set<WebMcpRegistrationDefinition>(
  jobSearchWebMcpToolDefinitions,
);

function isCommandCenterDefinition(
  definition: WebMcpRegistrationDefinition,
): boolean {
  if (!('collection' in definition)) return false;
  if (definition.collection === JOB_SEARCH_COLLECTION) {
    return JOB_SEARCH_DEFINITION_ALLOWLIST.has(definition);
  }
  return (
    COMMAND_CENTER_COLLECTIONS.has(definition.collection) &&
    'effect' in definition &&
    definition.effect === 'read'
  );
}

/**
 * The command-center subset of a definition list: generated `opportunities`
 * reads plus the application-owned `job_search_*` tools. Shared with the
 * server-side owner principal so the browser surface and the execution
 * allow-list are derived from the same policy.
 */
export function commandCenterWebMcpDefinitions(
  definitions: readonly WebMcpRegistrationDefinition[],
): WebMcpRegistrationDefinition[] {
  return definitions.filter(isCommandCenterDefinition);
}

/**
 * Keep browser-native tools on the authenticated job-seeker command center.
 * The Provider still performs the actual feature detection and registration;
 * this makes its page and effect policy testable without a personal browser
 * session.
 */
export function commandCenterWebMcpConfig(
  definitions: readonly WebMcpRegistrationDefinition[],
  pathname: string,
  documentRef: object | undefined = globalThis.document,
) {
  if (
    !(
      pathname === COMMAND_CENTER_PATH ||
      pathname.startsWith(`${COMMAND_CENTER_PATH}/`)
    ) ||
    !documentRef ||
    !('modelContext' in documentRef)
  ) {
    return false;
  }

  return {
    definitions: commandCenterWebMcpDefinitions(definitions),
    basePath: '/api',
    effects: COMMAND_CENTER_EFFECTS,
    maxTools: COMMAND_CENTER_MAX_TOOLS,
  };
}
