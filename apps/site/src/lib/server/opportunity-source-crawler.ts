import { randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  getSpider,
  type Link,
  type SpiderAdapter,
  type SpiderAdapterOptions,
} from '@happyvertical/spider';
import {
  type AdapterContext,
  AdapterRegistry,
  type AdapterSource,
  createAdapterContext,
  type DetectionResult,
  filterLinks,
  type PlatformAdapter,
} from '@happyvertical/spider/platform';
import {
  getConfiguredUserAgent,
  getSafeOutboundHeaderValue,
} from './app-config.js';
import {
  cancelStaleOpportunityIntelligenceTasks,
  syncRecommendedOpportunityDecisionTasks,
} from './application-workflow.js';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import { getDbConfig } from './db.js';
import {
  type BoardReconciliationCounts,
  reconcileSourceBoard,
} from './opportunity-board-reconciliation.js';
import {
  applyResolvedOpportunityDetails,
  htmlToPlainText,
  type OpportunityDetailResult,
  qualificationsFromDescription,
  resolveOpportunityDetails,
} from './opportunity-details.js';
import {
  resolveOpportunityIntelligenceBudgetConfig,
  resolveOpportunityIntelligenceEnqueueCap,
} from './opportunity-intelligence-config.js';
import {
  enqueueOpportunityIntelligenceWithStatus,
  findActiveOpportunityIntelligenceJob,
  type OpportunityIntelligenceEnqueueResult,
  type OpportunityIntelligenceJobArgs,
} from './opportunity-intelligence-job.js';
import {
  fingerprintOpportunitySourceContent,
  OPPORTUNITY_SOURCE_CONTENT_FINGERPRINT_VERSION,
  type OpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';
import { getCollection } from './smrt.js';
import {
  createSourceCrawlAttempt,
  finalizeSourceCrawlAttempt,
  persistCreatedSourceCrawlAttempt,
  prepareSourceCrawlAttempt,
  reconcileSourceCrawlAccounting,
  recordSourceCrawlAttemptPersistenceIntent,
  recordSourceCrawlAttemptTerminalIntent,
  recoverSourceCrawlAttempt,
  type SourceCrawlAccounting,
  type SourceCrawlTerminalOutcome,
} from './source-crawl-accounting.js';
import {
  completeSourceCrawl,
  failSourceCrawl,
} from './source-crawl-watchdog.js';
import { assertActiveOperableRootSource } from './source-provenance.js';
import {
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_METHOD,
  SOURCE_CRAWL_QUEUE,
  SOURCE_JOB_OBJECT_TYPE,
} from './source-schedules.js';
import { withSqliteOperationLock } from './sqlite-operation-lock.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};
type ListableCollection = {
  list: (options: {
    limit: number;
    offset?: number;
    where?: Record<string, unknown>;
  }) => Promise<unknown[]>;
};
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface SourceCrawlAccountingWriter {
  createAttempt: (input: {
    attemptKey: string;
    candidate: OpportunitySourceCandidate;
    sourceCrawlId: string;
  }) => Promise<MutableRecord | null>;
  prepareAttempt: (input: {
    attemptKey: string;
    candidate: OpportunitySourceCandidate;
    detail: Extract<OpportunityDetailResult, { status: 'resolved' }>;
    sourceCrawlId: string;
  }) => Promise<MutableRecord | null>;
  recordPersistenceIntent: (input: {
    attemptKey: string;
    intent: 'created' | 'relisted' | 'reused';
    opportunityId: string;
    sourceCrawlId: string;
  }) => Promise<MutableRecord | null>;
  recordTerminalIntent?: (input: {
    attemptKey: string;
    outcome: 'duplicate' | 'skipped';
    sourceCrawlId: string;
    status: string;
  }) => Promise<MutableRecord | null>;
  persistCreatedOpportunity?: (input: {
    attemptKey: string;
    canonicalUrl?: string;
    companyName?: string;
    contentFingerprint: string;
    contentVersion: number;
    externalId?: string;
    opportunityId: string;
    persist: (database: unknown) => Promise<MutableRecord>;
    postingUrl?: string;
    rawJson?: string;
    sourceCrawlId: string;
    status: string;
    title?: string;
  }) => Promise<MutableRecord>;
  recoverAttempt: (input: {
    attemptKey: string;
    sourceCrawlId: string;
  }) => Promise<SourceCrawlTerminalOutcome | null>;
  finalizeAttempt: (input: {
    attemptKey: string;
    canonicalUrl?: string;
    companyName?: string;
    contentFingerprint?: string;
    contentVersion?: number;
    externalId?: string;
    opportunityId?: string;
    outcome: SourceCrawlTerminalOutcome;
    postingUrl?: string;
    rawJson?: string;
    reason?: string;
    sourceCrawlId: string;
    status: string;
    title?: string;
  }) => Promise<MutableRecord | null>;
  reconcile: (
    sourceCrawlId: string,
    options?: { requireTerminal?: boolean },
  ) => Promise<SourceCrawlAccounting>;
  durable?: boolean;
}

export class SourceCrawlOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceCrawlOwnershipError';
  }
}

function exactNonblankBinding(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    ? value
    : '';
}

function sourceCrawlerUserAgent(): string {
  return getConfiguredUserAgent('source crawler');
}

function browserSourceCrawlerUserAgent(): string {
  return `Mozilla/5.0 (compatible; ${sourceCrawlerUserAgent()}; )`;
}

export interface SourceLike {
  id?: unknown;
  isActive?: unknown;
  name?: unknown;
  parentSourceId?: unknown;
  searchQuery?: unknown;
  sourceRole?: unknown;
  type?: unknown;
  url?: unknown;
}

export interface OpportunitySourceCandidate {
  aliasKind?: 'direct' | 'relist' | 'alternate_url';
  canonicalUrl?: string;
  companyCareersUrl?: string;
  companyLinkedinUrl?: string;
  companyName?: string;
  companyWebsiteUrl?: string;
  /**
   * Provider-scoped, non-sensitive context for bounded crawl diagnostics.
   * This is deliberately transient and is never persisted as opportunity data.
   */
  diagnosticContext?: string;
  discoveredUrl?: string;
  employmentType?: string;
  externalId?: string;
  locationNotes?: string;
  postedAt?: Date | null;
  postingUrl: string;
  rawJson?: unknown;
  resolvedDetail?: Extract<OpportunityDetailResult, { status: 'resolved' }>;
  resolutionStatus?:
    | 'resolved_root'
    | 'direct_root'
    | 'unresolved_alias'
    | 'invalid';
  rootPostingUrl?: string;
  title: string;
  workMode?: string;
}

interface RemoteComDepartment {
  children?: RemoteComDepartment[];
  jobs?: RemoteComJob[];
}

interface RemoteComJob {
  absolute_url?: string;
  first_published?: string;
  id?: number | string;
  location?: { name?: string };
  title?: string;
  updated_at?: string;
}

interface RemoteOkJob {
  apply_url?: string;
  company?: string;
  date?: string;
  description?: string;
  id?: number | string;
  location?: string;
  position?: string;
  salary_max?: number | string;
  salary_min?: number | string;
  slug?: string;
  tags?: string[];
  url?: string;
}

interface FreelancerProject {
  budget?: { maximum?: number | string; minimum?: number | string };
  currency?: { code?: string };
  description?: string | null;
  id?: number | string;
  jobs?: Array<{ name?: string }> | null;
  preview_description?: string;
  seo_url?: string;
  submitdate?: number | string;
  title?: string;
  type?: string;
}

interface FreelancerProjectsResponse {
  result?: { projects?: FreelancerProject[] };
  status?: string;
}

interface RemotiveJob {
  candidate_required_location?: string;
  category?: string;
  company_name?: string;
  description?: string;
  id?: number | string;
  job_type?: string;
  publication_date?: string;
  salary?: string;
  tags?: string[];
  title?: string;
  url?: string;
}

interface RemotiveApiResponse {
  jobs?: RemotiveJob[];
}

interface WorkingNomadsJob {
  category_name?: string;
  company_name?: string;
  description?: string;
  location?: string;
  pub_date?: string;
  tags?: string;
  title?: string;
  url?: string;
}

interface LinkedInJobCard {
  companyName?: string;
  companyUrl?: string;
  location?: string;
  postedAt?: string;
  postingUrl?: string;
  title?: string;
}

interface WeWorkRemotelyRssJob {
  category?: string;
  descriptionHtml?: string;
  link?: string;
  region?: string;
  title?: string;
}

interface AmazonJobsSearchResponse {
  jobs?: AmazonJobsJob[];
}

interface AiJobsIndexJob {
  company?: string;
  location?: string;
  title?: string;
  url?: string;
}

interface AmazonJobsJob {
  basic_qualifications?: string;
  company_name?: string;
  description?: string;
  id?: number | string;
  id_icims?: number | string;
  job_path?: string;
  job_schedule_type?: string;
  locations?: Array<{ normalized_location?: string } | string>;
  normalized_location?: string;
  posted_date?: string;
  preferred_qualifications?: string;
  title?: string;
  updated_time?: string;
}

interface AppleCareersJob {
  id?: string;
  jobNumber?: string;
  locations?: Array<{
    city?: string;
    countryName?: string;
    name?: string;
    stateProvince?: string;
  }>;
  positionId?: string;
  postingDate?: string;
  postingTitle?: string;
  transformedPostingTitle?: string;
}

interface AutomatticJob {
  content?: string;
  href?: string;
  id?: number | string;
  metadata?: {
    Category?: string[];
    Team?: string[] | null;
  };
  title?: string;
  type?: string;
}

interface OracleCareersJob {
  ExternalQualificationsStr?: string | null;
  ExternalResponsibilitiesStr?: string | null;
  Id?: number | string;
  PostedDate?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  ShortDescriptionStr?: string;
  Title?: string;
  WorkplaceType?: string;
  secondaryLocations?: Array<{
    CountryCode?: string;
    Name?: string;
  }>;
}

interface OracleCareersSearchResult {
  requisitionList?: OracleCareersJob[];
}

interface OracleCareersSearchResponse {
  items?: OracleCareersSearchResult[];
}

interface CanonicalVacancy {
  date?: string;
  departments?: string[];
  description?: string;
  employment?: string;
  id?: number | string;
  location?: string;
  skills?: string[];
  title?: string;
  url?: string;
}

type OpportunityIntelligenceEnqueuer = (
  opportunityId: string,
  args?: OpportunityIntelligenceJobArgs,
  options?: { reason?: string },
) => Promise<OpportunityIntelligenceEnqueueResult>;
type OpportunityIntelligenceActiveJobFinder = (
  opportunityId: string,
  contentFingerprint: string,
) => Promise<{ id?: unknown } | null>;
type FencedOpportunitySourceUpdate = (
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  updates: Record<string, unknown>,
) => Promise<boolean>;
type FencedOpportunityIntelligenceUpdate = (
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  updates: {
    sourceIntelligenceJobId: string;
    sourceIntelligenceStatus: string;
  },
) => Promise<boolean>;
type FencedOpportunityStatusUpdate = (
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  expectedStatus: string,
  status: string,
) => Promise<boolean>;
type SourceBoardReconciler = (input: {
  now: Date;
  reconcileAbsence: boolean;
  seenOpportunityIds: string[];
  sourceCrawlId: string;
  sourceId: string;
}) => Promise<BoardReconciliationCounts>;

type FencedOpportunityBackfillUpdate = (
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  expected: Record<string, unknown>,
  updates: Record<string, unknown>,
) => Promise<boolean>;

export interface CrawlOpportunitySourcesOptions {
  dryRun?: boolean;
  enqueueOpportunityIntelligence?: OpportunityIntelligenceEnqueuer;
  fetchImpl?: FetchLike;
  fencedOpportunityIntelligenceUpdate?: FencedOpportunityIntelligenceUpdate;
  fencedOpportunityBackfillUpdate?: FencedOpportunityBackfillUpdate;
  fencedOpportunitySourceUpdate?: FencedOpportunitySourceUpdate;
  fencedOpportunityStatusUpdate?: FencedOpportunityStatusUpdate;
  findActiveOpportunityIntelligenceJob?: OpportunityIntelligenceActiveJobFinder;
  includeGeneric?: boolean;
  intelligenceEnqueueCap?: number;
  jobId?: string;
  jobAttempt?: number;
  limit?: number;
  /** Board reconciliation seam; defaults to the durable implementation. */
  reconcileSourceBoard?: SourceBoardReconciler;
  signal?: AbortSignal;
  sourceCrawlAccounting?: SourceCrawlAccountingWriter;
  sourceCrawlId?: string;
  sourceId?: string;
  spider?: SpiderAdapter;
}

export interface CrawlOpportunitySourceSummary {
  candidates: number;
  created: number;
  duplicates: number;
  errors: string[];
  failedPersistence: number;
  intelligenceDuplicateSuppressed: number;
  intelligenceEnqueued: number;
  intelligenceSkipped: number;
  relisted: number;
  reused: number;
  skipped: number;
  sourceId: string;
  sourceName: string;
}

export interface CrawlOpportunitySourcesSummary {
  candidates: number;
  created: number;
  duplicates: number;
  errors: string[];
  failedPersistence: number;
  intelligenceDuplicateSuppressed: number;
  intelligenceEnqueued: number;
  intelligenceSkipped: number;
  relisted: number;
  reused: number;
  skipped: number;
  sources: CrawlOpportunitySourceSummary[];
}

interface GreenhouseJob {
  absolute_url?: string;
  content?: string;
  first_published?: string;
  id?: number | string;
  location?: { name?: string };
  title?: string;
  updated_at?: string;
}

interface AshbyBoardJob {
  descriptionHtml?: string;
  employmentType?: string;
  id?: string;
  isRemote?: boolean;
  jobUrl?: string;
  location?: string;
  locationName?: string;
  publishedAt?: string;
  publishedDate?: string;
  title?: string;
  workplaceType?: string;
}

interface AshbyPostingApiResponse {
  jobs?: AshbyBoardJob[];
}

interface LeverPostingJob {
  id?: string;
  text?: string;
  hostedUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: {
    commitment?: string;
    location?: string;
  };
}

interface WorkdaySearchResponse {
  jobPostings?: WorkdaySearchJob[];
}

interface WorkdaySearchJob {
  bulletFields?: Array<number | string>;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  title?: string;
}

interface WorkdayJobDetailResponse {
  jobPostingInfo?: {
    id?: string;
    jobDescription?: string;
    location?: string;
    postedOn?: string;
    title?: string;
  };
}

interface MicrosoftCareersSearchResponse {
  data?: { positions?: MicrosoftCareersPosition[] };
}

interface MicrosoftCareersPosition {
  atsJobId?: number | string;
  creationTs?: number | string;
  department?: string;
  displayJobId?: number | string;
  id?: number | string;
  locations?: string[];
  name?: string;
  positionUrl?: string;
  postedTs?: number | string;
  standardizedLocations?: string[];
  workLocationOption?: string | null;
}

interface MicrosoftCareersDetailResponse {
  data?: MicrosoftCareersPosition & {
    jobDescription?: string;
    qualifications?: string;
    responsibilities?: string;
  };
}

interface YcBoardJob {
  companyName?: string;
  id?: number | string;
  location?: string;
  title?: string;
  type?: string;
  url?: string;
}

interface A16zPortfolioBoard {
  id?: string;
  isParent?: boolean;
}

interface A16zPortfolioJob {
  applyUrl?: string;
  companyName?: string;
  id?: number | string;
  jobTypes?: Array<{ label?: string; value?: string }>;
  locations?: string[];
  publishedAt?: string;
  title?: string;
  url?: string;
}

interface A16zPortfolioSearchResponse {
  jobs?: A16zPortfolioJob[];
}

interface A16zPortfolioSession {
  board: A16zPortfolioBoard;
  cookie: string;
  csrfToken: string;
}

interface HackerNewsAlgoliaHit {
  objectID?: string;
  title?: string;
}

interface HackerNewsAlgoliaSearchResponse {
  hits?: HackerNewsAlgoliaHit[];
}

interface HackerNewsAlgoliaItem {
  children?: HackerNewsAlgoliaItem[];
  id?: number | string;
  text?: string;
  title?: string | null;
  type?: string;
}

interface GoogleCareersJob {
  id?: string;
  location?: string;
  title: string;
  url: string;
}

interface GeminiCareersJob {
  jobBaseUrl?: string;
  jobId?: number | string;
  jobLocation?: string;
  jobTitle?: string;
  jobUrl?: string;
}

interface PeoplePerHourProject {
  description: string;
  externalId: string;
  postingUrl: string;
  title: string;
}

interface PeoplePerHourFetchDiagnostic {
  bodyShape: string;
  contentLength: number;
  contentType: string;
  finalUrl: string;
  hasProjectCardLinks: boolean;
  hasProjectDescriptions: boolean;
  projectCardCount: number;
  status: number;
}

interface ContraFetchDiagnostic {
  bodyShape: string;
  contentLength: number;
  contentType: string;
  finalUrl: string;
  status: number;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function parseDate(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeText(value: unknown): string {
  return stringValue(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function displayTitle(value: unknown): string {
  return stringValue(value).replace(/\s+/g, ' ');
}

function companyKeyFromName(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, '-').slice(0, 96);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

const CRAWL_ERROR_CONTEXT_LIMIT = 192;
const CRAWL_ERROR_MESSAGE_LIMIT = 384;

function boundedCrawlErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, CRAWL_ERROR_MESSAGE_LIMIT);
}

function boundedCrawlError(
  candidate: OpportunitySourceCandidate,
  error: unknown,
): string {
  const context = [
    stringValue(candidate.diagnosticContext),
    stringValue(candidate.title || candidate.postingUrl),
  ]
    .filter(Boolean)
    .join(': ')
    .replace(/\s+/g, ' ')
    .slice(0, CRAWL_ERROR_CONTEXT_LIMIT);
  const message = boundedCrawlErrorMessage(error);
  return `${context || 'crawl item'}: ${message || 'unknown error'}`;
}

function sourceCrawlAttemptRawJson(
  candidate: OpportunitySourceCandidate,
  detail: Extract<OpportunityDetailResult, { status: 'resolved' }>,
): string {
  return safeJson({
    candidateRawJson: candidate.rawJson ?? {},
    recoveryIdentities: {
      candidateCanonicalUrl: stringValue(candidate.canonicalUrl),
      discoveredUrl: stringValue(candidate.discoveredUrl),
      externalId: stringValue(detail.externalId || candidate.externalId),
      finalCanonicalUrl: stringValue(detail.canonicalUrl),
      postingUrl: stringValue(candidate.postingUrl),
      rootPostingUrl: stringValue(candidate.rootPostingUrl),
    },
  });
}

function sourceUrl(source: SourceLike): URL | null {
  const raw = stringValue(source.url);
  if (!raw) return null;

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function normalizeHttpUrl(value: unknown, baseUrl?: string): string {
  const raw = stringValue(value);
  if (!raw) return '';
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

// A candidate is only worth saving as an opportunity if its posting URL points
// at an actual posting, not a bare board homepage (e.g. https://ca.indeed.com/).
// URL-less candidates can't be applied to, so we reject them at ingestion.
function isApplyableJobUrl(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return Boolean((url.pathname && url.pathname !== '/') || url.search);
  } catch {
    return false;
  }
}

function providerForUrl(
  value: unknown,
):
  | 'ashby'
  | 'amazon-jobs'
  | 'aijobs'
  | 'automattic-careers'
  | 'apple-careers'
  | 'canonical-careers'
  | 'generic'
  | 'gemini-careers'
  | 'google-careers'
  | 'greenhouse'
  | 'hacker-news'
  | 'lever'
  | 'linkedin'
  | 'microsoft-careers'
  | 'oracle-careers'
  | 'freelancer'
  | 'peopleperhour'
  | 'remote-com'
  | 'a16z-portfolio'
  | 'remoterocketship'
  | 'remotive'
  | 'remoteok'
  | 'unsupported'
  | 'wellfound'
  | 'workingnomads'
  | 'weworkremotely'
  | 'workday'
  | 'ycombinator' {
  const raw = stringValue(value);
  if (!raw) return 'unsupported';

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'unsupported';
  }

  if (url.hostname === 'jobs.ashbyhq.com') return 'ashby';
  if (
    url.hostname === 'api.ashbyhq.com' &&
    url.pathname.startsWith('/posting-api/job-board/')
  ) {
    return 'ashby';
  }
  if (
    url.hostname === 'jobs.a16z.com' ||
    (url.hostname === 'a16z.com' && url.pathname.startsWith('/jobs'))
  ) {
    return 'a16z-portfolio';
  }
  if (isWorkdayJobsUrl(url)) return 'workday';
  if (
    (url.hostname === 'automattic.com' ||
      url.hostname === 'www.automattic.com') &&
    url.pathname.startsWith('/work-with-us/')
  ) {
    return 'automattic-careers';
  }
  if (url.hostname === 'www.amazon.jobs' || url.hostname === 'amazon.jobs') {
    return 'amazon-jobs';
  }
  if (
    ['ai-jobs.net', 'www.ai-jobs.net', 'aijobs.net', 'www.aijobs.net'].includes(
      url.hostname,
    )
  ) {
    return 'aijobs';
  }
  if (url.hostname === 'jobs.apple.com' && url.pathname.includes('/search')) {
    return 'apple-careers';
  }
  if (
    (url.hostname === 'canonical.com' ||
      url.hostname === 'www.canonical.com') &&
    (url.pathname === '/careers/all' || url.pathname === '/careers/all/')
  ) {
    return 'canonical-careers';
  }
  if (url.hostname === 'jobs.lever.co') return 'lever';
  if (
    (url.hostname === 'www.gemini.com' || url.hostname === 'gemini.com') &&
    (url.pathname === '/careers' || url.pathname.startsWith('/jobs/'))
  ) {
    return 'gemini-careers';
  }
  if (
    (url.hostname === 'www.linkedin.com' || url.hostname === 'linkedin.com') &&
    url.pathname.startsWith('/jobs')
  ) {
    return 'linkedin';
  }
  if (
    url.hostname === 'jobs.careers.microsoft.com' ||
    url.hostname === 'apply.careers.microsoft.com'
  ) {
    return 'microsoft-careers';
  }
  if (url.hostname === 'careers.oracle.com') return 'oracle-careers';
  if (
    url.hostname === 'www.freelancer.com' ||
    url.hostname === 'freelancer.com'
  ) {
    return url.pathname.startsWith('/jobs') ||
      url.pathname.startsWith('/projects/')
      ? 'freelancer'
      : 'generic';
  }
  if (
    (url.hostname === 'www.peopleperhour.com' ||
      url.hostname === 'peopleperhour.com') &&
    url.pathname.startsWith('/freelance-jobs')
  ) {
    return 'peopleperhour';
  }
  if (knownGreenhouseBoardToken(url)) return 'greenhouse';
  if (
    url.hostname === 'www.google.com' &&
    url.pathname.startsWith('/about/careers/applications/jobs/results')
  ) {
    return 'google-careers';
  }
  if (url.hostname === 'news.ycombinator.com' && url.pathname === '/jobs') {
    return 'hacker-news';
  }
  if (
    url.hostname === 'news.ycombinator.com' &&
    url.pathname === '/submitted' &&
    url.searchParams.get('id') === 'whoishiring'
  ) {
    return 'hacker-news';
  }
  if (
    (url.hostname === 'www.ycombinator.com' ||
      url.hostname === 'ycombinator.com') &&
    (url.pathname === '/jobs' || url.pathname.startsWith('/companies/'))
  ) {
    return 'ycombinator';
  }
  if (isRemoteComOpeningsUrl(raw)) return 'remote-com';
  if (url.hostname === 'remoteok.com' || url.hostname === 'www.remoteok.com') {
    return 'remoteok';
  }
  if (
    url.hostname === 'wellfound.com' ||
    url.hostname === 'www.wellfound.com'
  ) {
    return 'wellfound';
  }
  if (
    url.hostname === 'remoterocketship.com' ||
    url.hostname === 'www.remoterocketship.com'
  ) {
    return 'remoterocketship';
  }
  if (url.hostname === 'remotive.com' || url.hostname === 'www.remotive.com') {
    return 'remotive';
  }
  if (
    url.hostname === 'weworkremotely.com' ||
    url.hostname === 'www.weworkremotely.com'
  ) {
    return 'weworkremotely';
  }
  if (
    url.hostname === 'workingnomads.com' ||
    url.hostname === 'www.workingnomads.com'
  ) {
    return 'workingnomads';
  }
  if (url.hostname.endsWith('greenhouse.io')) return 'greenhouse';
  return 'generic';
}

function isWorkdayJobsUrl(url: URL): boolean {
  return /\.wd\d+\.myworkdayjobs\.com$/i.test(url.hostname);
}

function isContraUrl(value: unknown): boolean {
  if (value instanceof URL) {
    return (
      value.hostname === 'contra.com' || value.hostname === 'www.contra.com'
    );
  }
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.hostname === 'contra.com' || url.hostname === 'www.contra.com';
  } catch {
    return false;
  }
}

function isDiscoverableProviderPostingUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }

  const provider = providerForUrl(href);
  if (provider === 'ycombinator') {
    const [, companiesSegment, companySlug, jobsSegment, jobSlug] =
      url.pathname.split('/');
    return Boolean(
      companiesSegment === 'companies' &&
        companySlug &&
        jobsSegment === 'jobs' &&
        jobSlug,
    );
  }

  return (
    provider === 'ashby' ||
    provider === 'greenhouse' ||
    provider === 'lever' ||
    provider === 'remoteok' ||
    provider === 'remoterocketship' ||
    provider === 'workday'
  );
}

function greenhouseJobToken(url: URL): string {
  const queryToken =
    url.searchParams.get('token') ?? url.searchParams.get('gh_jid');
  if (queryToken) return queryToken;

  const [jobsSegment, jobToken] = url.pathname
    .split('/')
    .filter(Boolean)
    .slice(-2);
  if (jobsSegment === 'jobs') return jobToken ?? '';

  return '';
}

function knownGreenhouseBoardToken(url: URL): string {
  const host = url.hostname.toLowerCase();
  const brandedGreenhouseBoards: Record<string, string> = {
    'databricks.com': 'databricks',
    'www.databricks.com': 'databricks',
    'fivetran.com': 'fivetran',
    'www.fivetran.com': 'fivetran',
    'navan.com': 'tripactions',
    'www.navan.com': 'tripactions',
    'pindrop.com': 'pindropsecurity',
    'www.pindrop.com': 'pindropsecurity',
    'crossriver.com': 'crossriverbank',
    'www.crossriver.com': 'crossriverbank',
    'wiz.io': 'wizinc',
    'www.wiz.io': 'wizinc',
  };
  const brandedBoard = brandedGreenhouseBoards[host];
  if (brandedBoard && greenhouseJobToken(url)) return brandedBoard;

  if (host === 'coinbase.com' || host === 'www.coinbase.com') {
    if (/^\/careers\/positions(?:\/[^/]+)?\/?$/i.test(url.pathname)) {
      return 'coinbase';
    }
  }

  if (host === 'fireblocks.com' || host === 'www.fireblocks.com') {
    if (/^\/careers(?:\/position(?:\/[^/]+)?)?\/?$/i.test(url.pathname)) {
      return 'fireblocks';
    }
  }
  if (host === 'ripple.com' || host === 'www.ripple.com') {
    if (/^\/careers\/all-jobs(?:\/job(?:\/[^/]+)?)?\/?$/i.test(url.pathname)) {
      return 'ripple';
    }
  }

  return '';
}

function greenhouseBoardToken(url: URL): string {
  const knownBoard = knownGreenhouseBoardToken(url);
  if (knownBoard) return knownBoard;

  const board = url.searchParams.get('for');
  if (board) return board;

  const [firstSegment] = url.pathname.split('/').filter(Boolean);
  return firstSegment ?? '';
}

function canonicalAshbyUrl(boardSlug: string, jobId: string): string {
  return `https://jobs.ashbyhq.com/${boardSlug}/${jobId}`;
}

function automatticJobsUrl(url: URL): string {
  if (url.pathname === '/work-with-us/jobs/') return url.toString();
  return new URL('/work-with-us/jobs/', url.origin).toString();
}

function ashbyBoardSlug(url: URL): string {
  if (
    url.hostname === 'api.ashbyhq.com' &&
    url.pathname.startsWith('/posting-api/job-board/')
  ) {
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
  }
  return url.pathname.split('/').filter(Boolean)[0] ?? '';
}

function ashbyPostingApiUrl(boardSlug: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardSlug)}`;
}

function canonicalAshbyLocation(job: AshbyBoardJob): string {
  return stringValue(job.locationName || job.location);
}

function ashbyPublishedAt(job: AshbyBoardJob): Date | null {
  if (job.publishedAt) return parseDate(job.publishedAt);
  return job.publishedDate
    ? parseDate(`${job.publishedDate}T00:00:00.000Z`)
    : null;
}

function leverBoardSlug(url: URL): string {
  return url.pathname.split('/').filter(Boolean)[0] ?? '';
}

function canonicalLeverUrl(boardSlug: string, jobId: string): string {
  return `https://jobs.lever.co/${boardSlug}/${jobId}`;
}

function workModeFromValue(value: unknown): string | undefined {
  const text = stringValue(value).toLowerCase();
  if (!text) return undefined;
  if (text.includes('remote') || text.includes('home based')) return 'remote';
  if (text.includes('hybrid')) return 'hybrid';
  if (
    text.includes('onsite') ||
    text.includes('on-site') ||
    text.includes('in person')
  ) {
    return 'onsite';
  }
  return undefined;
}

function employmentTypeFromValue(value: unknown): string | undefined {
  const text = stringValue(value)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  if (text.includes('full time') || text.includes('fulltime'))
    return 'full_time';
  if (text.includes('contract')) return 'contract';
  if (text.includes('part time') || text.includes('parttime'))
    return 'fractional';
  if (text.includes('fractional')) return 'fractional';
  if (text.includes('advisor') || text.includes('advisory')) return 'advisory';
  if (text.includes('founder')) return 'founder';
  return undefined;
}

function knownEnumValue(value: unknown): string {
  const text = stringValue(value);
  return text && text !== 'unknown' ? text : '';
}

function extractJsonValue<T>(
  html: string,
  marker: string,
  open: '[' | '{',
): T | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = html.indexOf(open, markerIndex + marker.length);
  if (start === -1) return null;

  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = start; index < html.length; index += 1) {
    const char = html[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) {
      return JSON.parse(html.slice(start, index + 1)) as T;
    }
  }

  return null;
}

function extractNextData<T>(html: string): T | null {
  const match = html.match(
    /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match?.[1]) return null;
  try {
    return JSON.parse(decodeHtmlEntities(match[1])) as T;
  } catch {
    return null;
  }
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  url: string,
): Promise<T | null> {
  const response = await fetchImpl(url);
  if (!response.ok) return null;
  return (await response.json()) as T;
}

export function keywordTokens(source: SourceLike): string[] {
  const stopwords = new Set([
    'and',
    'canada',
    'engineer',
    'engineering',
    'for',
    'full',
    'hybrid',
    'or',
    'remote',
    'senior',
    'site',
    'software',
    'staff',
    'the',
    'us',
  ]);

  return Array.from(
    new Set(
      normalizeText(source.searchQuery)
        .split(' ')
        .filter((token) => token.length > 2 && !stopwords.has(token)),
    ),
  );
}

export function candidateMatchesSource(
  source: SourceLike,
  candidateText: string,
): boolean {
  const text = normalizeText(candidateText);
  if (!text) return false;
  const words = text.split(' ').filter(Boolean);
  const technicalWords = new Set([
    'backend',
    'data',
    'devops',
    'distributed',
    'engineer',
    'engineering',
    'evals',
    'infrastructure',
    'kubernetes',
    'platform',
    'research',
    'scientist',
    'security',
    'systems',
    'technical',
    'tooling',
  ]);
  const nonTechnicalWords = new Set([
    'account',
    'copywriter',
    'customer',
    'executive',
    'finance',
    'legal',
    'marketing',
    'recruiter',
    'sales',
  ]);
  if (
    words.some((word) => nonTechnicalWords.has(word)) &&
    !words.some((word) => technicalWords.has(word))
  ) {
    return false;
  }

  const queryTokens = keywordTokens(source);
  if (queryTokens.some((token) => words.some((word) => word === token)))
    return true;

  return [
    'agent',
    'automation',
    'backend',
    'data',
    'devops',
    'distributed',
    'engineer',
    'engineering',
    'evals',
    'founding',
    'infrastructure',
    'kubernetes',
    'platform',
    'principal',
    'research',
    'scientist',
    'security',
    'systems',
    'technical',
    'tooling',
  ].some((token) =>
    words.some((word) => word === token || word.startsWith(token)),
  );
}

function sourceProviderIsCrawlable(
  source: Pick<SourceLike, 'url'>,
  includeGeneric = false,
): boolean {
  const provider = providerForUrl(source.url);
  if (
    provider === 'ashby' ||
    provider === 'aijobs' ||
    provider === 'amazon-jobs' ||
    provider === 'automattic-careers' ||
    provider === 'apple-careers' ||
    provider === 'canonical-careers' ||
    provider === 'google-careers' ||
    provider === 'greenhouse' ||
    provider === 'hacker-news' ||
    provider === 'lever' ||
    provider === 'linkedin' ||
    provider === 'microsoft-careers' ||
    provider === 'oracle-careers' ||
    provider === 'freelancer' ||
    provider === 'peopleperhour' ||
    provider === 'a16z-portfolio' ||
    provider === 'gemini-careers' ||
    provider === 'remote-com' ||
    provider === 'remoterocketship' ||
    provider === 'remotive' ||
    provider === 'remoteok' ||
    provider === 'wellfound' ||
    provider === 'weworkremotely' ||
    provider === 'workingnomads' ||
    provider === 'workday' ||
    provider === 'ycombinator'
  )
    return true;
  if (includeGeneric && provider === 'generic') return true;
  return false;
}

export function sourceIsCrawlable(
  source: SourceLike,
  includeGeneric = false,
): boolean {
  return (
    source.isActive === true &&
    sourceProviderIsCrawlable(source, includeGeneric)
  );
}

function greenhouseResolvedDetail(
  job: GreenhouseJob,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const descriptionRaw = htmlToPlainText(job.content);
  const location = stringValue(job.location?.name);
  // Park raw requirement bullets in qualifications; the LLM extract step refines
  // them into atomic skills + responsibilities + qualifications.
  const qualifications = qualificationsFromDescription(descriptionRaw);
  return {
    canonicalUrl: stringValue(job.absolute_url),
    descriptionRaw,
    externalId: stringValue(job.id),
    locationNotes: location,
    message: 'Loaded Greenhouse posting details.',
    postedAt: parseDate(job.first_published),
    provider: 'greenhouse',
    qualifications,
    status: 'resolved',
    title: displayTitle(job.title),
    workMode: workModeFromValue(location),
  };
}

export async function discoverGreenhouseCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const boardToken = greenhouseBoardToken(url);
  if (!boardToken) return [];

  const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
    fetchImpl,
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`,
  );
  const jobs = data?.jobs ?? [];

  return jobs
    .map((job) => {
      const detail = greenhouseResolvedDetail(job);
      return {
        canonicalUrl: detail.canonicalUrl,
        employmentType: detail.employmentType,
        externalId: detail.externalId,
        locationNotes: detail.locationNotes,
        postedAt: detail.postedAt,
        postingUrl: detail.canonicalUrl,
        rawJson: job,
        resolvedDetail: detail,
        title: detail.title ?? '',
        workMode: detail.workMode,
      };
    })
    .filter((candidate) => candidate.title && candidate.postingUrl);
}

function configuredCrawl4aiUrl(): string {
  return stringValue(
    process.env.HAVE_SPIDER_CRAWL4AI_URL ||
      process.env.CRAWL4AI_URL ||
      process.env.CRAWL4AI_BASE_URL,
  );
}

export function defaultOpportunitySpiderOptions(): SpiderAdapterOptions {
  const baseUrl = configuredCrawl4aiUrl();
  if (baseUrl) {
    return {
      adapter: 'crawl4ai',
      baseUrl,
      cacheDir: '.cache/opportunity-spider',
      userAgent: getSafeOutboundHeaderValue(
        process.env.HAVE_SPIDER_USER_AGENT ?? '',
        browserSourceCrawlerUserAgent(),
      ),
      waitUntil: 'networkidle',
    };
  }

  return {
    adapter: 'simple',
    cacheDir: '.cache/opportunity-spider',
  };
}

async function getDefaultSpider(): Promise<SpiderAdapter> {
  return await getSpider(defaultOpportunitySpiderOptions());
}

function ashbyCandidatesFromJobs(
  boardSlug: string,
  jobs: AshbyBoardJob[],
): OpportunitySourceCandidate[] {
  return jobs
    .filter((job) => job.id && job.title)
    .map((job) => {
      const jobId = stringValue(job.id);
      const canonicalUrl =
        stringValue(job.jobUrl) || canonicalAshbyUrl(boardSlug, jobId);
      const descriptionRaw = htmlToPlainText(stringValue(job.descriptionHtml));
      const locationNotes = canonicalAshbyLocation(job);
      const title = displayTitle(job.title);
      const workMode =
        workModeFromValue(job.workplaceType || locationNotes) ||
        (job.isRemote ? 'remote' : undefined);
      const postedAt = ashbyPublishedAt(job);
      return {
        canonicalUrl,
        employmentType: employmentTypeFromValue(job.employmentType),
        externalId: jobId,
        locationNotes,
        postedAt,
        postingUrl: canonicalUrl,
        rawJson: job,
        ...(descriptionRaw
          ? {
              resolvedDetail: {
                canonicalUrl,
                descriptionRaw,
                employmentType: employmentTypeFromValue(job.employmentType),
                externalId: jobId,
                locationNotes,
                message: 'Loaded Ashby posting details.',
                postedAt,
                provider: 'ashby',
                qualifications: qualificationsFromDescription(descriptionRaw),
                status: 'resolved',
                title,
                workMode,
              } satisfies Extract<
                OpportunityDetailResult,
                { status: 'resolved' }
              >,
            }
          : {}),
        title,
        workMode,
      };
    });
}

export async function discoverAshbyCandidates(
  source: SourceLike,
  spider?: SpiderAdapter,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const boardSlug = ashbyBoardSlug(url);
  if (!boardSlug) return [];

  if (
    url.hostname === 'api.ashbyhq.com' &&
    url.pathname.startsWith('/posting-api/job-board/')
  ) {
    const data = await fetchJson<AshbyPostingApiResponse>(
      fetchImpl,
      url.toString(),
    );
    return ashbyCandidatesFromJobs(boardSlug, data?.jobs ?? []);
  }

  let jobs: AshbyBoardJob[] = [];
  try {
    const activeSpider = spider ?? (await getDefaultSpider());
    const page = await activeSpider.fetch(url.toString(), {
      cache: true,
      cacheExpiry: 60 * 60 * 1000,
      timeout: 60000,
    });
    jobs =
      extractJsonValue<AshbyBoardJob[]>(page.content, '"jobPostings":', '[') ??
      [];
  } catch {
    // A spider outage should not turn public Ashby boards into zero-candidate
    // crawls. Ashby also serves the board payload to normal fetches, and the
    // posting API fallback below covers boards that omit it.
    jobs = [];
  }

  // The production crawl4ai spider can occasionally return rendered Ashby board
  // text without the SSR payload that contains `jobPostings`. Ashby serves the
  // public board HTML with that payload to a normal fetch, so use it as a
  // no-cache fallback before concluding the board has no jobs.
  if (jobs.length === 0) {
    try {
      const response = await fetchImpl(url.toString(), {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': sourceCrawlerUserAgent(),
        },
      });
      if (response.ok) {
        jobs =
          extractJsonValue<AshbyBoardJob[]>(
            await response.text(),
            '"jobPostings":',
            '[',
          ) ?? [];
      }
    } catch {
      // Keep the spider miss as a zero-candidate result; callers already record
      // the completed crawl without treating an empty board as an exception.
    }
  }

  if (jobs.length === 0) {
    const data = await fetchJson<AshbyPostingApiResponse>(
      fetchImpl,
      ashbyPostingApiUrl(boardSlug),
    );
    jobs = data?.jobs ?? [];
  }

  return ashbyCandidatesFromJobs(boardSlug, jobs);
}

function automatticJobCategories(job: AutomatticJob): string[] {
  return [
    ...(Array.isArray(job.metadata?.Category) ? job.metadata.Category : []),
    ...(Array.isArray(job.metadata?.Team) ? job.metadata.Team : []),
  ]
    .map((value) => displayTitle(value))
    .filter(Boolean);
}

function automatticResolvedDetail(
  job: AutomatticJob,
  canonicalUrl: string,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const descriptionRaw = htmlToPlainText(stringValue(job.content));
  const categories = automatticJobCategories(job);
  return {
    canonicalUrl,
    descriptionRaw,
    externalId: stringValue(job.id),
    locationNotes: 'Remote',
    message: 'Loaded Automattic careers posting details.',
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: displayTitle(job.title),
    workMode: 'remote',
    ...(categories.length ? { requiredSkills: categories.join('\n') } : {}),
  };
}

export async function discoverAutomatticCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const response = await fetchImpl(automatticJobsUrl(url), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];

  const jobs = extractJsonValue<AutomatticJob[]>(
    await response.text(),
    'const ghJobsData =',
    '[',
  );
  if (!Array.isArray(jobs)) return [];

  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const job of jobs) {
    const postingUrl = stringValue(job.href);
    const title = displayTitle(job.title);
    if (!postingUrl || !title || seen.has(postingUrl)) continue;
    seen.add(postingUrl);
    const detail = automatticResolvedDetail(job, postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      companyName: 'Automattic',
      employmentType: employmentTypeFromValue(job.type),
      externalId: detail.externalId,
      locationNotes: detail.locationNotes,
      postingUrl,
      rawJson: job,
      resolvedDetail: detail,
      title,
      workMode: detail.workMode,
    });
  }
  return candidates;
}

const ORACLE_CAREERS_API_URL =
  'https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
const ORACLE_CAREERS_SITE_NUMBER = 'CX_45001';

function oracleCareersSearchUrl(source: SourceLike): string {
  const params = new URLSearchParams({
    onlyData: 'true',
    limit: '25',
    offset: '0',
    expand: 'requisitionList.secondaryLocations',
  });
  const query = stringValue(source.searchQuery) || 'AI Platform';
  params.set(
    'finder',
    `findReqs;siteNumber=${ORACLE_CAREERS_SITE_NUMBER},keyword="${query.replaceAll('"', '')}",sortBy=POSTING_DATES_DESC`,
  );
  return `${ORACLE_CAREERS_API_URL}?${params.toString()}`;
}

function oracleCareersPostingUrl(job: OracleCareersJob): string {
  const id = encodeURIComponent(stringValue(job.Id));
  return `https://careers.oracle.com/en/sites/jobsearch/job/${id}`;
}

function oracleCareersLocation(job: OracleCareersJob): string {
  const locations = [
    stringValue(job.PrimaryLocation),
    ...(job.secondaryLocations ?? []).map((location) =>
      stringValue(location.Name || location.CountryCode),
    ),
  ].filter(Boolean);
  return Array.from(new Set(locations)).join('; ');
}

function oracleCareersResolvedDetail(
  job: OracleCareersJob,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const descriptionRaw = htmlToPlainText(
    [
      job.ShortDescriptionStr,
      job.ExternalResponsibilitiesStr,
      job.ExternalQualificationsStr,
    ]
      .map(stringValue)
      .filter(Boolean)
      .join('\n\n'),
  );
  const locationNotes = oracleCareersLocation(job);
  return {
    canonicalUrl: oracleCareersPostingUrl(job),
    descriptionRaw,
    externalId: stringValue(job.Id),
    locationNotes,
    message: 'Loaded Oracle careers posting details.',
    postedAt: parseDate(job.PostedDate),
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: displayTitle(job.Title),
    workMode: workModeFromValue([locationNotes, job.WorkplaceType].join(' ')),
  };
}

export async function discoverOracleCareersCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const data = await fetchJson<OracleCareersSearchResponse>(
    fetchImpl,
    oracleCareersSearchUrl(source),
  );
  const jobs = data?.items?.flatMap((item) => item.requisitionList ?? []) ?? [];
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const job of jobs) {
    const title = displayTitle(job.Title);
    const externalId = stringValue(job.Id);
    if (!title || !externalId) continue;
    const detail = oracleCareersResolvedDetail(job);
    const postingUrl = detail.canonicalUrl;
    if (!postingUrl || seen.has(postingUrl)) continue;
    if (!candidateMatchesSource(source, `${title} ${detail.descriptionRaw}`)) {
      continue;
    }
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      companyName: 'Oracle',
      externalId,
      locationNotes: detail.locationNotes,
      postedAt: detail.postedAt,
      postingUrl,
      rawJson: job,
      resolvedDetail: detail,
      title,
      workMode: detail.workMode,
    });
  }
  return candidates;
}

export async function discoverLeverCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const boardSlug = leverBoardSlug(url);
  if (!boardSlug) return [];

  // Public, unauthenticated postings API — metadata only (no application form;
  // the ATS submitter reads questions from the apply page).
  const jobs = await fetchJson<LeverPostingJob[]>(
    fetchImpl,
    `https://api.lever.co/v0/postings/${encodeURIComponent(boardSlug)}?mode=json`,
  );
  if (!Array.isArray(jobs)) return [];

  return jobs
    .filter((job) => job.id && job.text)
    .map((job) => {
      const canonicalUrl =
        stringValue(job.hostedUrl) ||
        canonicalLeverUrl(boardSlug, stringValue(job.id));
      return {
        canonicalUrl,
        employmentType: employmentTypeFromValue(job.categories?.commitment),
        externalId: stringValue(job.id),
        locationNotes: stringValue(job.categories?.location),
        postedAt:
          typeof job.createdAt === 'number' ? new Date(job.createdAt) : null,
        postingUrl: canonicalUrl,
        rawJson: job,
        title: displayTitle(job.text),
        workMode: workModeFromValue(job.workplaceType),
      };
    });
}

function isPeoplePerHourUrl(url: URL): boolean {
  return ['peopleperhour.com', 'www.peopleperhour.com'].includes(
    url.hostname.toLowerCase(),
  );
}

function peoplePerHourIndexUrl(sourceUrl: URL): string {
  // The broad /freelance-jobs landing page mostly surfaces category navigation
  // to a generic scraper. The AI category is the stable public index for this
  // source's standing query and renders direct project cards server-side.
  if (/^\/freelance-jobs\/?$/i.test(sourceUrl.pathname)) {
    return new URL(
      '/freelance-jobs/artificial-intelligence',
      sourceUrl.origin,
    ).toString();
  }
  return sourceUrl.toString();
}

function remoteRocketshipExternalId(postingUrl: string): string {
  try {
    return new URL(postingUrl).pathname.split('/').filter(Boolean).join('/');
  } catch {
    return '';
  }
}

function extractRemoteRocketshipCandidates(
  html: string,
  baseUrl: URL,
): OpportunitySourceCandidate[] {
  const candidates: OpportunitySourceCandidate[] = [];
  const seen = new Set<string>();
  const jobLinkPattern =
    /<h3\b[^>]*>\s*<a\b[^>]*href=["'](?<href>\/company\/[^"'<>]+\/jobs\/[^"'<>]+)["'][^>]*>(?<title>[\s\S]*?)<\/a>\s*<\/h3>(?<after>[\s\S]{0,3000}?)(?=<h3\b|<\/article>|<\/li>|$)/gi;

  for (const match of html.matchAll(jobLinkPattern)) {
    const href = stringValue(match.groups?.href);
    const title = displayTitle(
      decodeHtmlEntities(htmlToPlainText(stringValue(match.groups?.title))),
    );
    if (!href || !title) continue;

    const postingUrl = new URL(href, baseUrl.origin).toString();
    if (seen.has(postingUrl)) continue;
    seen.add(postingUrl);

    const after = stringValue(match.groups?.after);
    const companyMatch = after.match(
      /<h4\b[^>]*>\s*<a\b[^>]*href=["']\/company\/[^"'<>]+["'][^>]*>([\s\S]*?)<\/a>\s*<\/h4>/i,
    );
    const companyName = displayTitle(
      decodeHtmlEntities(htmlToPlainText(companyMatch?.[1] ?? '')),
    );

    const textBlock = decodeHtmlEntities(htmlToPlainText(after));
    const remoteMatch = textBlock.match(/\b(Remote(?:\s*[-–—]\s*[^•|]+)?)/i);
    const locationNotes = displayTitle(remoteMatch?.[1] ?? 'Remote');

    candidates.push({
      canonicalUrl: postingUrl,
      companyName,
      externalId: remoteRocketshipExternalId(postingUrl),
      locationNotes,
      postingUrl,
      rawJson: { companyName, href, source: 'remoterocketship' },
      title,
      workMode: 'remote',
    });
  }

  return candidates;
}

export async function discoverRemoteRocketshipCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': browserSourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];

  return extractRemoteRocketshipCandidates(await response.text(), url);
}

function peoplePerHourExternalId(postingUrl: string): string {
  try {
    const slug = new URL(postingUrl).pathname.split('/').filter(Boolean).pop();
    return slug?.match(/-(\d+)$/)?.[1] ?? '';
  } catch {
    return '';
  }
}

function peoplePerHourRequestInit(): RequestInit {
  return {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      // PeoplePerHour's public SSR category pages can return a shell without
      // project cards to non-browser clients from some networks. Use ordinary
      // browser headers so the read-only crawler sees the same public listing
      // HTML as a human browser, without needing account/session cookies.
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    },
  };
}

function classifyPeoplePerHourBody(html: string): string {
  const text = html.toLowerCase();
  if (
    /captcha|cloudflare|verify you are human|access denied|forbidden/.test(text)
  ) {
    return 'challenge_or_blocked';
  }
  if (/item__url/.test(text)) return 'project_cards_html';
  if (/<script\b|id=["']__next|id=["']root|data-reactroot/.test(text)) {
    return 'app_shell_without_project_cards';
  }
  if (html.trim().length === 0) return 'empty_body';
  return 'html_without_project_cards';
}

function peoplePerHourFetchDiagnostic(options: {
  html: string;
  indexUrl: string;
  response: Response;
}): PeoplePerHourFetchDiagnostic {
  const contentType = options.response.headers.get('content-type') ?? '';
  const projectCardCount = Array.from(
    options.html.matchAll(/\bitem__url\b/gi),
  ).length;
  return {
    bodyShape: classifyPeoplePerHourBody(options.html),
    contentLength: options.html.length,
    contentType,
    finalUrl: stringValue(options.response.url) || options.indexUrl,
    hasProjectCardLinks: projectCardCount > 0,
    hasProjectDescriptions: /\bitem__desc\b/i.test(options.html),
    projectCardCount,
    status: options.response.status,
  };
}

function formatPeoplePerHourFetchDiagnostic(
  diagnostic: PeoplePerHourFetchDiagnostic,
): string {
  return [
    'PeoplePerHour fetch diagnostic',
    `status=${diagnostic.status}`,
    `finalUrl=${diagnostic.finalUrl}`,
    `contentType=${diagnostic.contentType || 'unknown'}`,
    `contentLength=${diagnostic.contentLength}`,
    `bodyShape=${diagnostic.bodyShape}`,
    `projectCardCount=${diagnostic.projectCardCount}`,
    `hasProjectCardLinks=${diagnostic.hasProjectCardLinks}`,
    `hasProjectDescriptions=${diagnostic.hasProjectDescriptions}`,
  ].join('; ');
}

async function diagnosePeoplePerHourCandidateFetch(
  source: SourceLike,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const url = sourceUrl(source);
  if (!url || !isPeoplePerHourUrl(url)) return null;

  const indexUrl = peoplePerHourIndexUrl(url);
  const response = await fetchImpl(indexUrl, peoplePerHourRequestInit());
  const html = await response.text();
  const diagnostic = peoplePerHourFetchDiagnostic({ html, indexUrl, response });
  const projects = extractPeoplePerHourProjects(html, new URL(indexUrl));
  const matchedProjects = projects.filter((project) =>
    candidateMatchesSource(source, `${project.title} ${project.description}`),
  ).length;
  if (matchedProjects > 0) return null;

  const base = formatPeoplePerHourFetchDiagnostic(diagnostic);
  const action =
    diagnostic.bodyShape === 'challenge_or_blocked' ||
    diagnostic.bodyShape === 'app_shell_without_project_cards'
      ? 'likely needs browser/sidecar crawler or browser-required/manual source status'
      : 'parser/query may need adjustment or source may have no matching public projects';
  return `${base}; extractedProjectCount=${projects.length}; matchedProjectCount=${matchedProjects}; ${action}.`;
}

function contraRequestInit(): RequestInit {
  return {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    },
  };
}

function classifyContraBody(html: string): string {
  const text = html.toLowerCase();
  if (
    /welcome back to contra|continue with google|authenticationrequired/.test(
      text,
    )
  ) {
    return 'login_required';
  }
  if (/captcha|verify you are human|access denied|forbidden/.test(text)) {
    return 'challenge_or_blocked';
  }
  if (/src_pages_opportunities|\/client\/opportunities|\/jobs/.test(text)) {
    return 'app_shell_without_listing_data';
  }
  if (html.trim().length === 0) return 'empty_body';
  return 'html_without_listing_data';
}

function contraFetchDiagnostic(options: {
  html: string;
  response: Response;
  url: string;
}): ContraFetchDiagnostic {
  return {
    bodyShape: classifyContraBody(options.html),
    contentLength: options.html.length,
    contentType: options.response.headers.get('content-type') ?? '',
    finalUrl: stringValue(options.response.url) || options.url,
    status: options.response.status,
  };
}

function formatContraFetchDiagnostic(
  diagnostic: ContraFetchDiagnostic,
): string {
  return [
    'Contra fetch diagnostic',
    `status=${diagnostic.status}`,
    `finalUrl=${diagnostic.finalUrl}`,
    `contentType=${diagnostic.contentType || 'unknown'}`,
    `contentLength=${diagnostic.contentLength}`,
    `bodyShape=${diagnostic.bodyShape}`,
  ].join('; ');
}

async function diagnoseContraCandidateFetch(
  source: SourceLike,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const url = sourceUrl(source);
  if (!url || !isContraUrl(url)) return null;

  const fetchUrl = url.toString();
  const response = await fetchImpl(fetchUrl, contraRequestInit());
  const html = await response.text();
  const diagnostic = contraFetchDiagnostic({ html, response, url: fetchUrl });
  if (diagnostic.bodyShape === 'html_without_listing_data') return null;

  const action =
    diagnostic.bodyShape === 'login_required'
      ? 'requires authenticated browser/session-backed crawler; server-side public fetch only receives the login page'
      : 'likely needs browser/sidecar crawler or manual source status';
  return `${formatContraFetchDiagnostic(diagnostic)}; ${action}.`;
}

function peoplePerHourResolvedDetail(
  project: PeoplePerHourProject,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  return {
    canonicalUrl: project.postingUrl,
    descriptionRaw: project.description,
    employmentType: 'contract',
    externalId: project.externalId,
    locationNotes: 'Remote contract marketplace',
    message: 'Loaded PeoplePerHour project card details.',
    provider: 'generic',
    qualifications: qualificationsFromDescription(project.description),
    status: 'resolved',
    title: project.title,
    workMode: 'remote',
  };
}

function extractPeoplePerHourProjects(
  html: string,
  baseUrl: URL,
): PeoplePerHourProject[] {
  const projects: PeoplePerHourProject[] = [];
  const seen = new Set<string>();
  const linkPattern =
    /<a\b[^>]*\bclass\s*=\s*(?:"[^"]*item__url[^"]*"|'[^']*item__url[^']*'|[^\s>]*item__url[^\s>]*)[^>]*>[\s\S]*?<\/a>/gi;

  for (const match of html.matchAll(linkPattern)) {
    const anchor = match[0] ?? '';
    const rawHref = htmlAttributeValue(anchor, 'href');
    if (!rawHref) continue;

    let postingUrl: string;
    try {
      postingUrl = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }

    const posting = new URL(postingUrl);
    if (!isPeoplePerHourUrl(posting)) continue;
    if (!/^\/freelance-jobs\/.+\/[^/]+-\d+\/?$/i.test(posting.pathname)) {
      continue;
    }
    if (seen.has(postingUrl)) continue;

    const title = displayTitle(
      decodeHtmlEntities(anchor.replace(/<[^>]+>/g, ' ')),
    );
    if (!title) continue;

    const afterAnchor = html.slice(match.index + anchor.length);
    const descriptionMatch = afterAnchor.match(
      /<p\b[^>]*\bclass\s*=\s*(?:"[^"]*item__desc[^"]*"|'[^']*item__desc[^']*'|[^\s>]*item__desc[^\s>]*)[^>]*>([\s\S]*?)<\/p>/i,
    );
    const description = displayTitle(
      decodeHtmlEntities(
        (descriptionMatch?.[1] ?? '').replace(/<[^>]+>/g, ' '),
      ),
    );
    if (!description) continue;

    seen.add(postingUrl);
    projects.push({
      description,
      externalId: peoplePerHourExternalId(postingUrl),
      postingUrl,
      title,
    });
  }

  return projects;
}

function peoplePerHourProjectsToCandidates(
  source: SourceLike,
  projects: PeoplePerHourProject[],
  fetchedVia: 'http' | 'spider',
): OpportunitySourceCandidate[] {
  return projects
    .filter((project) =>
      candidateMatchesSource(source, `${project.title} ${project.description}`),
    )
    .map((project) => {
      const detail = peoplePerHourResolvedDetail(project);
      return {
        canonicalUrl: project.postingUrl,
        companyName: 'PeoplePerHour client',
        employmentType: 'contract',
        externalId: project.externalId,
        locationNotes: detail.locationNotes,
        postingUrl: project.postingUrl,
        rawJson: { ...project, fetchedVia },
        resolvedDetail: detail,
        title: project.title,
        workMode: detail.workMode,
      };
    });
}

async function fetchPeoplePerHourProjectsWithSpider(
  indexUrl: string,
  spider: SpiderAdapter,
): Promise<PeoplePerHourProject[]> {
  try {
    const page = await spider.fetch(indexUrl, {
      cache: false,
      headers: peoplePerHourRequestInit().headers as Record<string, string>,
      timeout: 60000,
    });
    return extractPeoplePerHourProjects(
      page.content,
      new URL(page.url || indexUrl),
    );
  } catch {
    return [];
  }
}

export async function discoverPeoplePerHourCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
  spider?: SpiderAdapter,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url || !isPeoplePerHourUrl(url)) return [];

  const indexUrl = peoplePerHourIndexUrl(url);
  let httpProjects: PeoplePerHourProject[] = [];
  const response = await fetchImpl(indexUrl, peoplePerHourRequestInit());
  if (response.ok) {
    httpProjects = extractPeoplePerHourProjects(
      await response.text(),
      new URL(stringValue(response.url) || indexUrl),
    );
  }

  const httpCandidates = peoplePerHourProjectsToCandidates(
    source,
    httpProjects,
    'http',
  );
  if (httpCandidates.length > 0 || !spider) return httpCandidates;

  const spiderProjects = await fetchPeoplePerHourProjectsWithSpider(
    indexUrl,
    spider,
  );
  return peoplePerHourProjectsToCandidates(source, spiderProjects, 'spider');
}

function isCanonicalCareersUrl(value: unknown): boolean {
  return providerForUrl(value) === 'canonical-careers';
}

function isGeminiCareersUrl(value: unknown): boolean {
  if (value instanceof URL)
    return providerForUrl(value.toString()) === 'gemini-careers';
  return providerForUrl(value) === 'gemini-careers';
}

function extractGeminiCareersJobs(html: string): GeminiCareersJob[] {
  const normalized = decodeHtmlEntities(html)
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');
  const jobs: GeminiCareersJob[] = [];
  for (const match of normalized.matchAll(
    /"jobId":(?:(\d+)|"([^"]+)")\s*,\s*"jobBaseUrl":"([^"]*)"\s*,\s*"jobUrl":"([^"]*)"\s*,\s*"jobTitle":"([^"]*)"\s*,\s*"jobLocation":"([^"]*)"/g,
  )) {
    jobs.push({
      jobBaseUrl: match[3] ?? '',
      jobId: match[1] ?? match[2] ?? '',
      jobLocation: match[6] ?? '',
      jobTitle: match[5] ?? '',
      jobUrl: match[4] ?? '',
    });
  }
  return jobs;
}

function geminiResolvedDetail(
  job: GeminiCareersJob,
  postingUrl: string,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const title = displayTitle(job.jobTitle);
  const locationNotes = stringValue(job.jobLocation);
  const descriptionRaw = [title, locationNotes, 'Gemini careers posting']
    .filter(Boolean)
    .join('\n\n');
  return {
    canonicalUrl: postingUrl,
    descriptionRaw,
    externalId: stringValue(job.jobId),
    locationNotes,
    message: 'Loaded Gemini careers posting from embedded careers payload.',
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title,
    workMode: workModeFromValue(locationNotes),
  };
}

export async function discoverGeminiCareersCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url || !isGeminiCareersUrl(url)) return [];

  const response = await fetchImpl(new URL('/careers', url).toString(), {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];

  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const job of extractGeminiCareersJobs(await response.text())) {
    const title = displayTitle(job.jobTitle);
    const rawUrl = stringValue(job.jobUrl || job.jobBaseUrl);
    if (!title || !rawUrl) continue;
    const postingUrl = new URL(rawUrl, 'https://www.gemini.com').toString();
    if (seen.has(postingUrl)) continue;
    if (!candidateMatchesSource(source, `${title} ${job.jobLocation}`))
      continue;
    const detail = geminiResolvedDetail(job, postingUrl);
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      companyName: 'Gemini',
      externalId: detail.externalId,
      locationNotes: detail.locationNotes,
      postingUrl,
      rawJson: job,
      resolvedDetail: detail,
      title,
      workMode: detail.workMode,
    });
  }
  return candidates;
}

function canonicalResolvedDetail(
  vacancy: CanonicalVacancy,
  canonicalUrl: string,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const descriptionParts = [
    stringValue(vacancy.description),
    Array.isArray(vacancy.departments) && vacancy.departments.length
      ? `Departments: ${vacancy.departments.join(', ')}`
      : '',
    Array.isArray(vacancy.skills) && vacancy.skills.length
      ? `Skills: ${vacancy.skills.join(', ')}`
      : '',
  ].filter(Boolean);
  const descriptionRaw = descriptionParts.join('\n\n');
  return {
    canonicalUrl,
    descriptionRaw,
    employmentType: employmentTypeFromValue(vacancy.employment),
    externalId: stringValue(vacancy.id),
    locationNotes: stringValue(vacancy.location),
    message: 'Loaded Canonical careers posting details.',
    postedAt: parseDate(vacancy.date),
    provider: 'generic',
    qualifications: Array.isArray(vacancy.skills)
      ? vacancy.skills
          .map((skill) => displayTitle(skill))
          .filter(Boolean)
          .join('\n')
      : qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: displayTitle(vacancy.title),
    workMode: workModeFromValue(vacancy.location),
  };
}

export async function discoverCanonicalCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];

  const vacancies = extractJsonValue<CanonicalVacancy[]>(
    await response.text(),
    'const vacancies =',
    '[',
  );
  if (!Array.isArray(vacancies)) return [];

  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const vacancy of vacancies) {
    const postingUrl = stringValue(vacancy.url);
    const title = displayTitle(vacancy.title);
    if (!postingUrl || !title || seen.has(postingUrl)) continue;
    seen.add(postingUrl);
    const detail = canonicalResolvedDetail(vacancy, postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      companyName: 'Canonical',
      employmentType: detail.employmentType,
      externalId: detail.externalId,
      locationNotes: detail.locationNotes,
      postedAt: detail.postedAt,
      postingUrl,
      rawJson: vacancy,
      resolvedDetail: detail,
      title,
      workMode: detail.workMode,
    });
  }
  return candidates;
}

function linkText(link: Link): string {
  return displayTitle(link.text || link.title || link.ariaLabel);
}

function htmlAttributeValue(tag: string, name: string): string {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function addProviderLink(
  links: Link[],
  rawHref: string,
  baseUrl: URL,
  metadata: Partial<Link> = {},
): void {
  if (!rawHref) return;

  let href: string;
  try {
    href = new URL(rawHref, baseUrl).toString();
  } catch {
    return;
  }

  if (!isDiscoverableProviderPostingUrl(href)) return;
  links.push({ ...metadata, href } as Link);
}

function ashbyPostingApiBoardSlugFromHtml(html: string, baseUrl: URL): string {
  const apiMatch = html.match(
    /https?:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^"'<>\\s)]+)/i,
  );
  if (apiMatch?.[1]) {
    try {
      return decodeURIComponent(apiMatch[1].replace(/\u0026.*$/i, ''));
    } catch {
      return apiMatch[1];
    }
  }

  if (
    (baseUrl.hostname === 'zapier.com' ||
      baseUrl.hostname === 'www.zapier.com') &&
    /^\/jobs\/?$/i.test(baseUrl.pathname) &&
    /"useAshbyData"\s*:\s*true/i.test(html)
  ) {
    return 'zapier';
  }

  return '';
}

function providerLinksFromHtml(html: string, baseUrl: URL): Link[] {
  const links: Link[] = [];
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi,
  )) {
    const tag = match[0] ?? '';
    addProviderLink(links, htmlAttributeValue(tag, 'href'), baseUrl, {
      ariaLabel: htmlAttributeValue(tag, 'aria-label'),
      title: htmlAttributeValue(tag, 'title'),
    });
  }

  // Some static/React careers pages keep ATS posting URLs only in embedded JSON
  // strings rather than rendered anchors. Capture those raw provider URLs so a
  // generic company page can hand off to the Ashby/Greenhouse/Lever resolvers.
  for (const match of html.matchAll(/https?:\/\/[^"'<>\\\s)]+/gi)) {
    addProviderLink(
      links,
      decodeHtmlEntities(match[0] ?? '').replace(/\\u0026/gi, '&'),
      baseUrl,
    );
  }

  return links;
}

function isProviderBoardLandingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'jobs.ashbyhq.com') return pathParts.length === 1;
    if (url.hostname === 'jobs.lever.co') return pathParts.length === 1;
    if (url.hostname.endsWith('greenhouse.io')) {
      if (url.pathname.includes('/job_app')) return false;
      return !pathParts.includes('jobs') && !url.searchParams.has('token');
    }
  } catch {
    return false;
  }
  return false;
}

function hackerNewsCompanyName(text: string): string {
  return displayTitle(text.split(/\s+\|\s+|\s+[–—-]\s+/)[0]);
}

function hackerNewsResolvedDetail(
  href: string,
  title: string,
  text: string,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  return {
    canonicalUrl: href,
    descriptionRaw: text,
    locationNotes: '',
    message: 'Loaded Hacker News listing text for provider board URL.',
    provider: 'generic',
    qualifications: qualificationsFromDescription(text),
    status: 'resolved',
    title,
    workMode: workModeFromValue(text),
  };
}

async function fetchProviderLinksFromHtml(url: URL): Promise<Link[]> {
  try {
    const response = await fetch(url.toString(), {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': sourceCrawlerUserAgent(),
      },
    });
    if (!response.ok) return [];
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('html')) return [];
    return providerLinksFromHtml(await response.text(), url);
  } catch {
    return [];
  }
}

export async function discoverGenericProviderLinks(
  source: SourceLike,
  spider?: SpiderAdapter,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const activeSpider = spider ?? (await getDefaultSpider());
  let page: Awaited<ReturnType<SpiderAdapter['fetch']>>;
  try {
    page = await activeSpider.fetch(url.toString(), {
      cache: true,
      cacheExpiry: 60 * 60 * 1000,
      timeout: 60000,
    });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];

  const pageHtmlLinks = providerLinksFromHtml(page.content, url);
  const pageLinkHasProviderPosting = page.links.some((link) => {
    const href = stringValue(link.href);
    if (!href) return false;
    try {
      return isDiscoverableProviderPostingUrl(new URL(href, url).toString());
    } catch {
      return false;
    }
  });
  const directHtmlLinks =
    pageLinkHasProviderPosting || pageHtmlLinks.length
      ? []
      : await fetchProviderLinksFromHtml(url);

  const ashbyApiBoardSlug = ashbyPostingApiBoardSlugFromHtml(page.content, url);
  if (ashbyApiBoardSlug) {
    const data = await fetchJson<AshbyPostingApiResponse>(
      fetchImpl,
      ashbyPostingApiUrl(ashbyApiBoardSlug),
    );
    for (const candidate of ashbyCandidatesFromJobs(
      ashbyApiBoardSlug,
      data?.jobs ?? [],
    )) {
      const href = stringValue(candidate.postingUrl || candidate.canonicalUrl);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      candidates.push(candidate);
    }
  }

  for (const link of [...page.links, ...pageHtmlLinks, ...directHtmlLinks]) {
    const rawHref = stringValue(link.href);
    if (!rawHref) continue;

    let href: string;
    try {
      href = new URL(rawHref, url).toString();
    } catch {
      continue;
    }

    if (seen.has(href)) continue;
    if (!isDiscoverableProviderPostingUrl(href)) continue;

    const title = linkText(link);
    seen.add(href);
    candidates.push({
      postingUrl: href,
      rawJson: link,
      title,
    });
  }

  return candidates;
}

function isHackerNewsWhoIsHiringUrl(url: URL): boolean {
  return (
    url.hostname === 'news.ycombinator.com' &&
    url.pathname === '/submitted' &&
    url.searchParams.get('id') === 'whoishiring'
  );
}

function isHackerNewsDisplayTruncatedUrl(value: string): boolean {
  return /(?:\.\.\.|%E2%80%A6)$/i.test(value);
}

function hackerNewsAlgoliaUrl(path: string): string {
  return new URL(path, 'https://hn.algolia.com').toString();
}

async function latestWhoIsHiringItem(
  fetchImpl: FetchLike,
): Promise<HackerNewsAlgoliaItem | null> {
  const search = await fetchJson<HackerNewsAlgoliaSearchResponse>(
    fetchImpl,
    hackerNewsAlgoliaUrl(
      '/api/v1/search_by_date?tags=story,author_whoishiring&query=Who%20is%20hiring',
    ),
  );
  const latestId = search?.hits
    ?.filter((hit) => /who is hiring/i.test(stringValue(hit.title)))
    .map((hit) => stringValue(hit.objectID))
    .find(Boolean);
  if (!latestId) return null;
  return await fetchJson<HackerNewsAlgoliaItem>(
    fetchImpl,
    hackerNewsAlgoliaUrl(`/api/v1/items/${encodeURIComponent(latestId)}`),
  );
}

function collectHackerNewsProviderLinks(
  item: HackerNewsAlgoliaItem,
  source: SourceLike,
  seen = new Set<string>(),
): OpportunitySourceCandidate[] {
  const candidates: OpportunitySourceCandidate[] = [];
  const html = stringValue(item.text);
  const text = htmlToPlainText(decodeHtmlEntities(html));
  if (html && candidateMatchesSource(source, text)) {
    for (const link of providerLinksFromHtml(
      decodeHtmlEntities(html),
      new URL('https://news.ycombinator.com/'),
    )) {
      const href = stringValue(link.href);
      // HN comments can contain a full URL in the anchor href and a visibly
      // truncated copy in the anchor text. providerLinksFromHtml intentionally
      // collects both forms for generic pages; here the visible `...` variant
      // must never become a posting URL or crawl provenance.
      if (!href || isHackerNewsDisplayTruncatedUrl(href) || seen.has(href)) {
        continue;
      }
      const companyName = hackerNewsCompanyName(text);
      const title = linkText(link) || companyName || href;
      const resolvedDetail = isProviderBoardLandingUrl(href)
        ? hackerNewsResolvedDetail(href, title, text)
        : undefined;
      seen.add(href);
      candidates.push({
        companyName,
        diagnosticContext: `hacker-news item ${stringValue(item.id) || 'unknown'}`,
        postingUrl: href,
        rawJson: {
          hackerNewsItemId: item.id,
          href,
          text,
        },
        resolvedDetail,
        title,
      });
    }
  }

  for (const child of item.children ?? []) {
    candidates.push(...collectHackerNewsProviderLinks(child, source, seen));
  }
  return candidates;
}

async function discoverLatestWhoIsHiringCandidates(
  source: SourceLike,
  fetchImpl: FetchLike,
): Promise<OpportunitySourceCandidate[]> {
  try {
    const item = await latestWhoIsHiringItem(fetchImpl);
    return item ? collectHackerNewsProviderLinks(item, source) : [];
  } catch {
    return [];
  }
}

export async function discoverHackerNewsJobsCandidates(
  source: SourceLike,
  spider?: SpiderAdapter,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  if (isHackerNewsWhoIsHiringUrl(url)) {
    return await discoverLatestWhoIsHiringCandidates(source, fetchImpl);
  }

  const activeSpider = spider ?? (await getDefaultSpider());
  let page: Awaited<ReturnType<SpiderAdapter['fetch']>>;
  try {
    page = await activeSpider.fetch(url.toString(), {
      cache: true,
      cacheExpiry: 60 * 60 * 1000,
      timeout: 60000,
    });
  } catch {
    return await discoverLatestWhoIsHiringCandidates(source, fetchImpl);
  }

  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const link of page.links) {
    const rawHref = stringValue(link.href);
    const title = linkText(link);
    if (!rawHref || !title) continue;

    let href: string;
    try {
      href = new URL(rawHref, url).toString();
    } catch {
      continue;
    }

    if (seen.has(href)) continue;
    if (!isDiscoverableProviderPostingUrl(href)) continue;
    seen.add(href);
    candidates.push({ postingUrl: href, rawJson: link, title });
  }

  if (candidates.length === 0) {
    return await discoverLatestWhoIsHiringCandidates(source, fetchImpl);
  }

  return candidates;
}

// Generic careers pages have no provider API, so scrape the page for links and
// keep the ones that look like individual job postings. Unlike
// discoverGenericProviderLinks (which only follows recognized ATS boards), this
// surfaces direct postings on a company's own careers page. Candidates carry no
// resolvedDetail, so the crawl loop resolves and relevance-filters them.
const GENERIC_POSTING_URL_NEEDLES = [
  '/job/',
  '/jobs/',
  '/remote-jobs/details/',
  '/job-',
  '/careers/',
  '/career/',
  '/position',
  '/opening',
  '/vacanc',
  '/apply',
];
const GENERIC_POSTING_EXCLUDES = [
  'mailto:',
  'tel:',
  'javascript:',
  '/career-services/',
  '/job-seekers/',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  '/privacy',
  '/terms',
  '/cookie',
];
const GENERIC_NAV_LINK_CLASS_MARKERS = [
  'breadcrumb',
  'pagination',
  'tag',
  'category',
  'filter',
  'facet',
];
const GENERIC_NAV_PATH_LEAVES = new Set([
  'belonging',
  'benefits',
  'career',
  'careers',
  'code-of-conduct',
  'commitment-to-applicants',
  'culture',
  'culture-and-values',
  'culture-and-values-at-zapier',
  'how-we-work',
  'interview-guide',
  'our-commitment-to-applicants',
  'job-descriptions',
  'job-skills',
  'locations',
  'people',
  'teams',
  'total-rewards',
  'values',
  'web3-experts',
  'working-on-diversity-and-inclusivity',
  'zapier-code-of-conduct',
]);

function linkClassText(link: Link): string {
  const classes = Array.isArray(link.classes) ? link.classes.join(' ') : '';
  return normalizeText(classes);
}

function isLikelyGenericNavigationLink(link: Link): boolean {
  const classTokens = linkClassText(link).split(' ').filter(Boolean);
  if (classTokens.length === 0) return false;
  return GENERIC_NAV_LINK_CLASS_MARKERS.some((marker) =>
    classTokens.some((token) => token === marker || token.startsWith(marker)),
  );
}

function isRemoteRocketshipUrl(value: unknown): boolean {
  try {
    const url = new URL(stringValue(value));
    return (
      url.hostname === 'www.remoterocketship.com' ||
      url.hostname === 'remoterocketship.com'
    );
  } catch {
    return false;
  }
}

const REMOTE_ROCKETSHIP_TARGET_TERMS = new Set([
  'ai',
  'agent',
  'agentic',
  'backend',
  'canada',
  'devops',
  'distributed',
  'founding',
  'infrastructure',
  'kubernetes',
  'platform',
  'principal',
  'senior',
  'staff',
  'systems',
]);

function remoteRocketshipCandidateMatchesSource(
  source: SourceLike,
  link: Link,
  href: string,
): boolean {
  if (!isRemoteRocketshipUrl(source.url) || !isRemoteRocketshipUrl(href)) {
    return true;
  }

  // Remote Rocketship's homepage emits a full firehose of recent remote jobs;
  // the URL path is a useful posting shape but not a relevance signal. Apply the
  // source query before resolution so unrelated generic listings do not become
  // dozens of not_found crawl items. The global matcher intentionally treats
  // broad words like "engineer" and "data" as technical enough for company
  // boards; for Remote Rocketship's firehose, require at least one of this
  // source's high-intent terms as well.
  const title = normalizeText(linkText(link));
  if (!title || title === 'apply') return false;
  if (
    /\b(asesor|call center|callcenter|clerk|customer service|ventas)\b/.test(
      title,
    )
  ) {
    return false;
  }
  const text = normalizeText([title, href].join(' '));
  if (!candidateMatchesSource(source, text)) return false;
  const words = text.split(' ').filter(Boolean);
  return words.some((word) => REMOTE_ROCKETSHIP_TARGET_TERMS.has(word));
}

function isLikelyGenericPostingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const leaf = pathSegments[pathSegments.length - 1]?.toLowerCase() ?? '';
    if (GENERIC_NAV_PATH_LEAVES.has(leaf)) return false;
    if (
      (url.hostname === 'www.guru.com' || url.hostname === 'guru.com') &&
      !/^\/jobs\/[^/]+\/\d+/.test(url.pathname)
    ) {
      return false;
    }
    if (
      (url.hostname === 'builtin.com' ||
        url.hostname.endsWith('.builtin.com')) &&
      !/^\/job\/[^/]+\/\d+\/?$/.test(url.pathname)
    ) {
      return false;
    }
    if (
      (url.hostname === 'www.remoterocketship.com' ||
        url.hostname === 'remoterocketship.com') &&
      !/^\/company\/[^/]+\/jobs\/[^/]+\/?$/.test(url.pathname)
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

export async function discoverGenericPostingLinks(
  source: SourceLike,
  ctx: AdapterContext,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const indexHref = url.toString();
  let result: Awaited<ReturnType<AdapterContext['scrapeIndex']>>;
  try {
    result = await ctx.scrapeIndex(indexHref);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];

  for (const link of filterLinks(result.links, {
    urlContains: GENERIC_POSTING_URL_NEEDLES,
    excludes: GENERIC_POSTING_EXCLUDES,
  })) {
    const rawHref = stringValue(link.href);
    // Skip the index page itself, recognized ATS links (the provider path owns
    // those), obvious navigation/facet links, and anything that isn't a real
    // posting URL. Generic boards such as Freelancer expose pagination,
    // breadcrumbs, and skill/tag facets under /jobs/*; resolving those as
    // candidates turns a crawl into hundreds of unsupported noise items.
    if (!rawHref) continue;

    let href: string;
    try {
      href = new URL(rawHref, indexHref).toString();
      const candidateUrl = new URL(href);
      if (urlsPointToSamePage(candidateUrl, url)) {
        continue;
      }
    } catch {
      continue;
    }
    if (href === indexHref || seen.has(href)) continue;
    const provider = providerForUrl(href);
    if (provider !== 'generic' && provider !== 'remoterocketship') continue;
    if (isLikelyGenericNavigationLink(link)) continue;
    if (!isLikelyGenericPostingUrl(href)) continue;
    if (!isApplyableJobUrl(href)) continue;

    const title = linkText(link);
    if (!title) continue;
    if (!remoteRocketshipCandidateMatchesSource(source, link, href)) continue;
    seen.add(href);
    candidates.push({ postingUrl: href, rawJson: link, title });
  }

  return candidates;
}

function dedupeCandidatesByUrl(
  candidates: OpportunitySourceCandidate[],
): OpportunitySourceCandidate[] {
  const seen = new Set<string>();
  const result: OpportunitySourceCandidate[] = [];
  for (const candidate of candidates) {
    const key = stringValue(candidate.postingUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function isWellfoundJobUrl(value: string): boolean {
  try {
    const url = new URL(value, 'https://wellfound.com');
    if (
      url.hostname !== 'wellfound.com' &&
      url.hostname !== 'www.wellfound.com'
    ) {
      return false;
    }
    const path = url.pathname.replace(/\/+$/g, '');
    return (
      /^\/jobs\/[^/]+/i.test(path) ||
      /^\/company\/[^/]+\/jobs\/[^/]+/i.test(path)
    );
  } catch {
    return false;
  }
}

export async function discoverWellfoundCandidates(
  source: SourceLike,
  spider?: SpiderAdapter,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const activeSpider = spider ?? (await getDefaultSpider());
  let page: Awaited<ReturnType<SpiderAdapter['fetch']>>;
  try {
    page = await activeSpider.fetch(url.toString(), {
      cache: true,
      cacheExpiry: 60 * 60 * 1000,
      timeout: 60000,
    });
  } catch {
    page = await activeSpider.fetch(url.toString(), {
      cache: false,
      timeout: 60000,
    });
  }

  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const link of page.links) {
    const rawHref = stringValue(link.href);
    const title = displayTitle(linkText(link));
    if (!rawHref || !title || title.toLowerCase() === 'apply') continue;

    let postingUrl: string;
    try {
      postingUrl = new URL(rawHref, url).toString();
    } catch {
      continue;
    }
    if (seen.has(postingUrl) || !isWellfoundJobUrl(postingUrl)) continue;
    if (!candidateMatchesSource(source, title)) continue;

    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      postingUrl,
      rawJson: link,
      resolvedDetail: {
        canonicalUrl: postingUrl,
        descriptionRaw: title,
        locationNotes: '',
        message: 'Loaded Wellfound listing from spider index page.',
        provider: 'generic',
        qualifications: qualificationsFromDescription(title),
        status: 'resolved',
        title,
        workMode: workModeFromValue(title),
      },
      title,
    });
  }

  return candidates;
}

function normalizedUrlPathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/g, '');
  return normalized || '/';
}

function urlsPointToSamePage(left: URL, right: URL): boolean {
  return (
    left.origin === right.origin &&
    normalizedUrlPathname(left.pathname) ===
      normalizedUrlPathname(right.pathname) &&
    left.search === right.search
  );
}

// Per-source seam passed to adapters via AdapterSource.config: the legacy
// discover* helpers predate the engine and take their own fetch/spider, so we
// thread the test-injected (and prod-default) implementations through here.
export interface JobBoardSource extends AdapterSource {
  searchQuery?: unknown;
  config?: {
    fetchImpl?: FetchLike;
    spider?: SpiderAdapter;
  };
}

export async function discoverYcCandidates(
  source: SourceLike,
  spider?: SpiderAdapter,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const activeSpider = spider ?? (await getDefaultSpider());
  let page: Awaited<ReturnType<SpiderAdapter['fetch']>>;
  try {
    page = await activeSpider.fetch(url.toString(), {
      cache: true,
      cacheExpiry: 60 * 60 * 1000,
      timeout: 60000,
    });
  } catch {
    page = await activeSpider.fetch(url.toString(), {
      cache: false,
      timeout: 60000,
    });
  }
  const decoded = decodeHtmlEntities(page.content);
  const jobs =
    extractJsonValue<YcBoardJob[]>(decoded, '"jobPostings":', '[') ?? [];
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const job of jobs) {
    const rawUrl = stringValue(job.url);
    const title = displayTitle(job.title);
    if (!rawUrl || !title) continue;
    const postingUrl = new URL(
      rawUrl,
      'https://www.ycombinator.com',
    ).toString();
    if (seen.has(postingUrl)) continue;
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      companyName: stringValue(job.companyName),
      employmentType: employmentTypeFromValue(job.type),
      externalId: stringValue(job.id),
      locationNotes: stringValue(job.location),
      postingUrl,
      rawJson: job,
      title,
      workMode: workModeFromValue(job.location),
    });
  }
  return candidates;
}

function extractA16zPortfolioSession(
  html: string,
  headers: Headers,
): A16zPortfolioSession | null {
  const data = extractJsonValue<{
    board?: A16zPortfolioBoard;
    csrfToken?: unknown;
  }>(html, 'window.serverInitialData =', '{');
  if (!data?.board?.id) return null;

  const cookieHeaders = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.() ?? [headers.get('set-cookie') ?? ''];
  const cookie = cookieHeaders
    .map((value) => value.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
    .join('; ');

  return {
    board: data.board,
    cookie,
    csrfToken: stringValue(data.csrfToken),
  };
}

async function fetchA16zPortfolioSearch(
  fetchImpl: FetchLike,
  session: A16zPortfolioSession,
  query: string,
): Promise<A16zPortfolioJob[]> {
  const response = await fetchImpl(
    'https://jobs.a16z.com/api-boards/search-jobs',
    {
      body: JSON.stringify({
        board: session.board,
        grouped: false,
        meta: { size: 50 },
        query: query ? { keywords: query } : {},
      }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': sourceCrawlerUserAgent(),
        ...(session.cookie ? { Cookie: session.cookie } : {}),
        ...(session.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : {}),
      },
      method: 'POST',
    },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as A16zPortfolioSearchResponse;
  return payload.jobs ?? [];
}

export async function discoverA16zPortfolioCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];

  const landingUrl =
    url.hostname === 'a16z.com' ? 'https://jobs.a16z.com/jobs' : url.toString();
  const response = await fetchImpl(landingUrl, {
    headers: { 'User-Agent': sourceCrawlerUserAgent() },
  });
  if (!response.ok) return [];
  const session = extractA16zPortfolioSession(
    await response.text(),
    response.headers,
  );
  if (!session) return [];

  const jobs = await fetchA16zPortfolioSearch(
    fetchImpl,
    session,
    stringValue(source.searchQuery),
  );
  const seen = new Set<string>();
  return jobs.flatMap((job) => {
    const title = displayTitle(job.title);
    const postingUrl = stringValue(job.url || job.applyUrl).replace(
      /\?utm_source=jobs\.a16z\.com$/,
      '',
    );
    if (!title || !postingUrl || seen.has(postingUrl)) return [];
    seen.add(postingUrl);
    const locationNotes = (job.locations ?? [])
      .map(stringValue)
      .filter(Boolean)
      .join(' / ');
    return [
      {
        canonicalUrl: postingUrl,
        companyName: stringValue(job.companyName),
        employmentType: employmentTypeFromValue(
          (job.jobTypes ?? [])
            .map((type) => type.label || type.value)
            .join(' '),
        ),
        externalId: stringValue(job.id || postingUrl),
        locationNotes,
        postedAt: parseDate(job.publishedAt),
        postingUrl,
        rawJson: job,
        title,
        workMode: workModeFromValue(locationNotes),
      },
    ];
  });
}

function extractAppleHydrationData(
  html: string,
): Record<string, unknown> | null {
  const match = html.match(
    /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/,
  );
  if (!match?.[1]) return null;
  try {
    return JSON.parse(JSON.parse(`"${match[1]}"`)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function appleSearchUrl(source: SourceLike): string {
  const raw = stringValue(source.url) || 'https://jobs.apple.com/en-us/search';
  const url = new URL(raw);
  if (!url.searchParams.get('search')) {
    const query = stringValue(source.searchQuery);
    if (query) url.searchParams.set('search', query);
  }
  return url.toString();
}

function appleLocation(location: AppleCareersJob['locations']): string {
  const first = Array.isArray(location) ? location[0] : null;
  if (!first) return '';
  const city = stringValue(first.city || first.name);
  const state = stringValue(first.stateProvince);
  const country = stringValue(first.countryName);
  return [city, state, country]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(', ');
}

function applePostingUrl(job: AppleCareersJob, baseUrl: string): string {
  const jobNumber = stringValue(job.jobNumber || job.id || job.positionId);
  if (!jobNumber) return '';
  const slug =
    stringValue(job.transformedPostingTitle) ||
    normalizeText(job.postingTitle).replace(/\s+/g, '-');
  return new URL(
    `/en-us/details/${encodeURIComponent(jobNumber)}${slug ? `/${slug}` : ''}`,
    baseUrl,
  ).toString();
}

function extractAppleSearchJobs(html: string): AppleCareersJob[] {
  const data = extractAppleHydrationData(html);
  const loaderData = data?.loaderData;
  if (!loaderData || typeof loaderData !== 'object') return [];
  const search = (loaderData as Record<string, unknown>).search;
  if (!search || typeof search !== 'object') return [];
  const searchResults = (search as Record<string, unknown>).searchResults;
  return Array.isArray(searchResults)
    ? (searchResults as AppleCareersJob[])
    : [];
}

export async function discoverAppleCareersCandidates(
  source: SourceLike,
  spider?: SpiderAdapter,
): Promise<OpportunitySourceCandidate[]> {
  const activeSpider = spider ?? (await getDefaultSpider());
  const searchUrl = appleSearchUrl(source);
  let page: Awaited<ReturnType<SpiderAdapter['fetch']>>;
  try {
    page = await activeSpider.fetch(searchUrl, {
      cache: true,
      cacheExpiry: 60 * 60 * 1000,
      timeout: 60000,
    });
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const job of extractAppleSearchJobs(page.content)) {
    const title = displayTitle(job.postingTitle);
    const postingUrl = applePostingUrl(job, searchUrl);
    if (!title || !postingUrl || seen.has(postingUrl)) continue;
    seen.add(postingUrl);
    const location = appleLocation(job.locations);
    candidates.push({
      canonicalUrl: postingUrl,
      companyName: 'Apple',
      externalId: stringValue(job.jobNumber || job.id || job.positionId),
      locationNotes: location,
      postedAt: parseDate(job.postingDate),
      postingUrl,
      rawJson: job,
      title,
      workMode: workModeFromValue(location),
    });
  }
  return candidates;
}

function googleCareersSearchUrl(source: SourceLike): string {
  const raw =
    stringValue(source.url) ||
    'https://www.google.com/about/careers/applications/jobs/results/';
  const url = new URL(raw);
  if (!url.searchParams.get('q')) {
    const query = stringValue(source.searchQuery);
    if (query) url.searchParams.set('q', query);
  }
  return url.toString();
}

function extractGoogleCareersJobs(html: string): GoogleCareersJob[] {
  const jobs: GoogleCareersJob[] = [];
  const seen = new Set<string>();
  const hrefById = new Map<string, string>();
  for (const hrefMatch of html.matchAll(
    /href=["']([^"']*jobs\/results\/(\d+)[^"']*)["']/gi,
  )) {
    const href = decodeHtmlEntities(hrefMatch[1] ?? '');
    const id = hrefMatch[2] ?? '';
    if (href && id && !hrefById.has(id)) hrefById.set(id, href);
  }

  for (const match of html.matchAll(
    /<li\b[^>]*class=["'][^"']*\blLd3Je\b[^"']*["'][^>]*ssk=["']\d+:(\d+)["'][^>]*>[\s\S]*?<\/li>/gi,
  )) {
    const block = match[0] ?? '';
    const id = match[1] ?? '';
    const title = displayTitle(
      htmlToPlainText(
        block.match(
          /<h3\b[^>]*class=["'][^"']*\bQJPWVe\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i,
        )?.[1] ??
          block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ??
          '',
      ),
    );
    const href = hrefById.get(id) ?? '';
    if (!title || !href) continue;
    const url = new URL(
      href,
      'https://www.google.com/about/careers/applications/',
    ).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const location = displayTitle(
      htmlToPlainText(
        block.match(
          /<span\b[^>]*class=["'][^"']*\br0wTof\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
        )?.[1] ?? '',
      ),
    );
    jobs.push({
      id,
      location,
      title,
      url,
    });
  }
  return jobs;
}

export async function discoverGoogleCareersCandidates(
  source: SourceLike,
  spider?: SpiderAdapter,
): Promise<OpportunitySourceCandidate[]> {
  const activeSpider = spider ?? (await getDefaultSpider());
  let page: Awaited<ReturnType<SpiderAdapter['fetch']>>;
  try {
    page = await activeSpider.fetch(googleCareersSearchUrl(source), {
      cache: true,
      cacheExpiry: 60 * 60 * 1000,
      timeout: 60000,
    });
  } catch {
    return [];
  }

  return extractGoogleCareersJobs(decodeHtmlEntities(page.content)).map(
    (job) => ({
      canonicalUrl: job.url,
      companyName: 'Google',
      externalId: job.id,
      locationNotes: job.location,
      postingUrl: job.url,
      rawJson: job,
      title: job.title,
      workMode: workModeFromValue(job.location),
    }),
  );
}

const REMOTE_OK_API_URL = 'https://remoteok.com/api';
const REMOTE_OK_MAX_CANDIDATES = 50;
const FREELANCER_PROJECTS_API_URL =
  'https://www.freelancer.com/api/projects/0.1/projects/active/';
// Freelancer queries can fan out across OR terms; keep the crawler batch small
// enough that per-opportunity enrichment timeouts cannot leave scheduled crawls
// running for hours.
const FREELANCER_MAX_CANDIDATES = 10;
const REMOTIVE_API_URL = 'https://remotive.com/api/remote-jobs';
const REMOTIVE_MAX_CANDIDATES = 50;
const WORKING_NOMADS_API_URL =
  'https://www.workingnomads.com/api/exposed_jobs/';
const WORKING_NOMADS_MAX_CANDIDATES = 50;

const REMOTE_OK_ENGINEERING_TITLE_RE =
  /\b(backend|devops|developer|engineer|engineering|full[-\s]?stack|infrastructure|platform|reliability|site reliability|software|sre|systems?)\b/i;

function remoteOkTitleMatchesEngineeringRole(title: string): boolean {
  return REMOTE_OK_ENGINEERING_TITLE_RE.test(title);
}

function remoteOkApiUrl(source: SourceLike): string {
  const url = sourceUrl(source);
  if (!url) return REMOTE_OK_API_URL;
  if (url.hostname !== 'remoteok.com' && url.hostname !== 'www.remoteok.com') {
    return REMOTE_OK_API_URL;
  }
  if (url.pathname === '/api') return url.toString();
  const pathname = url.pathname.replace(/\/$/u, '');
  if (!pathname) return REMOTE_OK_API_URL;
  url.pathname = `${pathname.replace(/\.json$/iu, '')}.json`;
  url.search = '';
  return url.toString();
}

function remoteOkPostingUrl(job: RemoteOkJob): string {
  const rawUrl = stringValue(job.url);
  if (rawUrl) return new URL(rawUrl, 'https://remoteok.com').toString();
  const slug = stringValue(job.slug);
  if (slug) return `https://remoteok.com/remote-jobs/${slug}`;
  const id = stringValue(job.id);
  return id ? `https://remoteok.com/remote-jobs/${id}` : '';
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = stringValue(value).replace(/[^\d.]/g, '');
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function freelancerQueryTerms(source: SourceLike): string[] {
  const query = stringValue(source.searchQuery);
  if (!query) return [''];
  const terms = query
    .split(/\s+\bOR\b\s+|[,;]+/iu)
    .map((term) => term.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  return terms.length > 1 ? terms : [query];
}

function freelancerSearchUrl(
  source: SourceLike,
  queryOverride?: string,
): string {
  const url = new URL(FREELANCER_PROJECTS_API_URL);
  url.searchParams.set('limit', String(FREELANCER_MAX_CANDIDATES));
  url.searchParams.set('full_description', 'true');
  url.searchParams.set('job_details', 'true');
  const query = stringValue(queryOverride ?? source.searchQuery);
  if (query) url.searchParams.set('query', query);
  return url.toString();
}

function freelancerProjectUrl(project: FreelancerProject): string {
  const seoUrl = stringValue(project.seo_url);
  if (seoUrl) return `https://www.freelancer.com/projects/${seoUrl}`;
  const id = stringValue(project.id);
  return id ? `https://www.freelancer.com/projects/${id}` : '';
}

function freelancerResolvedDetail(
  project: FreelancerProject,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const descriptionRaw = stringValue(
    project.description ?? project.preview_description,
  );
  const skills = (project.jobs ?? [])
    .map((job) => stringValue(job.name))
    .filter(Boolean)
    .join(', ');
  const compNotes = project.type ? `Project type: ${project.type}` : '';
  return {
    canonicalUrl: freelancerProjectUrl(project),
    compNotes,
    currency: stringValue(project.currency?.code),
    descriptionRaw,
    employmentType: 'contract',
    externalId: stringValue(project.id),
    locationNotes: 'Remote',
    message: 'Loaded Freelancer project details from the public API.',
    postedAt: freelancerDateFromEpochSeconds(project.submitdate),
    provider: 'freelancer',
    qualifications: qualificationsFromDescription(descriptionRaw),
    requiredSkills: skills,
    salaryMax: numberValue(project.budget?.maximum),
    salaryMin: numberValue(project.budget?.minimum),
    status: 'resolved',
    title: displayTitle(project.title),
    workMode: 'remote',
  };
}

function freelancerDateFromEpochSeconds(value: unknown): Date | null {
  const number = numberValue(value);
  if (number === null) return null;
  const date = new Date(number * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function remoteOkResolvedDetail(
  job: RemoteOkJob,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const canonicalUrl = remoteOkPostingUrl(job);
  const descriptionRaw = htmlToPlainText(stringValue(job.description));
  return {
    canonicalUrl,
    currency: 'USD',
    descriptionRaw,
    externalId: stringValue(job.id),
    locationNotes: stringValue(job.location) || 'Remote',
    message: 'Loaded Remote OK posting details.',
    postedAt: parseDate(job.date),
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    salaryMax: numberValue(job.salary_max),
    salaryMin: numberValue(job.salary_min),
    status: 'resolved',
    title: displayTitle(job.position),
    workMode: 'remote',
  };
}

function remotivePostingUrl(job: RemotiveJob): string {
  const rawUrl = stringValue(job.url);
  return rawUrl ? new URL(rawUrl, 'https://remotive.com').toString() : '';
}

function workingNomadsPostingUrl(job: WorkingNomadsJob): string {
  const rawUrl = stringValue(job.url);
  return rawUrl
    ? new URL(rawUrl, 'https://www.workingnomads.com').toString()
    : '';
}

function workingNomadsExternalId(postingUrl: string): string {
  try {
    const url = new URL(postingUrl);
    return url.pathname.match(/\/job\/go\/(\d+)\/?$/i)?.[1] ?? '';
  } catch {
    return '';
  }
}

function remotiveResolvedDetail(
  job: RemotiveJob,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const descriptionRaw = htmlToPlainText(stringValue(job.description));
  const location = stringValue(job.candidate_required_location) || 'Remote';
  return {
    canonicalUrl: remotivePostingUrl(job),
    descriptionRaw,
    employmentType: employmentTypeFromValue(job.job_type),
    externalId: stringValue(job.id),
    locationNotes: location,
    message: 'Loaded Remotive posting details from the public API.',
    postedAt: parseDate(job.publication_date),
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: displayTitle(job.title),
    workMode: 'remote',
  };
}

function workingNomadsResolvedDetail(
  job: WorkingNomadsJob,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const canonicalUrl = workingNomadsPostingUrl(job);
  const descriptionRaw = htmlToPlainText(stringValue(job.description));
  const tags = stringValue(job.tags);
  return {
    canonicalUrl,
    descriptionRaw,
    externalId: workingNomadsExternalId(canonicalUrl),
    locationNotes: stringValue(job.location) || 'Remote',
    message: 'Loaded Working Nomads posting details from the public API.',
    postedAt: parseDate(job.pub_date),
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    requiredSkills: tags,
    status: 'resolved',
    title: displayTitle(job.title),
    workMode: 'remote',
  };
}

function linkedInSearchUrl(source: SourceLike): string {
  const url = sourceUrl(source);
  if (url && (url.pathname !== '/jobs/' || url.search)) return url.toString();
  const search = new URL('https://www.linkedin.com/jobs/search/');
  const query = stringValue(source.searchQuery);
  if (query) search.searchParams.set('keywords', query);
  return search.toString();
}

function linkedInExternalId(postingUrl: string): string {
  try {
    const url = new URL(postingUrl);
    const currentJobId = url.searchParams.get('currentJobId');
    if (currentJobId) return currentJobId;
    const [, , viewSegment, jobSegment] = url.pathname.split('/');
    if (viewSegment !== 'view' || !jobSegment) return '';
    return jobSegment.match(/(?:^|-)(\d+)$/)?.[1] ?? '';
  } catch {
    return '';
  }
}

function linkedInCanonicalUrl(postingUrl: string): string {
  const externalId = linkedInExternalId(postingUrl);
  return externalId
    ? `https://www.linkedin.com/jobs/view/${externalId}/`
    : postingUrl;
}

function linkedInResolvedDetail(
  card: LinkedInJobCard,
  canonicalUrl: string,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const title = displayTitle(card.title);
  const companyName = displayTitle(card.companyName);
  const location = stringValue(card.location);
  const descriptionRaw = [
    title,
    companyName ? `Company: ${companyName}` : '',
    location ? `Location: ${location}` : '',
    'Discovered from LinkedIn public job search. Direct company details are enriched from public company pages when available.',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    canonicalUrl,
    descriptionRaw,
    externalId: linkedInExternalId(canonicalUrl),
    locationNotes: location,
    message: 'Loaded LinkedIn public job card metadata.',
    postedAt: parseDate(card.postedAt),
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title,
    workMode: workModeFromValue(location),
  };
}

function linkedInClassText(cardHtml: string, classNeedle: string): string {
  const classPattern = classNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cardHtml.match(
    new RegExp(
      `<[^>]+class=["'][^"']*${classPattern}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
      'i',
    ),
  );
  return displayTitle(htmlToPlainText(decodeHtmlEntities(match?.[1] ?? '')));
}

function linkedInCompanyUrl(cardHtml: string): string {
  const subtitleMatch = cardHtml.match(
    /<[^>]+class=["'][^"']*base-search-card__subtitle[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
  );
  const html = subtitleMatch?.[1] ?? cardHtml;
  for (const match of html.matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    const href = normalizeHttpUrl(
      decodeHtmlEntities(match[1] ?? ''),
      'https://www.linkedin.com',
    );
    if (!href) continue;
    try {
      const url = new URL(href);
      if (
        (url.hostname === 'www.linkedin.com' ||
          url.hostname === 'linkedin.com') &&
        url.pathname.startsWith('/company/')
      ) {
        return url.toString();
      }
    } catch {
      // Ignore malformed card links.
    }
  }
  return '';
}

function extractLinkedInJobCards(html: string): LinkedInJobCard[] {
  const cards: LinkedInJobCard[] = [];
  for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const cardHtml = match[1] ?? '';
    if (
      !/base-card|job-search-card|jobs-search-results__list-item/i.test(
        cardHtml,
      )
    ) {
      continue;
    }
    const href = decodeHtmlEntities(
      cardHtml.match(/<a\b[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1] ?? '',
    );
    if (!href?.includes('/jobs/view/')) continue;
    const postingUrl = new URL(href, 'https://www.linkedin.com').toString();
    const title =
      linkedInClassText(cardHtml, 'base-search-card__title') ||
      linkedInClassText(cardHtml, 'job-card-list__title') ||
      linkedInClassText(cardHtml, 'sr-only');
    if (!title) continue;
    cards.push({
      companyName:
        linkedInClassText(cardHtml, 'base-search-card__subtitle') ||
        linkedInClassText(cardHtml, 'job-card-container__primary-description'),
      companyUrl: linkedInCompanyUrl(cardHtml),
      location:
        linkedInClassText(cardHtml, 'job-search-card__location') ||
        linkedInClassText(cardHtml, 'job-card-container__metadata-item'),
      postedAt: cardHtml.match(/<time\b[^>]+datetime=["']([^"']+)["']/i)?.[1],
      postingUrl,
      title,
    });
  }
  return cards;
}

export async function discoverLinkedInCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const response = await fetchImpl(linkedInSearchUrl(source), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    },
  });
  if (!response.ok) return [];

  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const card of extractLinkedInJobCards(await response.text())) {
    const postingUrl = stringValue(card.postingUrl);
    const title = displayTitle(card.title);
    if (!postingUrl || !title) continue;
    const canonicalUrl = linkedInCanonicalUrl(postingUrl);
    if (seen.has(canonicalUrl)) continue;
    if (!remoteOkTitleMatchesEngineeringRole(title)) continue;
    const candidateText = [
      title,
      card.companyName,
      card.location,
      stringValue(source.searchQuery),
    ].join(' ');
    if (!candidateMatchesSource(source, candidateText)) continue;
    seen.add(canonicalUrl);
    candidates.push({
      canonicalUrl,
      companyName: stringValue(card.companyName),
      companyLinkedinUrl: stringValue(card.companyUrl),
      externalId: linkedInExternalId(postingUrl),
      locationNotes: stringValue(card.location),
      postedAt: parseDate(card.postedAt),
      postingUrl,
      rawJson: card,
      resolvedDetail: linkedInResolvedDetail(card, canonicalUrl),
      title,
      workMode: workModeFromValue(card.location),
    });
    if (candidates.length >= 25) break;
  }
  return candidates;
}

const WE_WORK_REMOTELY_MAX_CANDIDATES = 50;
const WE_WORK_REMOTELY_ENGINEERING_TITLE_RE =
  /\b(backend|devops|developer|engineer|engineering|full[-\s]?stack|infrastructure|platform|reliability|site reliability|software|sre|systems?|web)\b/i;

function weWorkRemotelyTitleMatchesEngineeringRole(title: string): boolean {
  return WE_WORK_REMOTELY_ENGINEERING_TITLE_RE.test(title);
}

function xmlElementText(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  if (!match?.[1]) return '';
  const raw = match[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/i);
  return decodeHtmlEntities((cdata?.[1] ?? raw).trim());
}

function parseWeWorkRemotelyRss(xml: string): WeWorkRemotelyRssJob[] {
  const jobs: WeWorkRemotelyRssJob[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1] ?? '';
    jobs.push({
      category: xmlElementText(item, 'category'),
      descriptionHtml: xmlElementText(item, 'description'),
      link: xmlElementText(item, 'link'),
      region: xmlElementText(item, 'region'),
      title: xmlElementText(item, 'title'),
    });
  }
  return jobs;
}

function splitWeWorkRemotelyTitle(title: string): {
  companyName?: string;
  roleTitle: string;
} {
  const [companyName, ...rest] = title.split(':');
  const roleTitle = displayTitle(rest.join(':')) || displayTitle(title);
  return {
    companyName: rest.length > 0 ? displayTitle(companyName) : undefined,
    roleTitle,
  };
}

function weWorkRemotelyResolvedDetail(
  job: WeWorkRemotelyRssJob,
  postingUrl: string,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const { roleTitle } = splitWeWorkRemotelyTitle(displayTitle(job.title));
  const descriptionRaw = htmlToPlainText(
    decodeHtmlEntities(job.descriptionHtml ?? ''),
  );
  const locationNotes = stringValue(job.region) || 'Remote';
  return {
    canonicalUrl: postingUrl,
    descriptionRaw,
    locationNotes,
    message: 'Loaded We Work Remotely RSS posting details.',
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: roleTitle,
    workMode: 'remote',
  };
}

export async function discoverWeWorkRemotelyCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url) return [];
  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];

  const jobs = parseWeWorkRemotelyRss(await response.text());
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const job of jobs) {
    const rawLink = stringValue(job.link);
    const rawTitle = displayTitle(job.title);
    if (!rawLink || !rawTitle) continue;
    const postingUrl = new URL(
      rawLink,
      'https://weworkremotely.com',
    ).toString();
    if (seen.has(postingUrl)) continue;
    const { companyName, roleTitle } = splitWeWorkRemotelyTitle(rawTitle);
    if (!roleTitle || !weWorkRemotelyTitleMatchesEngineeringRole(roleTitle)) {
      continue;
    }
    const detail = weWorkRemotelyResolvedDetail(job, postingUrl);
    if (!detail.descriptionRaw) continue;
    const candidateText = [
      rawTitle,
      job.category,
      job.region,
      detail.descriptionRaw,
    ].join(' ');
    if (!candidateMatchesSource(source, candidateText)) continue;
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      companyName,
      locationNotes: detail.locationNotes,
      postingUrl,
      rawJson: job,
      resolvedDetail: detail,
      title: roleTitle,
      workMode: detail.workMode,
    });
    if (candidates.length >= WE_WORK_REMOTELY_MAX_CANDIDATES) break;
  }
  return candidates;
}

export async function discoverRemotiveCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const response = await fetchImpl(REMOTIVE_API_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as RemotiveApiResponse;
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];

  for (const job of payload.jobs ?? []) {
    const postingUrl = remotivePostingUrl(job);
    const title = displayTitle(job.title);
    if (!postingUrl || !title || seen.has(postingUrl)) continue;
    if (!remoteOkTitleMatchesEngineeringRole(title)) continue;
    const detail = remotiveResolvedDetail(job);
    if (!detail.descriptionRaw) continue;
    const candidateText = [
      title,
      job.company_name,
      job.category,
      job.candidate_required_location,
      ...(Array.isArray(job.tags) ? job.tags : []),
      detail.descriptionRaw,
    ].join(' ');
    if (!candidateMatchesSource(source, candidateText)) continue;
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: detail.canonicalUrl,
      companyName: stringValue(job.company_name),
      employmentType: detail.employmentType,
      externalId: detail.externalId,
      locationNotes: detail.locationNotes,
      postedAt: detail.postedAt,
      postingUrl,
      rawJson: job,
      resolvedDetail: detail,
      title,
      workMode: detail.workMode,
    });
    if (candidates.length >= REMOTIVE_MAX_CANDIDATES) break;
  }

  return candidates;
}

export async function discoverWorkingNomadsCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const response = await fetchImpl(WORKING_NOMADS_API_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];
  const jobs = (await response.json()) as WorkingNomadsJob[];
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];

  for (const job of jobs) {
    const postingUrl = workingNomadsPostingUrl(job);
    const title = displayTitle(job.title);
    if (!postingUrl || !title || seen.has(postingUrl)) continue;
    if (!remoteOkTitleMatchesEngineeringRole(title)) continue;
    const detail = workingNomadsResolvedDetail(job);
    if (!detail.descriptionRaw) continue;
    const candidateText = [
      title,
      job.company_name,
      job.category_name,
      job.location,
      job.tags,
      detail.descriptionRaw,
    ].join(' ');
    if (!candidateMatchesSource(source, candidateText)) continue;
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: detail.canonicalUrl,
      companyName: stringValue(job.company_name),
      externalId: detail.externalId,
      locationNotes: detail.locationNotes,
      postedAt: detail.postedAt,
      postingUrl,
      rawJson: job,
      resolvedDetail: detail,
      title,
      workMode: detail.workMode,
    });
    if (candidates.length >= WORKING_NOMADS_MAX_CANDIDATES) break;
  }

  return candidates;
}

export async function discoverFreelancerCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];

  for (const query of freelancerQueryTerms(source)) {
    const response = await fetchImpl(freelancerSearchUrl(source, query), {
      headers: {
        Accept: 'application/json',
        'User-Agent': sourceCrawlerUserAgent(),
      },
    });
    if (!response.ok) continue;
    const payload = (await response.json()) as FreelancerProjectsResponse;
    if (payload.status && payload.status !== 'success') continue;

    for (const project of payload.result?.projects ?? []) {
      const postingUrl = freelancerProjectUrl(project);
      const title = displayTitle(project.title);
      if (!postingUrl || !title || seen.has(postingUrl)) continue;
      const detail = freelancerResolvedDetail(project);
      if (!detail.descriptionRaw) continue;
      const candidateText = [
        title,
        ...(project.jobs ?? []).map((job) => job.name),
        detail.descriptionRaw,
      ].join(' ');
      if (!candidateMatchesSource(source, candidateText)) continue;
      seen.add(postingUrl);
      candidates.push({
        canonicalUrl: detail.canonicalUrl,
        employmentType: detail.employmentType,
        externalId: detail.externalId,
        locationNotes: detail.locationNotes,
        postedAt: detail.postedAt,
        postingUrl,
        rawJson: project,
        resolvedDetail: detail,
        title,
        workMode: detail.workMode,
      });
      if (candidates.length >= FREELANCER_MAX_CANDIDATES) return candidates;
    }
  }

  return candidates;
}

export async function discoverRemoteOkCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const response = await fetchImpl(remoteOkApiUrl(source), {
    headers: {
      Accept: 'application/json',
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as unknown;
  const jobs = Array.isArray(payload)
    ? (payload.slice(1) as RemoteOkJob[])
    : [];
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];

  for (const job of jobs) {
    const postingUrl = remoteOkPostingUrl(job);
    const title = displayTitle(job.position);
    if (!postingUrl || !title || seen.has(postingUrl)) continue;
    if (!remoteOkTitleMatchesEngineeringRole(title)) continue;
    const candidateText = [
      title,
      job.company,
      job.location,
      ...(Array.isArray(job.tags) ? job.tags : []),
    ].join(' ');
    if (!candidateMatchesSource(source, candidateText)) continue;
    const detail = remoteOkResolvedDetail(job);
    if (!detail.descriptionRaw) continue;
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: detail.canonicalUrl,
      companyName: stringValue(job.company),
      externalId: detail.externalId,
      locationNotes: detail.locationNotes,
      postedAt: detail.postedAt,
      postingUrl,
      rawJson: job,
      resolvedDetail: detail,
      title,
      workMode: detail.workMode,
    });
    if (candidates.length >= REMOTE_OK_MAX_CANDIDATES) break;
  }

  return candidates;
}

function isRemoteComOpeningsUrl(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      (url.hostname === 'remote.com' || url.hostname === 'www.remote.com') &&
      (url.pathname === '/careers' ||
        url.pathname === '/openings' ||
        url.pathname.startsWith('/openings/'))
    );
  } catch {
    return false;
  }
}

function remoteComOpeningsUrl(value: unknown): string {
  const raw = stringValue(value);
  try {
    const url = new URL(raw || 'https://remote.com/openings');
    if (url.pathname === '/openings' || url.pathname.startsWith('/openings/')) {
      return url.toString();
    }
  } catch {
    // Fall through to the canonical openings board.
  }
  return 'https://remote.com/openings';
}

function collectRemoteComJobs(
  departments: RemoteComDepartment[],
): RemoteComJob[] {
  const jobs: RemoteComJob[] = [];
  for (const department of departments) {
    jobs.push(...(department.jobs ?? []));
    jobs.push(...collectRemoteComJobs(department.children ?? []));
  }
  return jobs;
}

export async function discoverRemoteComCandidates(
  source: SourceLike,
  spider?: SpiderAdapter,
): Promise<OpportunitySourceCandidate[]> {
  const activeSpider = spider ?? (await getDefaultSpider());
  let page: Awaited<ReturnType<SpiderAdapter['fetch']>>;
  try {
    page = await activeSpider.fetch(remoteComOpeningsUrl(source.url), {
      cache: true,
      cacheExpiry: 60 * 60 * 1000,
      timeout: 60000,
    });
  } catch {
    return [];
  }

  const nextData = extractNextData<{
    props?: { pageProps?: { departments?: RemoteComDepartment[] } };
  }>(page.content);
  const jobs = collectRemoteComJobs(
    nextData?.props?.pageProps?.departments ?? [],
  );
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const job of jobs) {
    const id = stringValue(job.id);
    const title = displayTitle(job.title);
    const postingUrl =
      stringValue(job.absolute_url) ||
      (id ? `https://remote.com/openings/${id}` : '');
    if (!postingUrl || !title || seen.has(postingUrl)) continue;
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      externalId: id,
      locationNotes: stringValue(job.location?.name),
      postedAt: parseDate(job.first_published ?? job.updated_at),
      postingUrl,
      rawJson: job,
      title,
      workMode: workModeFromValue(job.location?.name),
    });
  }
  return candidates;
}

const AMAZON_JOBS_MAX_CANDIDATES = 50;

const AIJOBS_MAX_CANDIDATES = 50;

function isAiJobsUrl(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return [
      'ai-jobs.net',
      'www.ai-jobs.net',
      'aijobs.net',
      'www.aijobs.net',
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

function aijobsIndexUrl(source: SourceLike): string {
  return stringValue(source.url) || 'https://ai-jobs.net/';
}

function extractAiJobsIndexJobs(
  html: string,
  baseUrl: string,
): AiJobsIndexJob[] {
  const jobs: AiJobsIndexJob[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*(?:"([^"]*\/job\/[^"]*)"|'([^']*\/job\/[^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const href = decodeHtmlEntities(match[1] ?? match[2] ?? '');
    const anchorBody = (match[3] ?? '').replace(
      /<span\b[^>]*>[\s\S]*?<\/span>/gi,
      ' ',
    );
    const title = displayTitle(htmlToPlainText(anchorBody));
    if (!href || !title) continue;
    const url = new URL(href, baseUrl).toString();
    if (seen.has(url)) continue;
    seen.add(url);

    jobs.push({ title, url });
    if (jobs.length >= AIJOBS_MAX_CANDIDATES) break;
  }
  return jobs;
}

export async function discoverAiJobsCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  if (!isAiJobsUrl(source.url)) return [];
  const indexUrl = aijobsIndexUrl(source);
  const response = await fetchImpl(indexUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (!response.ok) return [];

  return extractAiJobsIndexJobs(await response.text(), indexUrl)
    .filter((job) => candidateMatchesSource(source, stringValue(job.title)))
    .map((job) => ({
      canonicalUrl: job.url,
      companyName: stringValue(job.company),
      postingUrl: job.url ?? '',
      rawJson: job,
      title: stringValue(job.title),
    }));
}

function isAmazonJobsUrl(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.hostname === 'www.amazon.jobs' || url.hostname === 'amazon.jobs';
  } catch {
    return false;
  }
}

function amazonJobsSearchUrl(source: SourceLike): string {
  const raw = stringValue(source.url) || 'https://www.amazon.jobs/en/search';
  const url = new URL(raw);
  const segments = url.pathname.split('/').filter(Boolean);
  const locale = segments[0] || 'en';
  url.pathname = `/${locale}/search.json`;
  if (!url.searchParams.get('base_query')) {
    const query = stringValue(source.searchQuery);
    if (query) url.searchParams.set('base_query', query);
  }
  if (!url.searchParams.get('offset')) url.searchParams.set('offset', '0');
  if (!url.searchParams.get('result_limit')) {
    url.searchParams.set('result_limit', String(AMAZON_JOBS_MAX_CANDIDATES));
  }
  if (!url.searchParams.get('sort')) url.searchParams.set('sort', 'relevant');
  return url.toString();
}

function amazonJobsPostingUrl(job: AmazonJobsJob): string {
  const path = stringValue(job.job_path);
  if (path) return new URL(path, 'https://www.amazon.jobs').toString();
  const id = stringValue(job.id_icims) || stringValue(job.id);
  return id ? `https://www.amazon.jobs/en/jobs/${encodeURIComponent(id)}` : '';
}

function amazonJobsLocation(job: AmazonJobsJob): string {
  const normalized = stringValue(job.normalized_location);
  if (normalized) return normalized;
  const locations = Array.isArray(job.locations) ? job.locations : [];
  return locations
    .map((location) =>
      typeof location === 'string'
        ? location
        : stringValue(location.normalized_location),
    )
    .filter(Boolean)
    .join('; ');
}

function amazonJobsResolvedDetail(
  job: AmazonJobsJob,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const descriptionRaw = htmlToPlainText(
    [job.description, job.basic_qualifications, job.preferred_qualifications]
      .map(stringValue)
      .filter(Boolean)
      .join('\n\n'),
  );
  const location = amazonJobsLocation(job);
  const schedule = stringValue(job.job_schedule_type);
  return {
    canonicalUrl: amazonJobsPostingUrl(job),
    descriptionRaw,
    employmentType: employmentTypeFromValue(schedule),
    externalId: stringValue(job.id_icims) || stringValue(job.id),
    locationNotes: location,
    message: 'Loaded Amazon Jobs posting details from the search API.',
    postedAt: parseDate(job.posted_date ?? job.updated_time),
    provider: 'generic',
    qualifications:
      htmlToPlainText(stringValue(job.basic_qualifications)) ||
      qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: displayTitle(job.title),
    workMode: workModeFromValue(location),
  };
}

export async function discoverAmazonJobsCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const response = await fetchImpl(amazonJobsSearchUrl(source), {
    headers: {
      Accept: 'application/json',
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as AmazonJobsSearchResponse;
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const job of payload.jobs ?? []) {
    const postingUrl = amazonJobsPostingUrl(job);
    const title = displayTitle(job.title);
    if (!postingUrl || !title || seen.has(postingUrl)) continue;
    const detail = amazonJobsResolvedDetail(job);
    if (!detail.descriptionRaw) continue;
    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: detail.canonicalUrl,
      companyName: stringValue(job.company_name) || 'Amazon',
      externalId: detail.externalId,
      employmentType: detail.employmentType,
      locationNotes: detail.locationNotes,
      postedAt: detail.postedAt,
      postingUrl,
      rawJson: job,
      resolvedDetail: detail,
      title,
      workMode: detail.workMode,
    });
  }
  return candidates;
}

const MICROSOFT_CAREERS_MAX_CANDIDATES = 20;

function isMicrosoftCareersUrl(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.hostname === 'jobs.careers.microsoft.com' ||
      url.hostname === 'apply.careers.microsoft.com'
    );
  } catch {
    return false;
  }
}

function microsoftCareersSearchUrl(source: SourceLike): string {
  const sourceUrl = new URL(
    stringValue(source.url) || 'https://apply.careers.microsoft.com/careers',
  );
  const url = new URL(
    '/api/pcsx/search',
    'https://apply.careers.microsoft.com',
  );
  url.searchParams.set('domain', 'microsoft.com');
  const query =
    stringValue(source.searchQuery) ||
    stringValue(sourceUrl.searchParams.get('q')) ||
    stringValue(sourceUrl.searchParams.get('query'));
  if (query) url.searchParams.set('query', query);
  const location =
    stringValue(sourceUrl.searchParams.get('lc')) ||
    stringValue(sourceUrl.searchParams.get('location'));
  if (location) url.searchParams.set('location', location);
  return url.toString();
}

function microsoftCareersPostingUrl(
  position: MicrosoftCareersPosition,
): string {
  const path = stringValue(position.positionUrl);
  if (path)
    return new URL(path, 'https://apply.careers.microsoft.com').toString();
  const id = stringValue(position.id);
  return id
    ? `https://apply.careers.microsoft.com/careers/job/${encodeURIComponent(id)}`
    : '';
}

function microsoftCareersPostedAt(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric * 1000);
  }
  return parseDate(text);
}

function microsoftCareersLocation(position: MicrosoftCareersPosition): string {
  const standardized = Array.isArray(position.standardizedLocations)
    ? position.standardizedLocations.filter(Boolean).join('; ')
    : '';
  if (standardized) return standardized;
  return Array.isArray(position.locations)
    ? position.locations.filter(Boolean).join('; ')
    : '';
}

function microsoftCareersResolvedDetail(
  position: MicrosoftCareersPosition,
  detail?: MicrosoftCareersDetailResponse['data'] | null,
): Extract<OpportunityDetailResult, { status: 'resolved' }> | null {
  const descriptionRaw = htmlToPlainText(
    [detail?.jobDescription, detail?.responsibilities, detail?.qualifications]
      .map(stringValue)
      .filter(Boolean)
      .join('\n\n'),
  );
  if (!descriptionRaw) return null;
  const merged = { ...position, ...detail };
  const location = microsoftCareersLocation(merged);
  return {
    canonicalUrl: microsoftCareersPostingUrl(merged),
    descriptionRaw,
    externalId:
      stringValue(merged.displayJobId) ||
      stringValue(merged.atsJobId) ||
      stringValue(merged.id),
    locationNotes: location,
    message: 'Loaded Microsoft Careers posting details from the PCSX API.',
    postedAt: microsoftCareersPostedAt(merged.postedTs ?? merged.creationTs),
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: displayTitle(merged.name),
    workMode: workModeFromValue(
      stringValue(merged.workLocationOption) || location,
    ),
  };
}

async function fetchMicrosoftCareersDetail(
  position: MicrosoftCareersPosition,
  fetchImpl: FetchLike,
): Promise<MicrosoftCareersDetailResponse['data'] | null> {
  const id = stringValue(position.id);
  if (!id) return null;
  const url = new URL(
    '/api/pcsx/position_details',
    'https://apply.careers.microsoft.com',
  );
  url.searchParams.set('domain', 'microsoft.com');
  url.searchParams.set('position_id', id);
  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'application/json',
      Referer: microsoftCareersPostingUrl(position),
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as MicrosoftCareersDetailResponse;
  return payload.data ?? null;
}

export async function discoverMicrosoftCareersCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  if (!isMicrosoftCareersUrl(source.url)) return [];
  const response = await fetchImpl(microsoftCareersSearchUrl(source), {
    headers: {
      Accept: 'application/json',
      Referer: 'https://apply.careers.microsoft.com/careers/search',
      'User-Agent': sourceCrawlerUserAgent(),
    },
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as MicrosoftCareersSearchResponse;
  const positions = payload.data?.positions ?? [];
  const seen = new Set<string>();
  const candidates: OpportunitySourceCandidate[] = [];
  for (const position of positions.slice(0, MICROSOFT_CAREERS_MAX_CANDIDATES)) {
    const postingUrl = microsoftCareersPostingUrl(position);
    const title = displayTitle(position.name);
    const location = microsoftCareersLocation(position);
    if (!postingUrl || !title || seen.has(postingUrl)) continue;
    if (
      !candidateMatchesSource(
        source,
        [title, position.department, location].join(' '),
      )
    ) {
      continue;
    }
    seen.add(postingUrl);
    const detail = await fetchMicrosoftCareersDetail(position, fetchImpl);
    const resolvedDetail = microsoftCareersResolvedDetail(position, detail);
    candidates.push({
      canonicalUrl: postingUrl,
      companyName: 'Microsoft',
      externalId:
        stringValue(position.displayJobId) ||
        stringValue(position.atsJobId) ||
        stringValue(position.id),
      locationNotes: location,
      postedAt: microsoftCareersPostedAt(
        position.postedTs ?? position.creationTs,
      ),
      postingUrl,
      rawJson: position,
      ...(resolvedDetail ? { resolvedDetail } : {}),
      title,
      workMode: workModeFromValue(
        stringValue(position.workLocationOption) || location,
      ),
    });
  }
  return candidates;
}

const WORKDAY_MAX_CANDIDATES = 20;

function workdayTenant(url: URL): string {
  return url.hostname.split('.')[0] ?? '';
}

function workdaySite(url: URL): string {
  return url.pathname.split('/').filter(Boolean)[0] ?? '';
}

function workdayApiBase(url: URL): string {
  const tenant = workdayTenant(url);
  const site = workdaySite(url);
  if (!tenant || !site) return '';
  return new URL(
    `/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`,
    url.origin,
  ).toString();
}

function workdaySearchUrl(url: URL): string {
  const apiBase = workdayApiBase(url);
  return apiBase ? `${apiBase}/jobs` : '';
}

function workdayPostingUrl(sourceUrl: URL, job: WorkdaySearchJob): string {
  const path = stringValue(job.externalPath);
  if (!path) return '';
  return new URL(
    `/${workdaySite(sourceUrl)}${path.startsWith('/') ? path : `/${path}`}`,
    sourceUrl.origin,
  ).toString();
}

function workdayDetailUrl(sourceUrl: URL, job: WorkdaySearchJob): string {
  const path = stringValue(job.externalPath);
  const apiBase = workdayApiBase(sourceUrl);
  if (!apiBase || !path) return '';
  return `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
}

function workdayExternalId(job: WorkdaySearchJob): string {
  const bulletId = Array.isArray(job.bulletFields)
    ? stringValue(job.bulletFields[0])
    : '';
  if (bulletId) return bulletId;
  return stringValue(job.externalPath).split('_').pop() ?? '';
}

function workdayResolvedDetail(
  job: WorkdaySearchJob,
  detail: WorkdayJobDetailResponse['jobPostingInfo'],
  canonicalUrl: string,
): Extract<OpportunityDetailResult, { status: 'resolved' }> {
  const descriptionRaw = htmlToPlainText(stringValue(detail?.jobDescription));
  const location =
    stringValue(detail?.location) || stringValue(job.locationsText);
  return {
    canonicalUrl,
    descriptionRaw,
    externalId: stringValue(detail?.id) || workdayExternalId(job),
    locationNotes: location,
    message: 'Loaded Workday posting details.',
    postedAt: parseDate(detail?.postedOn ?? job.postedOn),
    provider: 'workday',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: displayTitle(detail?.title || job.title),
    workMode: workModeFromValue(location),
  };
}

export async function discoverWorkdayCandidates(
  source: SourceLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunitySourceCandidate[]> {
  const url = sourceUrl(source);
  if (!url || !isWorkdayJobsUrl(url)) return [];
  const searchUrl = workdaySearchUrl(url);
  if (!searchUrl) return [];

  const response = await fetchImpl(searchUrl, {
    body: JSON.stringify({
      appliedFacets: {},
      limit: WORKDAY_MAX_CANDIDATES,
      offset: 0,
      searchText: stringValue(source.searchQuery),
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': sourceCrawlerUserAgent(),
    },
    method: 'POST',
  });
  if (!response.ok) return [];

  const payload = (await response.json()) as WorkdaySearchResponse;
  const candidates: OpportunitySourceCandidate[] = [];
  const seen = new Set<string>();
  for (const job of payload.jobPostings ?? []) {
    const title = displayTitle(job.title);
    const postingUrl = workdayPostingUrl(url, job);
    const detailUrl = workdayDetailUrl(url, job);
    if (!title || !postingUrl || !detailUrl || seen.has(postingUrl)) continue;
    if (!candidateMatchesSource(source, [title, job.locationsText].join(' '))) {
      continue;
    }

    const detailResponse = await fetchImpl(detailUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': sourceCrawlerUserAgent(),
      },
    });
    if (!detailResponse.ok) continue;
    const detailPayload =
      (await detailResponse.json()) as WorkdayJobDetailResponse;
    const detail = workdayResolvedDetail(
      job,
      detailPayload.jobPostingInfo,
      postingUrl,
    );
    if (!detail.descriptionRaw) continue;

    seen.add(postingUrl);
    candidates.push({
      canonicalUrl: postingUrl,
      externalId: detail.externalId,
      locationNotes: detail.locationNotes,
      postedAt: detail.postedAt,
      postingUrl,
      rawJson: { detail: detailPayload.jobPostingInfo, search: job },
      resolvedDetail: detail,
      title: detail.title ?? title,
      workMode: detail.workMode,
    });
  }
  return candidates;
}

const greenhouseAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'greenhouse',
  name: 'Greenhouse',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'greenhouse'
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Greenhouse' }
      : null,
  fetch: (source) =>
    discoverGreenhouseCandidates(source, source.config?.fetchImpl ?? fetch),
};

const ashbyAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'ashby',
  name: 'Ashby',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'ashby'
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Ashby' }
      : null,
  fetch: (source) =>
    discoverAshbyCandidates(
      source,
      source.config?.spider,
      source.config?.fetchImpl ?? fetch,
    ),
};

const leverAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'lever',
  name: 'Lever',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'lever'
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Lever' }
      : null,
  fetch: (source) =>
    discoverLeverCandidates(source, source.config?.fetchImpl ?? fetch),
};

const microsoftCareersAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'microsoft-careers',
  name: 'Microsoft Careers',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'microsoft-careers'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Microsoft Careers',
        }
      : null,
  fetch: (source) =>
    discoverMicrosoftCareersCandidates(
      source,
      source.config?.fetchImpl ?? fetch,
    ),
};

const oracleCareersAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'oracle-careers',
  name: 'Oracle Careers',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'oracle-careers'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Oracle Careers',
        }
      : null,
  fetch: (source) =>
    discoverOracleCareersCandidates(source, source.config?.fetchImpl ?? fetch),
};

const freelancerAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'freelancer',
  name: 'Freelancer.com',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'freelancer'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Freelancer.com',
        }
      : null,
  fetch: (source) =>
    discoverFreelancerCandidates(source, source.config?.fetchImpl ?? fetch),
};

const peoplePerHourAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'peopleperhour',
  name: 'PeoplePerHour',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'peopleperhour'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'PeoplePerHour',
        }
      : null,
  fetch: async (source) =>
    discoverPeoplePerHourCandidates(
      source,
      source.config?.fetchImpl ?? fetch,
      source.config?.spider ??
        (source.config?.fetchImpl ? undefined : await getDefaultSpider()),
    ),
};

const workdayAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'workday',
  name: 'Workday',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'workday'
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Workday' }
      : null,
  fetch: (source) =>
    discoverWorkdayCandidates(source, source.config?.fetchImpl ?? fetch),
};

const amazonJobsAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'amazon-jobs',
  name: 'Amazon Jobs',
  priority: 100,
  detectUrl: (url) =>
    isAmazonJobsUrl(url)
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Amazon Jobs' }
      : null,
  fetch: (source) =>
    discoverAmazonJobsCandidates(source, source.config?.fetchImpl ?? fetch),
};

const aiJobsAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'aijobs',
  name: 'AI Jobs.net',
  priority: 100,
  detectUrl: (url) =>
    isAiJobsUrl(url)
      ? { confidence: 'high', normalizedUrl: url, platformName: 'AI Jobs.net' }
      : null,
  fetch: (source) =>
    discoverAiJobsCandidates(source, source.config?.fetchImpl ?? fetch),
};

const automatticCareersAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'automattic-careers',
  name: 'Automattic Careers',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'automattic-careers'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Automattic Careers',
        }
      : null,
  fetch: (source) =>
    discoverAutomatticCandidates(source, source.config?.fetchImpl ?? fetch),
};

const appleCareersAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'apple-careers',
  name: 'Apple Jobs',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'apple-careers'
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Apple Jobs' }
      : null,
  fetch: (source) =>
    discoverAppleCareersCandidates(source, source.config?.spider),
};

const canonicalCareersAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'canonical-careers',
  name: 'Canonical Careers',
  priority: 100,
  detectUrl: (url) =>
    isCanonicalCareersUrl(url)
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Canonical Careers',
        }
      : null,
  fetch: (source) =>
    discoverCanonicalCandidates(source, source.config?.fetchImpl ?? fetch),
};

const geminiCareersAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'gemini-careers',
  name: 'Gemini Careers',
  priority: 100,
  detectUrl: (url) =>
    isGeminiCareersUrl(url)
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Gemini Careers',
        }
      : null,
  fetch: (source) =>
    discoverGeminiCareersCandidates(source, source.config?.fetchImpl ?? fetch),
};

const ycombinatorAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'ycombinator',
  name: 'YC Work at a Startup',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'ycombinator'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'YC Work at a Startup',
        }
      : null,
  fetch: (source) => discoverYcCandidates(source, source.config?.spider),
};

const a16zPortfolioAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'a16z-portfolio',
  name: 'a16z portfolio jobs',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'a16z-portfolio'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'a16z portfolio jobs',
        }
      : null,
  fetch: (source) =>
    discoverA16zPortfolioCandidates(source, source.config?.fetchImpl ?? fetch),
};

const googleCareersAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'google-careers',
  name: 'Google Careers',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'google-careers'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Google Careers',
        }
      : null,
  fetch: (source) =>
    discoverGoogleCareersCandidates(source, source.config?.spider),
};

const hackerNewsJobsAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'hacker-news',
  name: 'Hacker News Jobs',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'hacker-news'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Hacker News Jobs',
        }
      : null,
  fetch: (source) =>
    discoverHackerNewsJobsCandidates(
      source,
      source.config?.spider,
      source.config?.fetchImpl ?? fetch,
    ),
};

const remoteOkAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'remoteok',
  name: 'Remote OK',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'remoteok'
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Remote OK' }
      : null,
  fetch: (source) =>
    discoverRemoteOkCandidates(source, source.config?.fetchImpl ?? fetch),
};

const wellfoundAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'wellfound',
  name: 'Wellfound',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'wellfound'
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Wellfound' }
      : null,
  fetch: (source) => discoverWellfoundCandidates(source, source.config?.spider),
};

const remoteRocketshipAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'remoterocketship',
  name: 'Remote Rocketship',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'remoterocketship'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Remote Rocketship',
        }
      : null,
  fetch: (source) =>
    discoverRemoteRocketshipCandidates(
      source,
      source.config?.fetchImpl ?? fetch,
    ),
};

const remotiveAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'remotive',
  name: 'Remotive',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'remotive'
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Remotive' }
      : null,
  fetch: (source) =>
    discoverRemotiveCandidates(source, source.config?.fetchImpl ?? fetch),
};

const workingNomadsAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'workingnomads',
  name: 'Working Nomads',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'workingnomads'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'Working Nomads',
        }
      : null,
  fetch: (source) =>
    discoverWorkingNomadsCandidates(source, source.config?.fetchImpl ?? fetch),
};

const linkedInAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'linkedin',
  name: 'LinkedIn Jobs',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'linkedin'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'LinkedIn Jobs',
        }
      : null,
  fetch: (source) =>
    discoverLinkedInCandidates(source, source.config?.fetchImpl ?? fetch),
};

const weWorkRemotelyAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'weworkremotely',
  name: 'We Work Remotely',
  priority: 100,
  detectUrl: (url) =>
    providerForUrl(url) === 'weworkremotely'
      ? {
          confidence: 'high',
          normalizedUrl: url,
          platformName: 'We Work Remotely',
        }
      : null,
  fetch: (source) =>
    discoverWeWorkRemotelyCandidates(source, source.config?.fetchImpl ?? fetch),
};

const remoteComAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'remote-com',
  name: 'Remote.com',
  priority: 100,
  detectUrl: (url) =>
    isRemoteComOpeningsUrl(url)
      ? { confidence: 'high', normalizedUrl: url, platformName: 'Remote.com' }
      : null,
  fetch: (source) => discoverRemoteComCandidates(source, source.config?.spider),
};

const genericCareersAdapter: PlatformAdapter<
  OpportunitySourceCandidate,
  JobBoardSource
> = {
  type: 'generic-careers',
  name: 'Careers page',
  priority: 999,
  // No detectUrl: a careers page carries no positive URL signal, so this
  // adapter is only selected as the explicit fallback (and only when the caller
  // opts into generic crawling).
  fetch: async (source, ctx) => {
    const [providerLinks, postingLinks] = await Promise.all([
      discoverGenericProviderLinks(
        source,
        source.config?.spider,
        source.config?.fetchImpl ?? fetch,
      ),
      discoverGenericPostingLinks(source, ctx),
    ]);
    return dedupeCandidatesByUrl([...providerLinks, ...postingLinks]);
  },
};

let jobAdapterRegistry: AdapterRegistry<
  OpportunitySourceCandidate,
  JobBoardSource
> | null = null;

export function getJobAdapterRegistry(): AdapterRegistry<
  OpportunitySourceCandidate,
  JobBoardSource
> {
  if (jobAdapterRegistry) return jobAdapterRegistry;
  const registry = new AdapterRegistry<
    OpportunitySourceCandidate,
    JobBoardSource
  >();
  registry.register(greenhouseAdapter);
  registry.register(workdayAdapter);
  registry.register(aiJobsAdapter);
  registry.register(amazonJobsAdapter);
  registry.register(automatticCareersAdapter);
  registry.register(appleCareersAdapter);
  registry.register(canonicalCareersAdapter);
  registry.register(geminiCareersAdapter);
  registry.register(ashbyAdapter);
  registry.register(googleCareersAdapter);
  registry.register(hackerNewsJobsAdapter);
  registry.register(leverAdapter);
  registry.register(linkedInAdapter);
  registry.register(microsoftCareersAdapter);
  registry.register(oracleCareersAdapter);
  registry.register(freelancerAdapter);
  registry.register(peoplePerHourAdapter);
  registry.register(ycombinatorAdapter);
  registry.register(a16zPortfolioAdapter);
  registry.register(remoteOkAdapter);
  registry.register(wellfoundAdapter);
  registry.register(remoteRocketshipAdapter);
  registry.register(remotiveAdapter);
  registry.register(workingNomadsAdapter);
  registry.register(weWorkRemotelyAdapter);
  registry.register(remoteComAdapter);
  registry.register(genericCareersAdapter);
  jobAdapterRegistry = registry;
  return registry;
}

// AdapterContext backed by the opportunity spider, built lazily: URL-only
// detection and the API/provider adapters never need it, so a
// greenhouse/ashby/lever crawl never instantiates a spider here.
function lazyAdapterContext(): AdapterContext {
  let real: Promise<AdapterContext> | null = null;
  const get = () =>
    (real ??= createAdapterContext({
      spider: defaultOpportunitySpiderOptions(),
    }));
  return {
    fetchPage: async (url, options) => (await get()).fetchPage(url, options),
    scrapeIndex: async (url, options) =>
      (await get()).scrapeIndex(url, options),
  };
}

// Detect which job-board adapter handles a URL (URL-only; no network for the
// built-in adapters). Used by company research to classify a careers page.
export async function detectJobBoard(
  url: unknown,
  options: { includeGeneric?: boolean } = {},
): Promise<DetectionResult | null> {
  const raw = stringValue(url);
  if (!raw) return null;
  return getJobAdapterRegistry().detect(raw, lazyAdapterContext(), {
    fallbackType: options.includeGeneric ? 'generic-careers' : undefined,
  });
}

export async function discoverOpportunityCandidates(
  source: SourceLike,
  options: Pick<
    CrawlOpportunitySourcesOptions,
    'fetchImpl' | 'includeGeneric' | 'spider'
  > = {},
): Promise<OpportunitySourceCandidate[]> {
  const registry = getJobAdapterRegistry();
  const ctx = lazyAdapterContext();
  const jobSource: JobBoardSource = {
    searchQuery: stringValue(source.searchQuery),
    url: stringValue(source.url),
    config: { fetchImpl: options.fetchImpl, spider: options.spider },
  };

  const detection = await registry.detect(jobSource.url, ctx, {
    fallbackType: options.includeGeneric ? 'generic-careers' : undefined,
  });
  if (!detection) return [];

  const adapter = registry.get(detection.type);
  if (!adapter) return [];
  return adapter.fetch(jobSource, ctx);
}

async function listAll(
  collection: ListableCollection,
  pageSize = 500,
): Promise<MutableRecord[]> {
  const records: MutableRecord[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const page = (await collection.list({
      limit: pageSize,
      offset,
    })) as MutableRecord[];
    records.push(...page);
    if (page.length < pageSize) break;
  }

  return records;
}

interface CompanyMetadata {
  careersUrl: string;
  linkedinUrl: string;
  name: string;
  websiteUrl: string;
}

interface HtmlLink {
  href: string;
  text: string;
}

const COMPANY_DISCOVERY_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': sourceCrawlerUserAgent(),
};

const IGNORED_COMPANY_OUTBOUND_HOSTS = [
  'linkedin.com',
  'lnkd.in',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'github.com',
  'crunchbase.com',
  'glassdoor.',
  'indeed.',
  'google.',
  'gstatic.com',
  'doubleclick.net',
];

const COMMON_CAREERS_PATHS = [
  '/careers',
  '/jobs',
  '/openings',
  '/company/careers',
  '/careers/jobs',
  '/careers/open-positions',
];

function isLinkedInUrl(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.hostname === 'www.linkedin.com' || url.hostname === 'linkedin.com'
    );
  } catch {
    return false;
  }
}

function normalizeLinkedInCompanyUrl(value: unknown): string {
  const raw = normalizeHttpUrl(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (
      !isLinkedInUrl(url.toString()) ||
      !url.pathname.startsWith('/company/')
    ) {
      return '';
    }
    url.search = '';
    return url.toString();
  } catch {
    return '';
  }
}

function unwrapLinkedInRedirect(value: string): string {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    if (!isLinkedInUrl(url.toString())) return normalized;
    const redirected =
      url.searchParams.get('url') ||
      url.searchParams.get('u') ||
      url.searchParams.get('target');
    return normalizeHttpUrl(redirected) || normalized;
  } catch {
    return normalized;
  }
}

function unwrapRelistRedirect(value: string): string {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    if (!isRelistUrl(url.toString())) return normalized;
    const redirected =
      url.searchParams.get('url') ||
      url.searchParams.get('u') ||
      url.searchParams.get('target') ||
      url.searchParams.get('redirect') ||
      url.searchParams.get('redirect_url') ||
      url.searchParams.get('redirectUrl');
    return normalizeHttpUrl(redirected) || normalized;
  } catch {
    return normalized;
  }
}

function htmlLinks(html: string, baseUrl: string): HtmlLink[] {
  const links: HtmlLink[] = [];
  for (const match of html.matchAll(
    /<a\b(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/a>/gi,
  )) {
    const attrs = match.groups?.attrs ?? '';
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1] ?? '';
    const normalized = normalizeHttpUrl(decodeHtmlEntities(href), baseUrl);
    if (!normalized) continue;
    links.push({
      href: unwrapRelistRedirect(unwrapLinkedInRedirect(normalized)),
      text: displayTitle(
        htmlToPlainText(decodeHtmlEntities(match.groups?.body ?? '')),
      ),
    });
  }
  return links;
}

function embeddedHttpUrls(html: string, baseUrl: string): string[] {
  const decoded = decodeHtmlEntities(html).replace(/\\\//g, '/');
  const urls: string[] = [];
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>)}\]]+/gi)) {
    const normalized = normalizeHttpUrl(match[0], baseUrl);
    if (normalized)
      urls.push(unwrapRelistRedirect(unwrapLinkedInRedirect(normalized)));
  }
  return urls;
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of urls) {
    const normalized = normalizeHttpUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function ignoredCompanyOutboundUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      IGNORED_COMPANY_OUTBOUND_HOSTS.some((marker) => host.includes(marker))
    ) {
      return true;
    }
    return /\.(?:avif|css|gif|ico|jpeg|jpg|js|png|svg|webp)$/i.test(
      url.pathname,
    );
  } catch {
    return true;
  }
}

function companyHostScore(value: string, companyName: string): number {
  try {
    const url = new URL(value);
    const host = normalizeText(url.hostname.replace(/^www\./i, ''));
    const nameTokens = normalizeText(companyName)
      .split(/\s+/)
      .filter(
        (token) => token.length > 2 && !['inc', 'llc', 'ltd'].includes(token),
      );
    return nameTokens.reduce(
      (score, token) => score + (host.includes(token) ? 1 : 0),
      0,
    );
  } catch {
    return 0;
  }
}

function careersIndexUrl(value: string): string {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    const provider = providerForUrl(url.toString());
    if (provider === 'lever') {
      const board = url.pathname.split('/').filter(Boolean)[0];
      return board ? new URL(`/${board}`, url.origin).toString() : normalized;
    }
    if (provider === 'ashby') {
      const board = url.pathname.split('/').filter(Boolean)[0];
      return board ? new URL(`/${board}`, url.origin).toString() : normalized;
    }
    if (provider !== 'generic') return normalized;

    const segments = url.pathname.split('/').filter(Boolean);
    const careerIndex = segments.findIndex((segment) =>
      /^(careers?|jobs?|openings?|positions?)$/i.test(segment),
    );
    if (careerIndex < 0) return normalized;
    return new URL(
      `/${segments.slice(0, careerIndex + 1).join('/')}`,
      url.origin,
    ).toString();
  } catch {
    return '';
  }
}

function careerUrlSignal(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      providerForUrl(value) !== 'generic' ||
      /\b(careers?|jobs?|openings?|positions?|vacanc(?:y|ies))\b/i.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}

function companyRootUrl(value: string): string {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    return `${url.origin}/`;
  } catch {
    return '';
  }
}

function chooseCompanyWebsiteUrl(urls: string[], companyName: string): string {
  const candidates = uniqueUrls(urls)
    .filter((url) => !ignoredCompanyOutboundUrl(url))
    .map((url) => {
      const root = companyRootUrl(url);
      return root || url;
    });
  const sorted = uniqueUrls(candidates).sort(
    (left, right) =>
      companyHostScore(right, companyName) -
      companyHostScore(left, companyName),
  );
  return sorted[0] ?? '';
}

function chooseCareersUrl(urls: string[]): string {
  return (
    uniqueUrls(urls)
      .filter((url) => !ignoredCompanyOutboundUrl(url))
      .filter(careerUrlSignal)
      .map(careersIndexUrl)
      .find(Boolean) ?? ''
  );
}

async function fetchPublicText(
  fetchImpl: FetchLike,
  url: string,
): Promise<string> {
  try {
    const response = await fetchImpl(url, {
      headers: COMPANY_DISCOVERY_HEADERS,
    });
    if (!response.ok) return '';
    const contentType = response.headers.get('content-type') ?? '';
    if (
      contentType &&
      !/\b(text|html|json|javascript|xml)\b/i.test(contentType)
    ) {
      return '';
    }
    return await response.text();
  } catch {
    return '';
  }
}

async function publicCareersUrl(
  fetchImpl: FetchLike,
  value: string,
): Promise<string> {
  const careersUrl = careersIndexUrl(value);
  if (!careersUrl || !sourceProviderIsCrawlable({ url: careersUrl }, true))
    return '';
  const html = await fetchPublicText(fetchImpl, careersUrl);
  if (!html) return '';
  if (providerForUrl(careersUrl) !== 'generic') return careersUrl;
  const text = htmlToPlainText(html).slice(0, 8000);
  return /\b(careers?|jobs?|open positions?|openings?|roles?|vacanc(?:y|ies))\b/i.test(
    `${careersUrl}\n${text}`,
  )
    ? careersUrl
    : '';
}

async function discoverCareersUrlFromWebsite(
  websiteUrl: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const root = companyRootUrl(websiteUrl) || normalizeHttpUrl(websiteUrl);
  if (!root) return '';

  if (careerUrlSignal(websiteUrl)) {
    const direct = await publicCareersUrl(fetchImpl, websiteUrl);
    if (direct) return direct;
  }

  const homepageHtml = await fetchPublicText(fetchImpl, root);
  const links = homepageHtml ? htmlLinks(homepageHtml, root) : [];
  const linkedCareers = links
    .filter(
      (link) =>
        careerUrlSignal(link.href) ||
        /\b(careers?|jobs?|open positions?|openings?|roles?)\b/i.test(
          link.text,
        ),
    )
    .map((link) => link.href);
  const commonCareers = COMMON_CAREERS_PATHS.map((path) =>
    new URL(path, root).toString(),
  );

  for (const candidate of uniqueUrls([...linkedCareers, ...commonCareers])) {
    const careersUrl = await publicCareersUrl(fetchImpl, candidate);
    if (careersUrl) return careersUrl;
  }
  return '';
}

type CandidateAliasKind = 'direct' | 'relist' | 'alternate_url';
type RootPostingResolutionStatus =
  | 'resolved_root'
  | 'direct_root'
  | 'unresolved_alias'
  | 'invalid';

interface RootPostingResolution {
  aliasKind: CandidateAliasKind;
  candidate: OpportunitySourceCandidate;
  discoveredUrl: string;
  resolutionStatus: RootPostingResolutionStatus;
  rootPostingUrl: string;
}

const RELIST_HOST_MARKERS = [
  'linkedin.',
  'indeed.',
  'ziprecruiter.',
  'glassdoor.',
  'monster.',
  'simplyhired.',
  'dice.com',
  'talent.com',
  'jooble.',
  'careerjet.',
  'lensa.',
  'wellfound.com',
  'angel.co',
  'builtin.',
];

const DIRECT_ROOT_PROVIDERS = new Set([
  'ashby',
  'amazon-jobs',
  'aijobs',
  'automattic-careers',
  'apple-careers',
  'canonical-careers',
  'gemini-careers',
  'google-careers',
  'greenhouse',
  'lever',
  'microsoft-careers',
  'oracle-careers',
  'workday',
  'ycombinator',
]);

const ROOT_POSTING_URL_FIELDS = [
  'thirdPartyApplyUrl',
  'companyApplyUrl',
  'externalApplyUrl',
  'jobApplyUrl',
  'applyUrl',
  'applyLink',
  'dispatchUrl',
  'externalUrl',
  'jobUrl',
  'canonicalUrl',
  'url',
];

function isRelistUrl(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const provider = providerForUrl(url.toString());
    if (DIRECT_ROOT_PROVIDERS.has(provider)) return false;
    if (provider === 'linkedin' || provider === 'wellfound') return true;
    const host = url.hostname.toLowerCase();
    return RELIST_HOST_MARKERS.some((marker) => host.includes(marker));
  } catch {
    return false;
  }
}

function isSpecificRootPostingUrl(value: unknown): boolean {
  const normalized = normalizeHttpUrl(value);
  if (!normalized || !isApplyableJobUrl(normalized)) return false;
  if (isRelistUrl(normalized)) return false;

  try {
    const url = new URL(normalized);
    const provider = providerForUrl(normalized);
    if (
      !DIRECT_ROOT_PROVIDERS.has(provider) &&
      ignoredCompanyOutboundUrl(normalized)
    ) {
      return false;
    }
    if (provider === 'ashby' || provider === 'lever') {
      return url.pathname.split('/').filter(Boolean).length >= 2;
    }
    if (provider === 'greenhouse') return Boolean(greenhouseJobToken(url));
    if (provider === 'workday') return /\/job\//i.test(url.pathname);
    if (provider !== 'generic') return true;

    const careersIndex = careersIndexUrl(normalized);
    if (careersIndex && careersIndex === normalized) return false;
    return (
      GENERIC_POSTING_URL_NEEDLES.some((needle) =>
        url.pathname.toLowerCase().includes(needle.toLowerCase()),
      ) || /\b(job|position|opening|role|req|requisition)\b/i.test(url.search)
    );
  } catch {
    return false;
  }
}

function applyUrlSignal(text: string): boolean {
  return /\b(apply|company site|employer site|careers?|jobs?|opening|role|posting)\b/i.test(
    text,
  );
}

function rootPostingUrlScore(
  value: string,
  text: string,
  baseUrl: string,
): number {
  if (!isSpecificRootPostingUrl(value)) return -1;
  let score = 0;
  const provider = providerForUrl(value);
  if (provider !== 'generic') score += 12;
  if (applyUrlSignal(text)) score += 8;
  if (careerUrlSignal(value)) score += 4;
  try {
    const target = new URL(value);
    const base = new URL(baseUrl);
    if (target.hostname !== base.hostname) score += 3;
  } catch {
    return -1;
  }
  return score;
}

function keyedRootPostingUrls(html: string, baseUrl: string): string[] {
  const decoded = decodeHtmlEntities(html)
    .replace(/\\\//g, '/')
    .replace(/\\u002[fF]/g, '/');
  const fields = ROOT_POSTING_URL_FIELDS.join('|');
  const pattern = new RegExp(
    `["'](?:${fields})["']\\s*:\\s*["']([^"']+)["']`,
    'gi',
  );
  const urls: string[] = [];
  for (const match of decoded.matchAll(pattern)) {
    const normalized = normalizeHttpUrl(match[1], baseUrl);
    if (normalized) urls.push(unwrapRelistRedirect(normalized));
  }
  return urls;
}

function rootPostingUrlFromHtml(html: string, baseUrl: string): string {
  const linkCandidates = htmlLinks(html, baseUrl).map((link) => ({
    text: link.text,
    url: link.href,
  }));
  const embeddedCandidates = [
    ...keyedRootPostingUrls(html, baseUrl).map((url) => ({
      text: 'apply url',
      url,
    })),
    ...embeddedHttpUrls(html, baseUrl).map((url) => ({ text: '', url })),
  ];

  return (
    [...linkCandidates, ...embeddedCandidates]
      .map((candidate, index) => ({
        index,
        score: rootPostingUrlScore(candidate.url, candidate.text, baseUrl),
        url: normalizeHttpUrl(candidate.url),
      }))
      .filter((candidate) => candidate.score >= 0 && candidate.url)
      .sort(
        (left, right) => right.score - left.score || left.index - right.index,
      )
      .map((candidate) => candidate.url)[0] ?? ''
  );
}

function candidateWithRootResolution(
  candidate: OpportunitySourceCandidate,
  options: {
    aliasKind: CandidateAliasKind;
    discoveredUrl: string;
    resolutionStatus: RootPostingResolutionStatus;
    rootPostingUrl: string;
  },
): OpportunitySourceCandidate {
  const rootPostingUrl = normalizeHttpUrl(options.rootPostingUrl);
  const discoveredUrl =
    normalizeHttpUrl(options.discoveredUrl) || options.discoveredUrl;
  const resolvedDetail =
    rootPostingUrl &&
    candidate.resolvedDetail?.canonicalUrl &&
    normalizeHttpUrl(candidate.resolvedDetail.canonicalUrl) === rootPostingUrl
      ? candidate.resolvedDetail
      : undefined;
  return {
    ...candidate,
    aliasKind: options.aliasKind,
    canonicalUrl: rootPostingUrl || candidate.canonicalUrl,
    discoveredUrl,
    postingUrl: rootPostingUrl || candidate.postingUrl,
    resolvedDetail,
    resolutionStatus: options.resolutionStatus,
    rootPostingUrl,
  };
}

function unresolvedAliasResolution(
  candidate: OpportunitySourceCandidate,
  discoveredUrl: string,
): RootPostingResolution {
  return {
    aliasKind: 'relist',
    candidate: candidateWithRootResolution(candidate, {
      aliasKind: 'relist',
      discoveredUrl,
      resolutionStatus: 'unresolved_alias',
      rootPostingUrl: '',
    }),
    discoveredUrl,
    resolutionStatus: 'unresolved_alias',
    rootPostingUrl: '',
  };
}

export async function resolveRootPosting(
  candidate: OpportunitySourceCandidate,
  fetchImpl: FetchLike = fetch,
): Promise<RootPostingResolution> {
  const discoveredUrl =
    normalizeHttpUrl(candidate.discoveredUrl || candidate.postingUrl) ||
    stringValue(candidate.discoveredUrl || candidate.postingUrl);
  if (!isApplyableJobUrl(discoveredUrl)) {
    return {
      aliasKind: 'direct',
      candidate: candidateWithRootResolution(candidate, {
        aliasKind: 'direct',
        discoveredUrl,
        resolutionStatus: 'invalid',
        rootPostingUrl: '',
      }),
      discoveredUrl,
      resolutionStatus: 'invalid',
      rootPostingUrl: '',
    };
  }

  const canonicalUrl = normalizeHttpUrl(candidate.canonicalUrl);
  const candidateIsRelist =
    isRelistUrl(candidate.postingUrl) ||
    isRelistUrl(candidate.canonicalUrl) ||
    isRelistUrl(discoveredUrl);

  if (
    !candidateIsRelist &&
    canonicalUrl &&
    canonicalUrl !== discoveredUrl &&
    isSpecificRootPostingUrl(canonicalUrl)
  ) {
    const resolvedCandidate = candidateWithRootResolution(candidate, {
      aliasKind: 'alternate_url',
      discoveredUrl,
      resolutionStatus: 'resolved_root',
      rootPostingUrl: canonicalUrl,
    });
    return {
      aliasKind: 'alternate_url',
      candidate: resolvedCandidate,
      discoveredUrl,
      resolutionStatus: 'resolved_root',
      rootPostingUrl: canonicalUrl,
    };
  }

  if (!candidateIsRelist) {
    const rootPostingUrl =
      canonicalUrl || normalizeHttpUrl(candidate.postingUrl);
    const resolvedCandidate = candidateWithRootResolution(candidate, {
      aliasKind: 'direct',
      discoveredUrl,
      resolutionStatus: 'direct_root',
      rootPostingUrl,
    });
    return {
      aliasKind: 'direct',
      candidate: resolvedCandidate,
      discoveredUrl,
      resolutionStatus: 'direct_root',
      rootPostingUrl,
    };
  }

  const pagesToFetch = uniqueUrls([
    candidate.postingUrl,
    candidate.canonicalUrl || '',
    discoveredUrl,
  ]).slice(0, 3);
  for (const pageUrl of pagesToFetch) {
    const html = await fetchPublicText(fetchImpl, pageUrl);
    if (!html) continue;
    const rootPostingUrl = rootPostingUrlFromHtml(html, pageUrl);
    if (!rootPostingUrl) continue;
    const resolvedCandidate = candidateWithRootResolution(candidate, {
      aliasKind: 'relist',
      discoveredUrl,
      resolutionStatus: 'resolved_root',
      rootPostingUrl,
    });
    return {
      aliasKind: 'relist',
      candidate: resolvedCandidate,
      discoveredUrl,
      resolutionStatus: 'resolved_root',
      rootPostingUrl,
    };
  }

  return unresolvedAliasResolution(candidate, discoveredUrl);
}

async function discoverCompanyMetadataForCandidate(
  candidate: OpportunitySourceCandidate,
  fetchImpl: FetchLike,
): Promise<CompanyMetadata> {
  const name = displayTitle(candidate.companyName);
  const linkedinUrl = normalizeLinkedInCompanyUrl(candidate.companyLinkedinUrl);
  let websiteUrl = normalizeHttpUrl(candidate.companyWebsiteUrl);
  let careersUrl = normalizeHttpUrl(candidate.companyCareersUrl);
  const rootPostingUrl = normalizeHttpUrl(
    candidate.rootPostingUrl || candidate.canonicalUrl || candidate.postingUrl,
  );

  if (rootPostingUrl && !isRelistUrl(rootPostingUrl)) {
    careersUrl ||= careersIndexUrl(rootPostingUrl);
    if (!websiteUrl && providerForUrl(rootPostingUrl) === 'generic') {
      websiteUrl = companyRootUrl(rootPostingUrl);
    }
  }

  const publicPages = uniqueUrls(
    [
      rootPostingUrl && !isRelistUrl(rootPostingUrl) ? rootPostingUrl : '',
      websiteUrl,
      careersUrl,
      providerForUrl(candidate.postingUrl) === 'linkedin'
        ? candidate.postingUrl
        : '',
      providerForUrl(candidate.canonicalUrl) === 'linkedin'
        ? stringValue(candidate.canonicalUrl)
        : '',
      linkedinUrl,
    ].filter(Boolean),
  ).slice(0, 5);
  const outboundUrls: string[] = [];

  for (const pageUrl of publicPages) {
    const html = await fetchPublicText(fetchImpl, pageUrl);
    if (!html) continue;
    outboundUrls.push(
      ...htmlLinks(html, pageUrl).map((link) => link.href),
      ...embeddedHttpUrls(html, pageUrl),
    );
  }

  careersUrl ||= chooseCareersUrl(outboundUrls);
  websiteUrl ||= chooseCompanyWebsiteUrl(outboundUrls, name);
  if (!websiteUrl && careersUrl) websiteUrl = companyRootUrl(careersUrl);
  if (!careersUrl && websiteUrl) {
    careersUrl = await discoverCareersUrlFromWebsite(websiteUrl, fetchImpl);
  } else if (careersUrl) {
    careersUrl = await publicCareersUrl(fetchImpl, careersUrl);
  }

  return {
    careersUrl,
    linkedinUrl,
    name,
    websiteUrl,
  };
}

async function firstRecordBy(
  collection: ListableCollection,
  where: Record<string, unknown>,
): Promise<MutableRecord | null> {
  const records = (await collection.list({
    limit: 1,
    where,
  })) as MutableRecord[];
  return records[0] ?? null;
}

async function ensureCareersSourceForCompany(
  metadata: CompanyMetadata,
  parentSourceId: string,
): Promise<string> {
  const careersUrl = stringValue(metadata.careersUrl);
  if (!careersUrl || !sourceProviderIsCrawlable({ url: careersUrl }, true))
    return '';

  const sources = await getCollection('Source');
  const existing = await firstRecordBy(sources, { url: careersUrl });
  if (existing) return stringValue(existing.id);

  const source = (await sources.create({
    accountNotes: 'Auto-added from opportunity root posting discovery.',
    accountStatus: 'none_needed',
    isActive: false,
    name: metadata.name ? `${metadata.name} careers` : 'Company careers',
    parentSourceId,
    provider: 'unknown',
    refreshCadence: 'weekly',
    sourceRole: 'posting_derived',
    type: 'company_careers',
    url: careersUrl,
  })) as unknown as MutableRecord;
  await source.save();
  return stringValue(source.id);
}

async function ensureCompanyForCandidate(
  candidate: OpportunitySourceCandidate,
  fetchImpl: FetchLike,
  dryRun?: boolean,
  parentSourceId = '',
): Promise<string> {
  if (dryRun) return '';
  const companyName = displayTitle(candidate.companyName);
  if (!companyName) return '';
  const rootPostingUrl = normalizeHttpUrl(
    candidate.rootPostingUrl || candidate.canonicalUrl || candidate.postingUrl,
  );
  const canInferFromRoot =
    rootPostingUrl &&
    !isRelistUrl(rootPostingUrl) &&
    isSpecificRootPostingUrl(rootPostingUrl);
  if (
    !candidate.companyLinkedinUrl &&
    !candidate.companyWebsiteUrl &&
    !candidate.companyCareersUrl &&
    !canInferFromRoot
  ) {
    return '';
  }

  const metadata = await discoverCompanyMetadataForCandidate(
    candidate,
    fetchImpl,
  );
  const companyKey = companyKeyFromName(companyName);
  if (!companyKey) return '';

  const companies = await getCollection('Company');
  const existing =
    (await firstRecordBy(companies, { companyKey })) ||
    (metadata.linkedinUrl
      ? await firstRecordBy(companies, { linkedinUrl: metadata.linkedinUrl })
      : null) ||
    (await firstRecordBy(companies, { name: companyName }));

  if (existing) {
    let changed = false;
    for (const [key, value] of [
      ['careersUrl', metadata.careersUrl],
      ['linkedinUrl', metadata.linkedinUrl],
      ['websiteUrl', metadata.websiteUrl],
    ] as const) {
      if (value && !stringValue(existing[key])) {
        existing[key] = value;
        changed = true;
      }
    }
    if (changed) await existing.save();
    await ensureCareersSourceForCompany(
      {
        ...metadata,
        careersUrl: stringValue(existing.careersUrl) || metadata.careersUrl,
        websiteUrl: stringValue(existing.websiteUrl) || metadata.websiteUrl,
      },
      parentSourceId,
    );
    return stringValue(existing.id);
  }

  const company = (await companies.create({
    careersUrl: metadata.careersUrl,
    companyKey,
    linkedinUrl: metadata.linkedinUrl,
    name: companyName,
    researchStatus:
      metadata.careersUrl || metadata.websiteUrl ? 'partial' : 'needed',
    websiteUrl: metadata.websiteUrl,
  })) as unknown as MutableRecord;
  await company.save();
  await ensureCareersSourceForCompany(metadata, parentSourceId);
  return stringValue(company.id);
}

async function findExistingOpportunity(
  candidate: OpportunitySourceCandidate,
  sourceId: string,
  detail?: Extract<OpportunityDetailResult, { status: 'resolved' }>,
) {
  const opportunities = await getCollection('Opportunity');
  const urls = new Set(
    [
      detail?.canonicalUrl,
      candidate.rootPostingUrl,
      candidate.canonicalUrl,
      candidate.postingUrl,
      candidate.discoveredUrl,
    ]
      .map((value) => normalizeHttpUrl(value))
      .filter(Boolean),
  );
  const externalIds = new Set(
    [detail?.externalId, candidate.externalId]
      .map((value) => stringValue(value))
      .filter(Boolean),
  );

  return await findUniqueOpportunityIdentityMatch(
    [
      ...[...urls].flatMap((url) => [
        { canonicalUrl: url },
        { postingUrl: url },
      ]),
      ...[...externalIds].map((externalId) => ({ sourceId, externalId })),
    ],
    async (where) =>
      (await opportunities.list({
        limit: 2,
        where,
      })) as unknown as MutableRecord[],
  );
}

/** Resolve every candidate identity and fail closed on conflicting records. */
export async function findUniqueOpportunityIdentityMatch(
  identities: Array<{
    canonicalUrl?: string;
    externalId?: string;
    postingUrl?: string;
    sourceId?: string;
  }>,
  lookup: (where: {
    canonicalUrl?: string;
    externalId?: string;
    postingUrl?: string;
    sourceId?: string;
  }) => Promise<MutableRecord[]>,
): Promise<MutableRecord | null> {
  const matches = new Map<string, MutableRecord>();
  for (const where of identities) {
    for (const opportunity of await lookup(where)) {
      const id = stringValue(opportunity.id);
      if (id) matches.set(id, opportunity);
    }
  }
  if (matches.size > 1) {
    throw new Error(
      `Opportunity identity is ambiguous across ${matches.size} durable records.`,
    );
  }
  return matches.values().next().value ?? null;
}

async function resolveCandidate(
  candidate: OpportunitySourceCandidate,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  if (candidate.resolvedDetail) return candidate.resolvedDetail;
  return await resolveOpportunityDetails(
    {
      postingUrl: candidate.canonicalUrl || candidate.postingUrl,
      title: candidate.title,
    },
    fetchImpl,
  );
}

function seedRootApplyFields(
  opportunity: Record<string, unknown>,
  candidate: OpportunitySourceCandidate,
): void {
  const rootPostingUrl =
    normalizeHttpUrl(candidate.rootPostingUrl) ||
    normalizeHttpUrl(opportunity.canonicalUrl) ||
    normalizeHttpUrl(opportunity.postingUrl);
  if (!rootPostingUrl || isRelistUrl(rootPostingUrl)) return;

  if (!stringValue(opportunity.applyUrl)) {
    opportunity.applyUrl = rootPostingUrl;
  }
  const applyMethod = stringValue(opportunity.applyMethod);
  if (!applyMethod || applyMethod === 'unknown') {
    opportunity.applyMethod = 'company_site';
  }
}

async function createSourceCrawlItem(options: {
  attemptKey?: string;
  candidate: OpportunitySourceCandidate;
  contentFingerprint?: string;
  contentVersion?: number;
  dryRun?: boolean;
  intelligenceEnqueueStatus?: string;
  opportunityId?: string;
  outcome?: string;
  reason?: string;
  sourceCrawlId: string;
  status: string;
}) {
  if (options.dryRun) return null;

  const collection = await getCollection('SourceCrawlItem');
  const item = await collection.create({
    attemptKey: stringValue(options.attemptKey),
    canonicalUrl: stringValue(
      options.candidate.rootPostingUrl || options.candidate.canonicalUrl,
    ),
    companyName: stringValue(options.candidate.companyName),
    contentFingerprint: stringValue(options.contentFingerprint),
    contentVersion: options.contentVersion ?? 0,
    externalId: stringValue(options.candidate.externalId),
    intelligenceEnqueueStatus:
      options.intelligenceEnqueueStatus ?? 'ineligible',
    opportunityId: stringValue(options.opportunityId) || null,
    outcome: options.outcome ?? 'pending',
    postingUrl: stringValue(
      options.candidate.discoveredUrl || options.candidate.postingUrl,
    ),
    rawJson: safeJson(options.candidate.rawJson),
    reason: stringValue(options.reason),
    reconciliationStatus: options.opportunityId ? 'matched' : 'unmatched',
    sourceCrawlId: options.sourceCrawlId,
    status: options.status,
    title: options.candidate.title,
  });
  await item.save();
  return item;
}

async function finalizeSourceCrawlItem(
  item: MutableRecord | null,
  values: Record<string, unknown>,
): Promise<void> {
  if (!item) return;
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, item[key]]),
  );
  Object.assign(item, values);
  try {
    await item.save();
  } catch (error) {
    Object.assign(item, previous);
    throw error;
  }
}

async function getSourceCrawlAccountingWriter(
  dryRun?: boolean,
): Promise<SourceCrawlAccountingWriter> {
  const database = dryRun ? null : await resolveDatabase(getDbConfig());
  if (database?.query && typeof database.transaction === 'function') {
    return {
      createAttempt: async ({ attemptKey, candidate, sourceCrawlId }) =>
        (await createSourceCrawlAttempt(database, {
          attemptKey,
          canonicalUrl: stringValue(candidate.canonicalUrl),
          companyName: stringValue(candidate.companyName),
          externalId: stringValue(candidate.externalId),
          postingUrl: stringValue(
            candidate.discoveredUrl || candidate.postingUrl,
          ),
          rawJson: safeJson(candidate.rawJson),
          sourceCrawlId,
          title: candidate.title,
        })) as unknown as MutableRecord,
      finalizeAttempt: async (input) => {
        const record = await finalizeSourceCrawlAttempt(database, input);
        return (await (
          await getCollection('SourceCrawlItem')
        ).get(record.id)) as unknown as MutableRecord | null;
      },
      prepareAttempt: async ({
        attemptKey,
        candidate,
        detail,
        sourceCrawlId,
      }) =>
        (await prepareSourceCrawlAttempt(database, {
          attemptKey,
          canonicalUrl: stringValue(
            detail.canonicalUrl || candidate.canonicalUrl,
          ),
          companyName: stringValue(candidate.companyName),
          externalId: stringValue(detail.externalId || candidate.externalId),
          postingUrl: stringValue(
            candidate.discoveredUrl || candidate.postingUrl,
          ),
          rawJson: sourceCrawlAttemptRawJson(candidate, detail),
          sourceCrawlId,
          title: candidate.title,
        })) as unknown as MutableRecord,
      persistCreatedOpportunity: async ({ persist, ...input }) =>
        (
          await persistCreatedSourceCrawlAttempt(
            database,
            input,
            async (transaction) => await persist(transaction),
          )
        ).value,
      recordPersistenceIntent: async (input) =>
        (await recordSourceCrawlAttemptPersistenceIntent(
          database,
          input,
        )) as unknown as MutableRecord,
      recordTerminalIntent: async (input) =>
        (await recordSourceCrawlAttemptTerminalIntent(
          database,
          input,
        )) as unknown as MutableRecord,
      recoverAttempt: async (input) =>
        await recoverSourceCrawlAttempt(database, input),
      reconcile: async (sourceCrawlId, options) =>
        await reconcileSourceCrawlAccounting(database, sourceCrawlId, options),
      durable: true,
    };
  }

  // Unit-test and dry-run fallback. Production databases always use the
  // transactional SQL implementation above.
  return {
    createAttempt: async ({ attemptKey, candidate, sourceCrawlId }) =>
      (await createSourceCrawlItem({
        attemptKey,
        candidate,
        dryRun,
        sourceCrawlId,
        status: 'pending',
      })) as unknown as MutableRecord | null,
    finalizeAttempt: async (input) => {
      if (dryRun) return null;
      const items = await getCollection('SourceCrawlItem');
      const [item] = (await items.list({
        limit: 1,
        where: {
          attemptKey: input.attemptKey,
          sourceCrawlId: input.sourceCrawlId,
        },
      })) as unknown as MutableRecord[];
      await finalizeSourceCrawlItem(
        item ?? null,
        Object.fromEntries(
          Object.entries({
            canonicalUrl: input.canonicalUrl,
            companyName: input.companyName,
            contentFingerprint: input.contentFingerprint,
            contentVersion: input.contentVersion,
            externalId: input.externalId,
            opportunityId: stringValue(input.opportunityId) || null,
            outcome: input.outcome,
            postingUrl: input.postingUrl,
            rawJson: input.rawJson,
            reason: stringValue(input.reason),
            status: input.status,
            terminalAt: new Date(),
            title: input.title,
          }).filter(([, value]) => value !== undefined),
        ),
      );
      return item ?? null;
    },
    prepareAttempt: async ({
      attemptKey,
      candidate,
      detail,
      sourceCrawlId,
    }) => {
      if (dryRun) return null;
      const items = await getCollection('SourceCrawlItem');
      const [item] = (await items.list({
        limit: 1,
        where: { attemptKey, sourceCrawlId },
      })) as unknown as MutableRecord[];
      await finalizeSourceCrawlItem(item ?? null, {
        canonicalUrl: stringValue(
          detail.canonicalUrl || candidate.canonicalUrl,
        ),
        companyName: stringValue(candidate.companyName),
        externalId: stringValue(detail.externalId || candidate.externalId),
        postingUrl: stringValue(
          candidate.discoveredUrl || candidate.postingUrl,
        ),
        rawJson: sourceCrawlAttemptRawJson(candidate, detail),
        status: 'pending',
        title: candidate.title,
      });
      return item ?? null;
    },
    recordPersistenceIntent: async ({
      attemptKey,
      intent,
      opportunityId,
      sourceCrawlId,
    }) => {
      if (dryRun) return null;
      const items = await getCollection('SourceCrawlItem');
      const [item] = (await items.list({
        limit: 1,
        where: { attemptKey, sourceCrawlId },
      })) as unknown as MutableRecord[];
      await finalizeSourceCrawlItem(item ?? null, {
        status: `pending_${intent}:${opportunityId}`,
      });
      return item ?? null;
    },
    recordTerminalIntent: async ({
      attemptKey,
      outcome,
      sourceCrawlId,
      status,
    }) => {
      if (dryRun) return null;
      const items = await getCollection('SourceCrawlItem');
      const [item] = (await items.list({
        limit: 1,
        where: { attemptKey, sourceCrawlId },
      })) as unknown as MutableRecord[];
      await finalizeSourceCrawlItem(item ?? null, {
        status: `pending_${outcome}:${status}`,
      });
      return item ?? null;
    },
    recoverAttempt: async () => null,
    reconcile: async () => {
      throw new Error('Durable crawl accounting is unavailable.');
    },
    durable: false,
  };
}

function isRelistedCandidate(candidate: OpportunitySourceCandidate): boolean {
  if (candidate.aliasKind === 'relist') return true;
  const discovered = normalizeHttpUrl(
    candidate.discoveredUrl || candidate.postingUrl,
  );
  const root = normalizeHttpUrl(
    candidate.rootPostingUrl || candidate.canonicalUrl,
  );
  return Boolean(
    discovered && root && discovered !== root && isRelistUrl(discovered),
  );
}

function sourceContentForCandidate(
  candidate: OpportunitySourceCandidate,
  detail: Extract<OpportunityDetailResult, { status: 'resolved' }>,
  existing: OpportunitySourceContent = {},
): OpportunitySourceContent {
  const ownValue = (
    field: keyof OpportunitySourceContent,
    ...records: Array<Record<string, unknown>>
  ) => {
    for (const record of records) {
      if (Object.hasOwn(record, field) && record[field] !== undefined) {
        return { found: true, value: record[field] };
      }
    }
    return { found: false, value: existing[field] };
  };
  const detailRecord = detail as unknown as Record<string, unknown>;
  const candidateRecord = candidate as unknown as Record<string, unknown>;
  const text = (field: keyof OpportunitySourceContent) => {
    const selected = ownValue(field, detailRecord, candidateRecord);
    return selected.found ? stringValue(selected.value) : selected.value;
  };
  const number = (field: keyof OpportunitySourceContent) =>
    ownValue(field, detailRecord, candidateRecord).value ?? null;
  const enumValue = (field: 'employmentType' | 'workMode') => {
    const selected = ownValue(field, detailRecord, candidateRecord);
    if (!selected.found) return selected.value;
    const value = stringValue(selected.value);
    return value ? knownEnumValue(value) || 'unknown' : '';
  };
  return {
    canonicalUrl: detail.canonicalUrl,
    compNotes: text('compNotes'),
    currency: text('currency'),
    descriptionRaw: detail.descriptionRaw,
    employmentType: enumValue('employmentType'),
    equityMaxPercent: number('equityMaxPercent'),
    equityMinPercent: number('equityMinPercent'),
    externalId: text('externalId'),
    hourlyMax: number('hourlyMax'),
    hourlyMin: number('hourlyMin'),
    locationNotes: text('locationNotes'),
    postedAt: ownValue('postedAt', detailRecord, candidateRecord).value ?? null,
    preferredSkills: text('preferredSkills'),
    qualifications: text('qualifications'),
    requiredSkills: text('requiredSkills'),
    responsibilities: text('responsibilities'),
    salaryMax: number('salaryMax'),
    salaryMin: number('salaryMin'),
    title: text('title'),
    workMode: enumValue('workMode'),
  };
}

function sourceContentForOpportunity(
  opportunity: Record<string, unknown>,
): OpportunitySourceContent {
  return {
    canonicalUrl: opportunity.canonicalUrl || opportunity.postingUrl,
    compNotes: opportunity.compNotes,
    currency: opportunity.currency,
    descriptionRaw: opportunity.descriptionRaw,
    employmentType: opportunity.employmentType,
    equityMaxPercent: opportunity.equityMaxPercent,
    equityMinPercent: opportunity.equityMinPercent,
    externalId: opportunity.externalId,
    hourlyMax: opportunity.hourlyMax,
    hourlyMin: opportunity.hourlyMin,
    locationNotes: opportunity.locationNotes,
    postedAt: opportunity.postedAt,
    preferredSkills: opportunity.preferredSkills,
    qualifications: opportunity.qualifications,
    requiredSkills: opportunity.requiredSkills,
    responsibilities: opportunity.responsibilities,
    salaryMax: opportunity.salaryMax,
    salaryMin: opportunity.salaryMin,
    title: opportunity.title,
    workMode: opportunity.workMode,
  };
}

function storedSourceContentForOpportunity(
  opportunity: Record<string, unknown>,
): OpportunitySourceContent {
  return (
    parseOpportunitySourceContent(opportunity.sourceContentJson) ??
    sourceContentForOpportunity(opportunity)
  );
}

function applyOpportunitySourceContent(
  opportunity: Record<string, unknown>,
  sourceContent: OpportunitySourceContent,
): void {
  for (const key of [
    'compNotes',
    'currency',
    'descriptionRaw',
    'employmentType',
    'equityMaxPercent',
    'equityMinPercent',
    'externalId',
    'hourlyMax',
    'hourlyMin',
    'locationNotes',
    'postedAt',
    'preferredSkills',
    'qualifications',
    'requiredSkills',
    'responsibilities',
    'salaryMax',
    'salaryMin',
    'title',
    'workMode',
  ] as const) {
    if (key === 'employmentType' || key === 'workMode') {
      opportunity[key] = sourceContent[key] || 'unknown';
      continue;
    }
    const nullable = [
      'equityMaxPercent',
      'equityMinPercent',
      'hourlyMax',
      'hourlyMin',
      'postedAt',
      'salaryMax',
      'salaryMin',
    ].includes(key);
    opportunity[key] = sourceContent[key] ?? (nullable ? null : '');
  }
  opportunity.sourceContentJson = safeJson(sourceContent);
}

const opportunitySourceIdentityUpdateFields = [
  'canonicalUrl',
  'externalId',
  'freshness',
  'lastSeenAt',
  'postingUrl',
  'sourceContentFingerprint',
  'sourceContentJson',
  'sourceContentVersion',
  'sourceId',
] as const;

const opportunitySourceProjectionUpdateFields = [
  'compNotes',
  'currency',
  'descriptionRaw',
  'employmentType',
  'equityMaxPercent',
  'equityMinPercent',
  'hourlyMax',
  'hourlyMin',
  'locationNotes',
  'postedAt',
  'salaryMax',
  'salaryMin',
  'title',
  'workMode',
] as const;

const opportunityDerivedResetUpdateFields = [
  'applyInstructions',
  'descriptionSummary',
  'domainTags',
  'expiresAt',
  'founderSignal',
  'greenfieldSignal',
  'locations',
  'preferredSkills',
  'qualifications',
  'relocationSupported',
  'requiredSkills',
  'responsibilities',
  'roleTags',
  'seniority',
  'visaOrEorPossible',
] as const;

function snakeCaseField(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function opportunitySourceUpdates(
  opportunity: Record<string, unknown>,
  options: { materiallyChanged: boolean },
): Record<string, unknown> {
  const updates = Object.fromEntries(
    opportunitySourceIdentityUpdateFields.map((field) => [
      field,
      opportunity[field],
    ]),
  );
  if (options.materiallyChanged) {
    Object.assign(
      updates,
      Object.fromEntries(
        [
          ...opportunitySourceProjectionUpdateFields,
          ...opportunityDerivedResetUpdateFields,
        ].map((field) => [field, opportunity[field]]),
      ),
    );
    updates.sourceIntelligenceJobId = opportunity.sourceIntelligenceJobId;
    updates.sourceIntelligenceStatus = opportunity.sourceIntelligenceStatus;
  }
  return updates;
}

function resetOpportunityDerivedContent(
  opportunity: Record<string, unknown>,
): void {
  opportunity.applyInstructions = '';
  opportunity.domainTags = '';
  opportunity.expiresAt = null;
  opportunity.founderSignal = false;
  opportunity.greenfieldSignal = false;
  opportunity.locations = '';
  opportunity.relocationSupported = false;
  opportunity.roleTags = '';
  opportunity.seniority = 'unknown';
  opportunity.visaOrEorPossible = false;
}

/**
 * Optimistic fence for a source persistence write.
 *
 * A legacy row that has never been crawled under the source-content schema
 * carries `source_content_fingerprint IS NULL`, so an equality fence on the
 * empty fingerprint can never match and every match would retry until it
 * raised. An absent stored fingerprint therefore means "no prior version" and
 * the first successful match writes the fingerprint and version 1 as a
 * baseline. "Absent" is two states, not one: a legacy row holds SQL NULL, while
 * a row created through the SMRT model without source content holds the field
 * default `''`. The baseline fence matches either, so neither state can be
 * fenced out of its own first write. Once a fingerprint exists, the
 * fingerprint/version pair fences exactly as before, so a concurrent change
 * still loses the race — including a concurrent baseline write, which turns the
 * column non-empty and drops the loser out of this fence.
 */
export function opportunitySourceFenceCriteria(
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  also: Record<string, unknown> = {},
): Record<string, unknown> | Array<Array<Record<string, unknown>>> {
  if (!expectedFingerprint) {
    return [
      [{ id: opportunityId, ...also }, { source_content_fingerprint: null }],
      [{ id: opportunityId, ...also }, { source_content_fingerprint: '' }],
    ];
  }
  return {
    id: opportunityId,
    source_content_fingerprint: expectedFingerprint,
    source_content_version: expectedVersion,
    ...also,
  };
}

export async function defaultFencedOpportunitySourceUpdate(
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  updates: Record<string, unknown>,
): Promise<boolean> {
  const database = await resolveDatabase(getDbConfig());
  const result = await database.update(
    'opportunities',
    opportunitySourceFenceCriteria(
      opportunityId,
      expectedFingerprint,
      expectedVersion,
    ),
    {
      ...Object.fromEntries(
        Object.entries(updates).map(([key, value]) => [
          snakeCaseField(key),
          value,
        ]),
      ),
      updated_at: new Date(),
    },
  );
  if (result.affected === 0) return false;
  await bumpOpportunityChangeFeed(database, [opportunityId]);
  return true;
}

export async function defaultFencedOpportunityIntelligenceUpdate(
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  updates: {
    sourceIntelligenceJobId: string;
    sourceIntelligenceStatus: string;
  },
): Promise<boolean> {
  const database = await resolveDatabase(getDbConfig());
  const result = await database.update(
    'opportunities',
    opportunitySourceFenceCriteria(
      opportunityId,
      expectedFingerprint,
      expectedVersion,
    ),
    {
      source_intelligence_job_id: updates.sourceIntelligenceJobId,
      source_intelligence_status: updates.sourceIntelligenceStatus,
      updated_at: new Date(),
    },
  );
  if (result.affected === 0) return false;
  await bumpOpportunityChangeFeed(database, [opportunityId]);
  return true;
}

export async function defaultFencedOpportunityStatusUpdate(
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  expectedStatus: string,
  status: string,
): Promise<boolean> {
  const database = await resolveDatabase(getDbConfig());
  const result = await database.update(
    'opportunities',
    opportunitySourceFenceCriteria(
      opportunityId,
      expectedFingerprint,
      expectedVersion,
      { status: expectedStatus },
    ),
    { status, updated_at: new Date() },
  );
  if (result.affected === 0) return false;
  await bumpOpportunityChangeFeed(database, [opportunityId]);
  return true;
}

export async function defaultFencedOpportunityBackfillUpdate(
  opportunityId: string,
  expectedFingerprint: string,
  expectedVersion: number,
  expected: Record<string, unknown>,
  updates: Record<string, unknown>,
): Promise<boolean> {
  const database = await resolveDatabase(getDbConfig());
  const result = await database.update(
    'opportunities',
    opportunitySourceFenceCriteria(
      opportunityId,
      expectedFingerprint,
      expectedVersion,
      Object.fromEntries(
        Object.entries(expected).map(([key, value]) => [
          snakeCaseField(key),
          value,
        ]),
      ),
    ),
    {
      ...Object.fromEntries(
        Object.entries(updates).map(([key, value]) => [
          snakeCaseField(key),
          value,
        ]),
      ),
      updated_at: new Date(),
    },
  );
  if (result.affected === 0) return false;
  await bumpOpportunityChangeFeed(database, [opportunityId]);
  return true;
}

export function opportunityIdentityLockKeys(
  candidate: OpportunitySourceCandidate,
  sourceId: string,
  detail?: Extract<OpportunityDetailResult, { status: 'resolved' }>,
): string[] {
  const keys = new Set<string>();
  for (const value of [
    detail?.canonicalUrl,
    candidate.rootPostingUrl,
    candidate.canonicalUrl,
    candidate.postingUrl,
    candidate.discoveredUrl,
  ]) {
    const url = normalizeHttpUrl(value);
    if (url) keys.add(`url:${url}`);
  }
  for (const value of [detail?.externalId, candidate.externalId]) {
    const externalId = stringValue(value);
    if (externalId) keys.add(`external:${sourceId}:${externalId}`);
  }
  if (keys.size === 0) {
    keys.add(
      `fallback:${sourceId}:${normalizeText(candidate.title)}:${normalizeText(candidate.companyName)}`,
    );
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function sharesSeenOpportunityIdentity(
  seen: Set<string>,
  keys: string[],
): boolean {
  return keys.some((key) => seen.has(key));
}

function rememberOpportunityIdentities(
  seen: Set<string>,
  keys: string[],
): void {
  for (const key of keys) seen.add(key);
}

/**
 * Serializes every identity participating in dedupe. Sorting prevents two
 * alias variants from deadlocking while acquiring overlapping key sets.
 */
async function withOpportunityIdentityLocks<T>(
  candidate: OpportunitySourceCandidate,
  detail: Extract<OpportunityDetailResult, { status: 'resolved' }>,
  sourceId: string,
  dryRun: boolean | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (dryRun) return await work();
  const lockKeys = opportunityIdentityLockKeys(candidate, sourceId, detail);
  if (getDbConfig().type === 'sqlite') {
    // Local installs run one embedded source-crawl worker, but this lock also
    // protects a direct operator retry in another process. PostgreSQL advisory
    // SQL is deliberately confined to the hosted path below.
    return await withSqliteOperationLock(
      `opportunity-identities:${lockKeys.join('\n')}`,
      work,
    );
  }
  const database = await resolveDatabase(getDbConfig());
  if (typeof database.acquireSession !== 'function') return await work();

  const session = await database.acquireSession();
  return await withOpportunityIdentityKeyLocks(session, lockKeys, work);
}

/** Execute work while holding every supplied identity lock in sorted order. */
export async function withOpportunityIdentityKeyLocks<T>(
  session: {
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>;
    release?: () => Promise<void>;
  },
  lockKeys: string[],
  work: () => Promise<T>,
  options: { releaseSession?: boolean; statementTimeoutMs?: number } = {},
): Promise<T> {
  const acquired: string[] = [];
  try {
    await session.query("SELECT set_config('statement_timeout', ?, false)", [
      String(options.statementTimeoutMs ?? 30000),
    ]);
    for (const lockKey of [...new Set(lockKeys)].sort()) {
      await session.query('SELECT pg_advisory_lock(hashtextextended(?, 0))', [
        lockKey,
      ]);
      acquired.push(lockKey);
    }
    return await work();
  } finally {
    try {
      for (const lockKey of acquired.reverse()) {
        await session.query(
          'SELECT pg_advisory_unlock(hashtextextended(?, 0))',
          [lockKey],
        );
      }
    } finally {
      try {
        await session.query(
          "SELECT set_config('statement_timeout', '0', false)",
        );
      } finally {
        if (options.releaseSession !== false) await session.release?.();
      }
    }
  }
}

async function createOrUpdateOpportunity(options: {
  candidate: OpportunitySourceCandidate;
  detail: Extract<OpportunityDetailResult, { status: 'resolved' }>;
  dryRun?: boolean;
  fetchImpl: FetchLike;
  fencedBackfillUpdate: FencedOpportunityBackfillUpdate;
  fencedUpdate: FencedOpportunitySourceUpdate;
  fencedStatusUpdate: FencedOpportunityStatusUpdate;
  now: Date;
  persistCreatedOpportunity?: (input: {
    contentFingerprint: string;
    contentVersion: number;
    opportunityId: string;
    persist: (database: unknown) => Promise<MutableRecord>;
  }) => Promise<MutableRecord>;
  recordPersistenceIntent: (
    created: boolean,
    opportunityId: string,
  ) => Promise<void>;
  sourceId: string;
}) {
  const companyId = await ensureCompanyForCandidate(
    options.candidate,
    options.fetchImpl,
    options.dryRun,
    options.sourceId,
  );
  let existing = await findExistingOpportunity(
    options.candidate,
    options.sourceId,
    options.detail,
  );
  if (existing) {
    await options.recordPersistenceIntent(false, stringValue(existing.id));
  }
  for (let attempt = 0; existing && attempt < 3; attempt += 1) {
    const sourceContent = sourceContentForCandidate(
      options.candidate,
      options.detail,
      storedSourceContentForOpportunity(existing),
    );
    const contentFingerprint =
      fingerprintOpportunitySourceContent(sourceContent);
    const storedFingerprint = stringValue(existing.sourceContentFingerprint);
    const legacyFingerprint = fingerprintOpportunitySourceContent(
      sourceContentForOpportunity(existing),
    );
    const materiallyChanged = storedFingerprint
      ? storedFingerprint !== contentFingerprint
      : legacyFingerprint !== contentFingerprint;
    const storedVersion = Math.max(
      0,
      Math.trunc(numberValue(existing.sourceContentVersion) ?? 0),
    );
    const contentVersion =
      storedFingerprint && materiallyChanged
        ? Math.max(1, storedVersion) + 1
        : Math.max(1, storedVersion);
    const recoverableEnqueue =
      !materiallyChanged &&
      ['pending', 'enqueue_failed'].includes(
        stringValue(existing.sourceIntelligenceStatus),
      );
    const shouldInvalidateRecommendation =
      materiallyChanged && stringValue(existing.status) === 'recommended';
    if (options.dryRun) {
      return {
        contentFingerprint,
        contentVersion,
        created: false,
        intelligenceEligible: materiallyChanged || recoverableEnqueue,
        materiallyChanged,
        opportunity: existing,
        opportunityId: stringValue(existing.id),
        recommendationInvalidated: shouldInvalidateRecommendation,
      };
    }

    const next = { ...existing } as MutableRecord;
    const deterministicBackfills = { ...existing } as MutableRecord;
    seedRootApplyFields(deterministicBackfills, options.candidate);
    applyResolvedOpportunityDetails(next, options.detail, {
      now: options.now,
      refreshDescription:
        materiallyChanged || !stringValue(existing.descriptionRaw),
    });
    if (materiallyChanged) {
      applyOpportunitySourceContent(next, sourceContent);
      resetOpportunityDerivedContent(next);
    } else {
      next.sourceContentJson = safeJson(sourceContent);
    }
    next.sourceContentFingerprint = contentFingerprint;
    next.sourceContentVersion = contentVersion;
    if (materiallyChanged) {
      next.sourceIntelligenceJobId = '';
      next.sourceIntelligenceStatus = 'pending';
    }
    if (!stringValue(next.sourceId)) next.sourceId = options.sourceId;

    const sourceUpdates = opportunitySourceUpdates(next, {
      materiallyChanged,
    });

    const persisted = await options.fencedUpdate(
      stringValue(existing.id),
      storedFingerprint,
      storedVersion,
      sourceUpdates,
    );
    if (!persisted) {
      const current = (await (
        await getCollection('Opportunity')
      ).get(stringValue(existing.id))) as unknown as MutableRecord | null;
      if (!current) throw new Error('Opportunity disappeared during crawl.');
      existing = current;
      continue;
    }
    Object.assign(existing, sourceUpdates);
    const recommendationInvalidated = materiallyChanged
      ? await options.fencedStatusUpdate(
          stringValue(existing.id),
          contentFingerprint,
          contentVersion,
          'recommended',
          'found',
        )
      : false;
    if (recommendationInvalidated) existing.status = 'found';

    const companyBackfill = stringValue(companyId);
    if (!stringValue(existing.companyId) && companyBackfill) {
      const updated = await options.fencedBackfillUpdate(
        stringValue(existing.id),
        contentFingerprint,
        contentVersion,
        { companyId: '' },
        { companyId: companyBackfill },
      );
      if (updated) existing.companyId = companyBackfill;
    }

    const applyUrlBackfill = stringValue(deterministicBackfills.applyUrl);
    if (!stringValue(existing.applyUrl) && applyUrlBackfill) {
      const updated = await options.fencedBackfillUpdate(
        stringValue(existing.id),
        contentFingerprint,
        contentVersion,
        { applyUrl: '' },
        { applyUrl: applyUrlBackfill },
      );
      if (updated) existing.applyUrl = applyUrlBackfill;
    }
    const applyMethodBackfill = stringValue(deterministicBackfills.applyMethod);
    const existingApplyMethod = stringValue(existing.applyMethod);
    if (
      stringValue(existing.applyUrl) === applyUrlBackfill &&
      (!existingApplyMethod || existingApplyMethod === 'unknown') &&
      applyMethodBackfill &&
      applyMethodBackfill !== 'unknown'
    ) {
      const updated = await options.fencedBackfillUpdate(
        stringValue(existing.id),
        contentFingerprint,
        contentVersion,
        { applyMethod: existingApplyMethod || '', applyUrl: applyUrlBackfill },
        { applyMethod: applyMethodBackfill },
      );
      if (updated) existing.applyMethod = applyMethodBackfill;
    }
    return {
      contentFingerprint,
      contentVersion,
      created: false,
      intelligenceEligible: materiallyChanged || recoverableEnqueue,
      materiallyChanged,
      opportunity: existing,
      opportunityId: stringValue(existing.id),
      recommendationInvalidated,
    };
  }

  if (existing) {
    throw new Error(
      'Opportunity changed concurrently too many times during source persistence.',
    );
  }

  const sourceContent = sourceContentForCandidate(
    options.candidate,
    options.detail,
  );
  const contentFingerprint = fingerprintOpportunitySourceContent(sourceContent);
  if (options.dryRun)
    return {
      contentFingerprint,
      contentVersion: 1,
      created: true,
      intelligenceEligible: false,
      materiallyChanged: false,
      opportunity: null,
      opportunityId: '',
      recommendationInvalidated: false,
    };

  const intendedOpportunityId = randomUUID();
  const buildOpportunity = async (database?: unknown) => {
    const opportunities = await getCollection(
      'Opportunity',
      database ? { db: database as never } : {},
    );
    const opportunity = (await opportunities.create({
      _insertOnly: true,
      id: intendedOpportunityId,
      slug: `crawl-opportunity-${intendedOpportunityId}`,
      employmentType:
        knownEnumValue(options.detail.employmentType) ||
        knownEnumValue(options.candidate.employmentType) ||
        'unknown',
      externalId:
        options.detail.externalId || stringValue(options.candidate.externalId),
      firstSeenAt: options.now,
      freshness: 'fresh',
      lastSeenAt: options.now,
      companyId,
      locationNotes:
        options.detail.locationNotes ||
        stringValue(options.candidate.locationNotes),
      postedAt: options.detail.postedAt ?? options.candidate.postedAt ?? null,
      postingUrl: options.detail.canonicalUrl,
      sourceId: options.sourceId,
      sourceContentFingerprint: contentFingerprint,
      sourceContentVersion: 1,
      sourceContentJson: safeJson(sourceContent),
      sourceIntelligenceStatus: 'pending',
      status: 'found',
      title: options.detail.title || options.candidate.title,
      workMode:
        options.detail.workMode || options.candidate.workMode || 'unknown',
    })) as unknown as MutableRecord;
    applyResolvedOpportunityDetails(opportunity, options.detail, {
      now: options.now,
    });
    applyOpportunitySourceContent(opportunity, sourceContent);
    seedRootApplyFields(opportunity, options.candidate);
    return opportunity;
  };
  let opportunity: MutableRecord;
  if (options.persistCreatedOpportunity) {
    opportunity = await options.persistCreatedOpportunity({
      contentFingerprint,
      contentVersion: 1,
      opportunityId: intendedOpportunityId,
      persist: async (database) => {
        const record = await buildOpportunity(database);
        if (stringValue(record.id) !== intendedOpportunityId) {
          throw new Error(
            'Opportunity creation did not preserve its attributed id.',
          );
        }
        await record.save();
        return record;
      },
    });
  } else {
    opportunity = await buildOpportunity();
  }
  const pendingOpportunityId = stringValue(opportunity.id);
  if (!pendingOpportunityId) {
    throw new Error(
      'Opportunity creation did not allocate an id before persistence.',
    );
  }
  if (!options.persistCreatedOpportunity) {
    await options.recordPersistenceIntent(true, pendingOpportunityId);
    await opportunity.save();
  }
  const opportunityId = stringValue(opportunity.id);
  if (!opportunityId) {
    throw new Error(
      'Opportunity persistence completed without a durable opportunity ID.',
    );
  }
  return {
    contentFingerprint,
    contentVersion: 1,
    created: true,
    intelligenceEligible: true,
    materiallyChanged: false,
    opportunity,
    opportunityId,
    recommendationInvalidated: false,
  };
}

async function updateCrawlItemIntelligence(
  item: MutableRecord | null,
  values: { intelligenceEnqueueStatus: string; intelligenceJobId?: string },
) {
  if (!item) return;
  item.intelligenceEnqueueStatus = values.intelligenceEnqueueStatus;
  item.intelligenceJobId = stringValue(values.intelligenceJobId);
  await item.save();
}

async function updateOpportunityIntelligence(
  opportunity: MutableRecord,
  expectedFingerprint: string,
  expectedVersion: number,
  values: {
    sourceIntelligenceJobId?: string;
    sourceIntelligenceStatus: string;
  },
  update: FencedOpportunityIntelligenceUpdate,
) {
  const opportunityId = stringValue(opportunity.id);
  if (!opportunityId) return false;
  const updates = {
    sourceIntelligenceJobId: stringValue(values.sourceIntelligenceJobId),
    sourceIntelligenceStatus: values.sourceIntelligenceStatus,
  };
  const persisted = await update(
    opportunityId,
    expectedFingerprint,
    expectedVersion,
    updates,
  );
  if (persisted) Object.assign(opportunity, updates);
  return persisted;
}

async function persistIntelligenceOutcome(options: {
  candidate: OpportunitySourceCandidate;
  crawlItem: MutableRecord | null;
  intelligenceJobId?: string;
  intelligenceStatus: string;
  opportunityIntelligenceUpdate: FencedOpportunityIntelligenceUpdate;
  opportunity: MutableRecord;
  contentFingerprint: string;
  contentVersion: number;
  summary: CrawlOpportunitySourceSummary;
}) {
  const failures: string[] = [];
  try {
    await updateCrawlItemIntelligence(options.crawlItem, {
      intelligenceEnqueueStatus: options.intelligenceStatus,
      intelligenceJobId: options.intelligenceJobId,
    });
  } catch (error) {
    failures.push(
      `crawl item: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await updateOpportunityIntelligence(
      options.opportunity,
      options.contentFingerprint,
      options.contentVersion,
      {
        sourceIntelligenceJobId: options.intelligenceJobId,
        sourceIntelligenceStatus: options.intelligenceStatus,
      },
      options.opportunityIntelligenceUpdate,
    );
  } catch (error) {
    failures.push(
      `opportunity: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (failures.length > 0) {
    options.summary.errors.push(
      `${options.candidate.title || options.candidate.postingUrl}: intelligence provenance update failed (${failures.join('; ')})`,
    );
  }
}

async function enqueueSavedOpportunityIntelligence(options: {
  candidate: OpportunitySourceCandidate;
  contentFingerprint: string;
  contentVersion: number;
  crawlItem: MutableRecord | null;
  dryRun?: boolean;
  enqueueCap: number;
  enqueueBudget: { used: number };
  enqueuer: OpportunityIntelligenceEnqueuer;
  findActiveJob: OpportunityIntelligenceActiveJobFinder;
  intelligenceEligible: boolean;
  opportunity: MutableRecord;
  opportunityIntelligenceUpdate: FencedOpportunityIntelligenceUpdate;
  opportunityId: string;
  sourceCrawlId: string;
  sourceId: string;
  summary: CrawlOpportunitySourceSummary;
}) {
  if (options.dryRun || !options.opportunityId) return;
  if (!options.intelligenceEligible) {
    options.summary.intelligenceSkipped += 1;
    await updateCrawlItemIntelligence(options.crawlItem, {
      intelligenceEnqueueStatus: 'unchanged',
    });
    return;
  }

  if (options.enqueueCap === 0) {
    options.summary.intelligenceSkipped += 1;
    await persistIntelligenceOutcome({
      ...options,
      intelligenceStatus: 'disabled',
    });
    return;
  }
  if (options.enqueueBudget.used >= options.enqueueCap) {
    let activeJob: { id?: unknown } | null = null;
    try {
      activeJob = await options.findActiveJob(
        options.opportunityId,
        options.contentFingerprint,
      );
    } catch (error) {
      options.summary.errors.push(
        `${options.candidate.title || options.candidate.postingUrl}: active intelligence lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (activeJob) {
      options.summary.intelligenceDuplicateSuppressed += 1;
      await persistIntelligenceOutcome({
        ...options,
        intelligenceJobId: stringValue(activeJob.id),
        intelligenceStatus: 'duplicate_active',
      });
    } else {
      options.summary.intelligenceSkipped += 1;
      await persistIntelligenceOutcome({
        ...options,
        intelligenceStatus: 'cap_exhausted',
      });
    }
    return;
  }

  // Reserve before the create attempt. A throw after the queue commit is
  // ambiguous, so the slot stays consumed; only a confirmed no-create
  // duplicate releases it.
  options.enqueueBudget.used += 1;
  let result: OpportunityIntelligenceEnqueueResult;
  try {
    result = await options.enqueuer(
      options.opportunityId,
      {
        contentFingerprint: options.contentFingerprint,
        contentFingerprintVersion:
          OPPORTUNITY_SOURCE_CONTENT_FINGERPRINT_VERSION,
        contentVersion: options.contentVersion,
        modes: ['extract', 'score', 'evidence', 'quality'],
        reason: 'source-crawl',
        sourceCrawlId: options.sourceCrawlId,
        sourceCrawlItemId: stringValue(options.crawlItem?.id),
        sourceId: options.sourceId,
      },
      { reason: 'source-crawl' },
    );
  } catch (error) {
    options.summary.intelligenceSkipped += 1;
    await persistIntelligenceOutcome({
      ...options,
      intelligenceStatus: 'enqueue_failed',
    });
    const message = error instanceof Error ? error.message : String(error);
    options.summary.errors.push(
      `${options.candidate.title || options.candidate.postingUrl}: intelligence enqueue failed: ${message}`,
    );
    return;
  }

  if (result.enqueued) options.summary.intelligenceEnqueued += 1;
  else {
    options.enqueueBudget.used -= 1;
    options.summary.intelligenceDuplicateSuppressed += 1;
  }
  await persistIntelligenceOutcome({
    ...options,
    intelligenceJobId: stringValue(result.job.id),
    intelligenceStatus: result.enqueued ? 'queued' : 'duplicate_active',
  });
}

async function markCrawlFinished(
  crawl: MutableRecord | null,
  summary: CrawlOpportunitySourceSummary,
  dryRun?: boolean,
) {
  if (!crawl || dryRun) return;

  const completed = await completeSourceCrawl(crawl, {
    error: summary.errors.join('\n'),
    fields: {
      attemptCount: summary.candidates,
      duplicateCount: summary.duplicates,
      failedPersistenceCount: summary.failedPersistence,
      intelligenceDuplicateCount: summary.intelligenceDuplicateSuppressed,
      intelligenceEnqueuedCount: summary.intelligenceEnqueued,
      intelligenceSkippedCount: summary.intelligenceSkipped,
      newOpportunityCount: summary.created,
      pendingCount: 0,
      relistedCount: summary.relisted,
      resultCount: summary.candidates,
      skippedCount: summary.skipped,
      terminalCount: summary.candidates,
      reusedCount: summary.reused,
    },
    status: summary.errors.length ? 'completed_with_errors' : 'completed',
  });
  if (!completed) {
    throw new Error(
      `Source crawl ${stringValue(crawl.id)} completion is owned by terminal state ${stringValue(crawl.status) || 'unknown'}.`,
    );
  }
}

async function markCrawlFailed(
  crawl: MutableRecord | null,
  error: unknown,
  dryRun?: boolean,
) {
  if (!crawl || dryRun) return;

  await failSourceCrawl(crawl, error);
}

async function createSourceCrawl(
  source: SourceLike,
  intelligenceEnqueueCap: number,
  jobId: string | undefined,
  jobAttempt: number | undefined,
  dryRun?: boolean,
  requestedSourceCrawlId?: string,
) {
  const hasRequestedSourceCrawl = requestedSourceCrawlId !== undefined;
  const normalizedRequestedSourceCrawlId = exactNonblankBinding(
    requestedSourceCrawlId,
  );
  if (hasRequestedSourceCrawl && !normalizedRequestedSourceCrawlId) {
    throw new SourceCrawlOwnershipError(
      'Requested source crawl identifier must be an exact nonblank durable binding.',
    );
  }
  const requestedJobId = exactNonblankBinding(jobId);
  const requestedJobAttempt =
    typeof jobAttempt === 'number' &&
    Number.isInteger(jobAttempt) &&
    jobAttempt > 0
      ? jobAttempt
      : 0;
  const hasWorkerBinding = jobId !== undefined || jobAttempt !== undefined;
  if (hasWorkerBinding && (!requestedJobId || !requestedJobAttempt)) {
    throw new SourceCrawlOwnershipError(
      'Requested source crawl requires an exact worker job and positive attempt binding.',
    );
  }
  if (hasRequestedSourceCrawl && !requestedJobId) {
    throw new SourceCrawlOwnershipError(
      'Requested source crawl requires an exact worker job binding.',
    );
  }
  if (dryRun && !hasRequestedSourceCrawl) {
    return { crawl: null, skipExecution: false };
  }
  const collection = await getCollection('SourceCrawl');
  const existing = hasRequestedSourceCrawl
    ? await collection.get(normalizedRequestedSourceCrawlId)
    : null;
  if (hasRequestedSourceCrawl && !existing) {
    throw new SourceCrawlOwnershipError(
      `Requested source crawl ${normalizedRequestedSourceCrawlId} does not exist.`,
    );
  }
  const budget = resolveOpportunityIntelligenceBudgetConfig();
  const requestedSourceId = exactNonblankBinding(source.id);
  if (!requestedSourceId) {
    throw new SourceCrawlOwnershipError(
      'Source crawl requires an exact nonblank source binding.',
    );
  }
  if (existing) {
    const existingRecord = existing as unknown as MutableRecord;
    const existingCrawlId = exactNonblankBinding(existingRecord.id);
    const existingSourceId = exactNonblankBinding(existingRecord.sourceId);
    const existingJobId = exactNonblankBinding(existingRecord.jobId);
    if (
      !existingCrawlId ||
      !requestedSourceId ||
      !existingSourceId ||
      !existingJobId ||
      existingSourceId !== requestedSourceId ||
      existingJobId !== requestedJobId
    ) {
      throw new Error(
        `Source crawl ${stringValue(existingRecord.id)} belongs to a different operation.`,
      );
    }
    if (dryRun) return { crawl: null, skipExecution: false };
    const existingStatus = exactNonblankBinding(existingRecord.status);
    const existingJobAttempt =
      typeof existingRecord.jobAttempt === 'number' &&
      Number.isInteger(existingRecord.jobAttempt) &&
      existingRecord.jobAttempt > 0
        ? existingRecord.jobAttempt
        : 0;
    const hasFinishedAt =
      existingRecord.finishedAt instanceof Date &&
      !Number.isNaN(existingRecord.finishedAt.getTime());
    if (existingRecord.finishedAt != null && !hasFinishedAt) {
      throw new SourceCrawlOwnershipError(
        `Source crawl ${stringValue(existingRecord.id)} has an invalid finished-at binding.`,
      );
    }
    if (
      hasFinishedAt ||
      ['completed', 'completed_with_errors', 'failed', 'timed_out'].includes(
        existingStatus,
      )
    ) {
      if (!existingJobAttempt || existingJobAttempt !== requestedJobAttempt) {
        throw new SourceCrawlOwnershipError(
          `Source crawl ${stringValue(existingRecord.id)} is owned by another terminal job attempt.`,
        );
      }
      if (
        !hasFinishedAt ||
        !['completed', 'completed_with_errors'].includes(existingStatus)
      ) {
        throw new SourceCrawlOwnershipError(
          `Source crawl ${stringValue(existingRecord.id)} has an unreplayable terminal state.`,
        );
      }
      return { crawl: existingRecord, skipExecution: true };
    }
    if (existingStatus === 'running') {
      if (
        !requestedJobId ||
        !requestedJobAttempt ||
        existingJobId !== requestedJobId ||
        !existingJobAttempt ||
        requestedJobAttempt < existingJobAttempt
      ) {
        throw new SourceCrawlOwnershipError(
          `Source crawl ${stringValue(existingRecord.id)} is owned by another active attempt.`,
        );
      }
      const database = await resolveDatabase(getDbConfig());
      const owner = await database.query(
        `SELECT CAST(id AS TEXT) AS id
         FROM _smrt_jobs
         WHERE CAST(id AS TEXT) = ?
           AND CAST(object_id AS TEXT) = ?
           AND status = 'running'
           AND attempts = ?
           AND queue IN (?, ?)
           AND object_type = ?
           AND method = ?`,
        [
          requestedJobId,
          requestedSourceId,
          requestedJobAttempt,
          SOURCE_CRAWL_QUEUE,
          SCHEDULED_SOURCE_QUEUE,
          SOURCE_JOB_OBJECT_TYPE,
          SOURCE_CRAWL_METHOD,
        ],
      );
      if (owner.rows.length !== 1) {
        throw new SourceCrawlOwnershipError(
          `Source crawl ${stringValue(existingRecord.id)} has no active owning job attempt.`,
        );
      }
      if (requestedJobAttempt > existingJobAttempt) {
        const claimed = await database.query(
          `UPDATE source_crawls
           SET job_attempt = ?, started_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'running' AND finished_at IS NULL
             AND source_id = ? AND job_id = ? AND job_attempt = ?
             AND EXISTS (
               SELECT 1 FROM _smrt_jobs AS job
               WHERE CAST(job.id AS TEXT) = ?
                 AND CAST(job.object_id AS TEXT) = ?
                 AND job.status = 'running'
                 AND job.attempts = ?
                 AND job.queue IN (?, ?)
                 AND job.object_type = ?
                 AND job.method = ?
             )
           RETURNING id`,
          [
            requestedJobAttempt,
            stringValue(existingRecord.id),
            requestedSourceId,
            requestedJobId,
            existingJobAttempt,
            requestedJobId,
            requestedSourceId,
            requestedJobAttempt,
            SOURCE_CRAWL_QUEUE,
            SCHEDULED_SOURCE_QUEUE,
            SOURCE_JOB_OBJECT_TYPE,
            SOURCE_CRAWL_METHOD,
          ],
        );
        if (claimed.rows.length !== 1) {
          throw new SourceCrawlOwnershipError(
            `Source crawl ${stringValue(existingRecord.id)} active attempt changed before ownership could be acquired.`,
          );
        }
        existingRecord.jobAttempt = requestedJobAttempt;
        existingRecord.startedAt = new Date();
      }
      return { crawl: existingRecord, skipExecution: false };
    }
    if (existingStatus !== 'queued') {
      throw new Error(
        `Source crawl ${stringValue(existingRecord.id)} has an invalid non-terminal status.`,
      );
    }
    if (!requestedJobId || !requestedJobAttempt) {
      throw new SourceCrawlOwnershipError(
        `Source crawl ${stringValue(existingRecord.id)} requires an exact queued job attempt.`,
      );
    }
    const database = await resolveDatabase(getDbConfig());
    const claimed = await database.query(
      `UPDATE source_crawls AS crawl
       SET status = 'running', started_at = CURRENT_TIMESTAMP,
           job_attempt = ?, updated_at = CURRENT_TIMESTAMP
       WHERE crawl.id = ? AND crawl.status = 'queued'
         AND crawl.finished_at IS NULL AND crawl.source_id = ?
         AND crawl.job_id = ?
         AND COALESCE(crawl.job_attempt, 0) IN (0, ?)
         AND EXISTS (
           SELECT 1 FROM _smrt_jobs AS job
           WHERE CAST(job.id AS TEXT) = ?
             AND CAST(job.object_id AS TEXT) = ?
             AND job.status = 'running' AND job.attempts = ?
             AND job.queue IN (?, ?) AND job.object_type = ? AND job.method = ?
         )
       RETURNING crawl.id`,
      [
        requestedJobAttempt,
        stringValue(existingRecord.id),
        requestedSourceId,
        requestedJobId,
        requestedJobAttempt,
        requestedJobId,
        requestedSourceId,
        requestedJobAttempt,
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
      ],
    );
    if (claimed.rows.length !== 1) {
      throw new SourceCrawlOwnershipError(
        `Source crawl ${stringValue(existingRecord.id)} queued ownership could not be acquired.`,
      );
    }
    Object.assign(existingRecord, {
      intelligenceEnqueueCap,
      intelligenceCallLimit:
        numberValue(existingRecord.intelligenceCallLimit) || budget.crawl.calls,
      intelligenceInputTokenLimit:
        numberValue(existingRecord.intelligenceInputTokenLimit) ||
        budget.crawl.inputTokens,
      intelligenceSpendLimitMicros:
        numberValue(existingRecord.intelligenceSpendLimitMicros) ||
        budget.crawl.spendMicros,
      jobId: requestedJobId,
      jobAttempt: requestedJobAttempt,
      startedAt: new Date(),
      status: 'running',
    });
    return { crawl: existingRecord, skipExecution: false };
  }
  if (requestedJobId) {
    const database = await resolveDatabase(getDbConfig());
    const owner = await database.query(
      `SELECT CAST(id AS TEXT) AS id
       FROM _smrt_jobs
       WHERE CAST(id AS TEXT) = ?
         AND CAST(object_id AS TEXT) = ?
         AND status = 'running'
         AND attempts = ?
         AND queue IN (?, ?)
         AND object_type = ?
         AND method = ?`,
      [
        requestedJobId,
        requestedSourceId,
        requestedJobAttempt,
        SOURCE_CRAWL_QUEUE,
        SCHEDULED_SOURCE_QUEUE,
        SOURCE_JOB_OBJECT_TYPE,
        SOURCE_CRAWL_METHOD,
      ],
    );
    if (owner.rows.length !== 1) {
      throw new SourceCrawlOwnershipError(
        'Source crawl has no active owning job attempt.',
      );
    }
  }
  const crawl = await collection.create({
    crawlType: 'opportunity_source',
    integrationMethod: 'spider',
    intelligenceEnqueueCap,
    intelligenceCallLimit: budget.crawl.calls,
    intelligenceInputTokenLimit: budget.crawl.inputTokens,
    intelligenceSpendLimitMicros: budget.crawl.spendMicros,
    jobId: requestedJobId,
    jobAttempt: requestedJobAttempt,
    query: stringValue(source.searchQuery),
    sourceId: requestedSourceId,
    startedAt: new Date(),
    status: 'running',
  });
  await crawl.save();
  return {
    crawl: crawl as unknown as MutableRecord,
    skipExecution: false,
  };
}

function hydrateSummaryFromDurableCrawl(
  summary: CrawlOpportunitySourceSummary,
  crawl: MutableRecord,
): CrawlOpportunitySourceSummary {
  return {
    ...summary,
    candidates: numberValue(crawl.attemptCount ?? crawl.resultCount) ?? 0,
    created: numberValue(crawl.newOpportunityCount) ?? 0,
    duplicates: numberValue(crawl.duplicateCount) ?? 0,
    failedPersistence: numberValue(crawl.failedPersistenceCount) ?? 0,
    intelligenceDuplicateSuppressed:
      numberValue(crawl.intelligenceDuplicateCount) ?? 0,
    intelligenceEnqueued: numberValue(crawl.intelligenceEnqueuedCount) ?? 0,
    intelligenceSkipped: numberValue(crawl.intelligenceSkippedCount) ?? 0,
    relisted: numberValue(crawl.relistedCount) ?? 0,
    reused: numberValue(crawl.reusedCount) ?? 0,
    skipped: numberValue(crawl.skippedCount) ?? 0,
  };
}

/**
 * Providers whose adapter enumerates the complete board in one authoritative
 * response: no internal result cap, no pagination, and no `searchQuery`
 * relevance filtering. Only for these does a crawl result stand in for "the
 * board", so only for these does absence mean the posting was delisted.
 *
 * Every other adapter returns a capped, filtered, or paginated subset
 * (`WORKDAY_MAX_CANDIDATES`, `MICROSOFT_CAREERS_MAX_CANDIDATES`, the 50-item
 * aggregator caps, `candidateMatchesSource`), so a live posting is routinely
 * absent from a successful crawl and must never be counted as a miss.
 */
const FULL_BOARD_ENUMERATION_PROVIDERS = new Set([
  'ashby',
  'greenhouse',
  'lever',
]);

/**
 * Re-stamping what the crawl actually matched is always safe and is the
 * primary fix: a matched posting was definitely seen, whatever else the crawl
 * did. It is therefore deliberately NOT gated on provider, `limit`, or a
 * partial result — only a dry run and a missing source binding suppress it.
 */
function shouldRefreshSeenOpportunities(
  summary: CrawlOpportunitySourceSummary,
  options: CrawlOpportunitySourcesOptions,
): boolean {
  if (options.dryRun) return false;
  return Boolean(summary.sourceId);
}

/**
 * Board absence, unlike the re-stamp, is only trustworthy after a crawl that
 * enumerated the whole board and carried every enumerated posting through to a
 * durable opportunity. A crawl that errored, discovered nothing, ran dry, was
 * truncated by `limit`, skipped or failed to persist any item, or came from an
 * adapter that cannot enumerate the whole board must stay neutral: it can
 * neither miss nor archive. A skipped item is a posting the board *did* list;
 * it is recorded as seen when its identity resolves — including when only its
 * detail fetch failed — and only an item carrying no identity at all, or one
 * whose identity match is ambiguous, makes the enumeration incomplete.
 */
function shouldReconcileBoardAbsence(
  source: SourceLike,
  summary: CrawlOpportunitySourceSummary,
  options: CrawlOpportunitySourcesOptions,
  unidentifiedBoardItems: number,
): boolean {
  if (!shouldRefreshSeenOpportunities(summary, options)) return false;
  if (options.limit) return false;
  if (summary.errors.length > 0) return false;
  if (unidentifiedBoardItems > 0) return false;
  if (summary.failedPersistence > 0) return false;
  if (!FULL_BOARD_ENUMERATION_PROVIDERS.has(providerForUrl(source.url))) {
    return false;
  }
  return summary.candidates > 0;
}

export async function crawlOpportunitySource(
  source: SourceLike,
  options: CrawlOpportunitySourcesOptions = {},
): Promise<CrawlOpportunitySourceSummary> {
  assertActiveOperableRootSource(source);
  const sourceId = stringValue(source.id);
  const sourceName = stringValue(source.name) || sourceId || 'Unknown source';
  const summary: CrawlOpportunitySourceSummary = {
    candidates: 0,
    created: 0,
    duplicates: 0,
    errors: [],
    failedPersistence: 0,
    intelligenceDuplicateSuppressed: 0,
    intelligenceEnqueued: 0,
    intelligenceSkipped: 0,
    relisted: 0,
    reused: 0,
    skipped: 0,
    sourceId,
    sourceName,
  };

  const intelligenceEnqueueCap = resolveOpportunityIntelligenceEnqueueCap(
    options.intelligenceEnqueueCap,
  );
  const crawlOperation = await createSourceCrawl(
    source,
    intelligenceEnqueueCap,
    options.jobId,
    options.jobAttempt,
    options.dryRun,
    options.sourceCrawlId,
  );
  const crawl = crawlOperation.crawl;
  if (crawl && crawlOperation.skipExecution) {
    return hydrateSummaryFromDurableCrawl(summary, crawl);
  }
  const sourceCrawlId = stringValue(crawl?.id);
  let accountingWriter: SourceCrawlAccountingWriter;
  try {
    accountingWriter =
      options.sourceCrawlAccounting ??
      (await getSourceCrawlAccountingWriter(options.dryRun));
  } catch (error) {
    await markCrawlFailed(crawl, error, options.dryRun);
    throw error;
  }
  const intelligenceEnqueuer =
    options.enqueueOpportunityIntelligence ??
    enqueueOpportunityIntelligenceWithStatus;
  const activeIntelligenceJobFinder =
    options.findActiveOpportunityIntelligenceJob ??
    findActiveOpportunityIntelligenceJob;
  const fencedSourceUpdate =
    options.fencedOpportunitySourceUpdate ??
    defaultFencedOpportunitySourceUpdate;
  const fencedIntelligenceUpdate =
    options.fencedOpportunityIntelligenceUpdate ??
    defaultFencedOpportunityIntelligenceUpdate;
  const fencedBackfillUpdate =
    options.fencedOpportunityBackfillUpdate ??
    defaultFencedOpportunityBackfillUpdate;
  const fencedStatusUpdate =
    options.fencedOpportunityStatusUpdate ??
    defaultFencedOpportunityStatusUpdate;
  const enqueueBudget = { used: 0 };
  let recommendationTasksNeedSync = false;
  const seenOpportunityIdentities = new Set<string>();
  const seenOpportunityIds = new Set<string>();
  /**
   * Enumerated board items this crawl could not tie to a durable opportunity.
   * Only these make the crawl an incomplete enumeration; a skip we *can*
   * identify is recorded as seen instead.
   */
  let unidentifiedBoardItems = 0;

  /**
   * A skipped candidate is a posting the board *did* list, so it must never
   * count as absent. Deterministic skips — an irrelevant role, a listing with
   * no applyable URL — happen on every crawl of a real whole-company board, so
   * treating them as "crawl incomplete" would disable absence accounting
   * permanently. Resolve the candidate to its known opportunity and record it
   * as seen; only a candidate whose identity cannot be resolved leaves the
   * crawl unable to prove what the board listed.
   */
  const markSkippedCandidateSeen = async (
    candidate: OpportunitySourceCandidate,
    detail?: Extract<OpportunityDetailResult, { status: 'resolved' }>,
  ) => {
    // Board identity comes from the enumeration, not from the detail fetch:
    // every allowlisted adapter supplies a canonical posting URL and an
    // external id, which are exactly the keys `findExistingOpportunity`
    // matches on. A candidate carrying neither is the only truly
    // unidentifiable one.
    const hasIdentity = Boolean(
      normalizeHttpUrl(
        candidate.canonicalUrl ||
          candidate.postingUrl ||
          candidate.discoveredUrl,
      ) || stringValue(candidate.externalId),
    );
    if (!hasIdentity) {
      unidentifiedBoardItems += 1;
      return;
    }
    try {
      const existing = (await findExistingOpportunity(
        candidate,
        sourceId,
        detail,
      )) as MutableRecord | null;
      const existingId = stringValue(existing?.id);
      if (existingId) seenOpportunityIds.add(existingId);
    } catch {
      // An ambiguous identity match means this crawl cannot prove which
      // posting the board listed.
      unidentifiedBoardItems += 1;
    }
  };

  try {
    const candidates = await discoverOpportunityCandidates(source, options);
    const limitedCandidates = options.limit
      ? candidates.slice(0, options.limit)
      : candidates;
    summary.candidates = limitedCandidates.length;

    if (limitedCandidates.length === 0) {
      const fetchImpl = options.fetchImpl ?? fetch;
      for (const diagnose of [
        diagnosePeoplePerHourCandidateFetch,
        diagnoseContraCandidateFetch,
      ]) {
        const diagnostic = await diagnose(source, fetchImpl);
        if (diagnostic) summary.errors.push(diagnostic);
      }
    }

    const fetchImpl = options.fetchImpl ?? fetch;
    for (const [candidateIndex, candidate] of limitedCandidates.entries()) {
      const attemptKey = String(candidateIndex + 1);
      let crawlItem = await accountingWriter.createAttempt({
        attemptKey,
        candidate,
        sourceCrawlId,
      });
      let attemptOutcome: 'pending' | SourceCrawlTerminalOutcome = 'pending';
      let terminalMetadata: Pick<
        Parameters<SourceCrawlAccountingWriter['finalizeAttempt']>[0],
        | 'canonicalUrl'
        | 'companyName'
        | 'externalId'
        | 'postingUrl'
        | 'rawJson'
        | 'title'
      > = {};
      let intendedTerminalValues: Omit<
        Parameters<SourceCrawlAccountingWriter['finalizeAttempt']>[0],
        'attemptKey' | 'sourceCrawlId'
      > | null = null;
      const finishAttempt = async (
        values: Omit<
          Parameters<SourceCrawlAccountingWriter['finalizeAttempt']>[0],
          'attemptKey' | 'sourceCrawlId'
        >,
      ) => {
        intendedTerminalValues = values;
        if (
          accountingWriter.recordTerminalIntent &&
          (values.outcome === 'duplicate' || values.outcome === 'skipped')
        ) {
          crawlItem = await accountingWriter.recordTerminalIntent({
            attemptKey,
            outcome: values.outcome,
            sourceCrawlId,
            status: values.status ?? values.outcome,
          });
        }
        crawlItem = await accountingWriter.finalizeAttempt({
          ...terminalMetadata,
          ...values,
          attemptKey,
          sourceCrawlId,
        });
        attemptOutcome = values.outcome;
      };
      let durableOpportunityId = '';
      let durableTerminalValues: Omit<
        Parameters<SourceCrawlAccountingWriter['finalizeAttempt']>[0],
        'attemptKey' | 'sourceCrawlId'
      > | null = null;
      try {
        options.signal?.throwIfAborted();
        const rootResolution = await resolveRootPosting(candidate, fetchImpl);
        const resolvedCandidate = rootResolution.candidate;
        terminalMetadata = {
          canonicalUrl: stringValue(
            resolvedCandidate.rootPostingUrl || resolvedCandidate.canonicalUrl,
          ),
          companyName: stringValue(resolvedCandidate.companyName),
          externalId: stringValue(resolvedCandidate.externalId),
          postingUrl: stringValue(
            resolvedCandidate.discoveredUrl || resolvedCandidate.postingUrl,
          ),
          rawJson: safeJson(resolvedCandidate.rawJson),
          title: resolvedCandidate.title,
        };

        if (rootResolution.resolutionStatus === 'invalid') {
          await finishAttempt({
            outcome: 'skipped',
            status: 'rejected_no_posting_url',
          });
          summary.skipped += 1;
          await markSkippedCandidateSeen(resolvedCandidate);
          continue;
        }

        if (rootResolution.resolutionStatus === 'unresolved_alias') {
          await ensureCompanyForCandidate(
            resolvedCandidate,
            fetchImpl,
            options.dryRun,
            sourceId,
          );
          await finishAttempt({
            outcome: 'skipped',
            status: 'skipped_relist_unresolved',
          });
          summary.skipped += 1;
          // An unresolved relist alias leaves the board item unidentifiable.
          unidentifiedBoardItems += 1;
          continue;
        }

        const detail = await resolveCandidate(resolvedCandidate, fetchImpl);
        if (detail.status !== 'resolved') {
          await finishAttempt({
            outcome: 'skipped',
            status: detail.status,
          });
          summary.skipped += 1;
          // The board still listed this posting; only its detail fetch failed.
          // Lever, and Ashby on the SSR path, resolve every detail per posting,
          // so treating an unresolvable one as an incomplete enumeration would
          // make absence accounting permanently inert for that source.
          await markSkippedCandidateSeen(resolvedCandidate);
          continue;
        }
        terminalMetadata = {
          ...terminalMetadata,
          canonicalUrl: stringValue(
            detail.canonicalUrl || resolvedCandidate.canonicalUrl,
          ),
          externalId: stringValue(
            detail.externalId || resolvedCandidate.externalId,
          ),
          postingUrl: stringValue(
            resolvedCandidate.discoveredUrl || resolvedCandidate.postingUrl,
          ),
        };

        const candidateText = [
          resolvedCandidate.title,
          detail.title,
          detail.locationNotes,
          detail.descriptionRaw,
        ].join(' ');
        if (!candidateMatchesSource(source, candidateText)) {
          await finishAttempt({
            outcome: 'skipped',
            status: 'skipped_not_relevant',
          });
          summary.skipped += 1;
          await markSkippedCandidateSeen(resolvedCandidate, detail);
          continue;
        }

        // Reject candidates with no direct posting URL — they can't be applied
        // to, so they should not become recommended opportunities.
        if (
          !isApplyableJobUrl(detail.canonicalUrl) &&
          !isApplyableJobUrl(resolvedCandidate.canonicalUrl) &&
          !isApplyableJobUrl(resolvedCandidate.postingUrl)
        ) {
          await finishAttempt({
            outcome: 'skipped',
            status: 'rejected_no_posting_url',
          });
          summary.skipped += 1;
          await markSkippedCandidateSeen(resolvedCandidate, detail);
          continue;
        }

        crawlItem = await accountingWriter.prepareAttempt({
          attemptKey,
          candidate: resolvedCandidate,
          detail,
          sourceCrawlId,
        });

        const identityKeys = opportunityIdentityLockKeys(
          resolvedCandidate,
          sourceId,
          detail,
        );
        if (
          sharesSeenOpportunityIdentity(seenOpportunityIdentities, identityKeys)
        ) {
          await finishAttempt({
            outcome: 'duplicate',
            status: 'duplicate',
          });
          summary.duplicates += 1;
          continue;
        }

        const result = await withOpportunityIdentityLocks(
          resolvedCandidate,
          detail,
          sourceId,
          options.dryRun,
          async () =>
            await createOrUpdateOpportunity({
              candidate: resolvedCandidate,
              detail,
              dryRun: options.dryRun,
              fetchImpl,
              fencedBackfillUpdate,
              fencedUpdate: fencedSourceUpdate,
              fencedStatusUpdate,
              now: new Date(),
              persistCreatedOpportunity:
                accountingWriter.persistCreatedOpportunity
                  ? async ({
                      contentFingerprint,
                      contentVersion,
                      opportunityId,
                      persist,
                    }) => {
                      const persistCreated =
                        accountingWriter.persistCreatedOpportunity;
                      if (!persistCreated) {
                        throw new Error(
                          'Atomic created Opportunity persistence is unavailable.',
                        );
                      }
                      return await persistCreated({
                        ...terminalMetadata,
                        attemptKey,
                        contentFingerprint,
                        contentVersion,
                        opportunityId,
                        persist,
                        sourceCrawlId,
                        status: 'created_opportunity',
                      });
                    }
                  : undefined,
              recordPersistenceIntent: async (created, opportunityId) => {
                const intent = created
                  ? 'created'
                  : isRelistedCandidate(resolvedCandidate)
                    ? 'relisted'
                    : 'reused';
                crawlItem = await accountingWriter.recordPersistenceIntent({
                  attemptKey,
                  intent,
                  opportunityId,
                  sourceCrawlId,
                });
                if (!created) {
                  durableOpportunityId = opportunityId;
                  durableTerminalValues = {
                    opportunityId,
                    outcome: intent,
                    status: 'duplicate',
                  };
                }
              },
              sourceId,
            }),
        );
        durableOpportunityId = result.opportunityId;
        if (result.opportunityId) seenOpportunityIds.add(result.opportunityId);
        const outcome: SourceCrawlTerminalOutcome = result.created
          ? 'created'
          : isRelistedCandidate(resolvedCandidate)
            ? 'relisted'
            : 'reused';
        durableTerminalValues = {
          contentFingerprint: result.contentFingerprint,
          contentVersion: result.contentVersion,
          opportunityId: result.opportunityId,
          outcome,
          status: result.created
            ? 'created_opportunity'
            : result.materiallyChanged
              ? 'updated_opportunity'
              : 'duplicate',
        };
        await finishAttempt(durableTerminalValues);
        rememberOpportunityIdentities(seenOpportunityIdentities, identityKeys);
        if (outcome === 'created') summary.created += 1;
        else {
          if (outcome === 'relisted') summary.relisted += 1;
          else summary.reused += 1;
        }
        recommendationTasksNeedSync ||= result.recommendationInvalidated;
        if (result.materiallyChanged && !options.dryRun) {
          try {
            await cancelStaleOpportunityIntelligenceTasks(
              result.opportunityId,
              result.contentFingerprint,
              result.contentVersion,
            );
          } catch (error) {
            summary.errors.push(
              `${resolvedCandidate.title || resolvedCandidate.postingUrl}: stale intelligence cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        await enqueueSavedOpportunityIntelligence({
          candidate: resolvedCandidate,
          contentFingerprint: result.contentFingerprint,
          contentVersion: result.contentVersion,
          crawlItem: crawlItem as unknown as MutableRecord | null,
          dryRun: options.dryRun,
          enqueueCap: intelligenceEnqueueCap,
          enqueueBudget,
          enqueuer: intelligenceEnqueuer,
          findActiveJob: activeIntelligenceJobFinder,
          intelligenceEligible: result.intelligenceEligible,
          opportunity: result.opportunity as MutableRecord,
          opportunityIntelligenceUpdate: fencedIntelligenceUpdate,
          opportunityId: result.opportunityId,
          sourceCrawlId,
          sourceId,
          summary,
        });
      } catch (error) {
        const message = boundedCrawlErrorMessage(error);
        const diagnostic = boundedCrawlError(candidate, error);
        if (attemptOutcome !== 'pending') {
          summary.errors.push(diagnostic);
          if (options.signal?.aborted) throw error;
          continue;
        }
        try {
          if (durableOpportunityId && durableTerminalValues) {
            seenOpportunityIds.add(durableOpportunityId);
            await finishAttempt(durableTerminalValues);
            if (durableTerminalValues.outcome === 'created') {
              summary.created += 1;
            } else if (durableTerminalValues.outcome === 'relisted') {
              summary.relisted += 1;
            } else {
              summary.reused += 1;
            }
          } else {
            const recoveredOutcome = await accountingWriter.recoverAttempt({
              attemptKey,
              sourceCrawlId,
            });
            if (recoveredOutcome === 'created') summary.created += 1;
            else if (recoveredOutcome === 'relisted') summary.relisted += 1;
            else if (recoveredOutcome === 'reused') summary.reused += 1;
            else if (recoveredOutcome === 'duplicate') summary.duplicates += 1;
            else if (recoveredOutcome === 'skipped') summary.skipped += 1;
            else if (recoveredOutcome === 'failed_persistence') {
              summary.failedPersistence += 1;
            } else if (intendedTerminalValues) {
              const retryValues = intendedTerminalValues as Omit<
                Parameters<SourceCrawlAccountingWriter['finalizeAttempt']>[0],
                'attemptKey' | 'sourceCrawlId'
              >;
              await finishAttempt(retryValues);
              if (retryValues.outcome === 'duplicate') {
                summary.duplicates += 1;
              } else if (retryValues.outcome === 'skipped') {
                summary.skipped += 1;
              } else if (retryValues.outcome === 'failed_persistence') {
                summary.failedPersistence += 1;
              }
            } else {
              await finishAttempt({
                outcome: 'failed_persistence',
                reason: message,
                status: 'persistence_error',
              });
              summary.failedPersistence += 1;
            }
          }
          summary.errors.push(diagnostic);
        } catch (accountingError) {
          throw new AggregateError(
            [error, accountingError],
            `Could not persist a terminal accounting outcome for candidate ${candidate.title || candidate.postingUrl}.`,
          );
        }
        if (options.signal?.aborted) throw error;
      }
    }

    if (recommendationTasksNeedSync && !options.dryRun) {
      await syncRecommendedOpportunityDecisionTasks();
    }

    if (sourceCrawlId && accountingWriter.durable !== false) {
      const accounting = await accountingWriter.reconcile(sourceCrawlId, {
        requireTerminal: true,
      });
      summary.candidates = accounting.attemptCount;
      summary.created = accounting.createdCount;
      summary.duplicates = accounting.duplicateCount;
      summary.failedPersistence = accounting.failedPersistenceCount;
      summary.relisted = accounting.relistedCount;
      summary.reused = accounting.reusedCount;
      summary.skipped = accounting.skippedCount;
    }

    // The durable reconciler needs the durable accounting path; the unit-test
    // and dry-run fallbacks stay neutral unless a reconciler is injected.
    const boardReconciler =
      options.reconcileSourceBoard ??
      (accountingWriter.durable !== false ? reconcileSourceBoard : null);
    const reconcileAbsence = shouldReconcileBoardAbsence(
      source,
      summary,
      options,
      unidentifiedBoardItems,
    );
    const refreshSeen =
      shouldRefreshSeenOpportunities(summary, options) &&
      seenOpportunityIds.size > 0;
    if (boardReconciler && (reconcileAbsence || refreshSeen)) {
      try {
        await boardReconciler({
          now: new Date(),
          reconcileAbsence,
          seenOpportunityIds: [...seenOpportunityIds],
          sourceCrawlId,
          sourceId,
        });
      } catch (error) {
        summary.errors.push(
          `Board reconciliation failed: ${boundedCrawlErrorMessage(error)}`,
        );
      }
    }

    await markCrawlFinished(crawl, summary, options.dryRun);
    return summary;
  } catch (error) {
    await markCrawlFailed(crawl, error, options.dryRun);
    throw error;
  }
}

export async function crawlOpportunitySources(
  options: CrawlOpportunitySourcesOptions = {},
): Promise<CrawlOpportunitySourcesSummary> {
  const sourcesCollection = await getCollection('Source');
  const sources = options.sourceId
    ? [
        (await sourcesCollection.get(
          options.sourceId,
        )) as unknown as MutableRecord | null,
      ].filter(Boolean)
    : (await listAll(sourcesCollection as ListableCollection)).filter(
        (source) => sourceIsCrawlable(source, Boolean(options.includeGeneric)),
      );

  const summaries: CrawlOpportunitySourceSummary[] = [];
  for (const source of sources as SourceLike[]) {
    summaries.push(await crawlOpportunitySource(source, options));
  }

  return {
    candidates: summaries.reduce(
      (total, summary) => total + summary.candidates,
      0,
    ),
    created: summaries.reduce((total, summary) => total + summary.created, 0),
    duplicates: summaries.reduce(
      (total, summary) => total + summary.duplicates,
      0,
    ),
    errors: summaries.flatMap((summary) => summary.errors),
    failedPersistence: summaries.reduce(
      (total, summary) => total + summary.failedPersistence,
      0,
    ),
    intelligenceDuplicateSuppressed: summaries.reduce(
      (total, summary) => total + summary.intelligenceDuplicateSuppressed,
      0,
    ),
    intelligenceEnqueued: summaries.reduce(
      (total, summary) => total + summary.intelligenceEnqueued,
      0,
    ),
    intelligenceSkipped: summaries.reduce(
      (total, summary) => total + summary.intelligenceSkipped,
      0,
    ),
    relisted: summaries.reduce((total, summary) => total + summary.relisted, 0),
    reused: summaries.reduce((total, summary) => total + summary.reused, 0),
    skipped: summaries.reduce((total, summary) => total + summary.skipped, 0),
    sources: summaries,
  };
}
