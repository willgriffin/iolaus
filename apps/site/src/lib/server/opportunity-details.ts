import type { AIInterface, AIMessage, ChatOptions } from '@happyvertical/ai';
import { resolveDatabase } from '@happyvertical/smrt-core';
import type { User } from '@happyvertical/smrt-users';
import {
  type AiProfileClient,
  resolveOpportunityIntelligenceAiProfileClient,
  resolveOpportunityIntelligenceProfile,
} from './ai-config.js';
import { recordAgentAudit } from './application-workflow.js';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import { getDbConfig } from './db.js';
import {
  llmJsonParseDiagnostics,
  requireJsonObjectFromText,
} from './llm-json.js';
import {
  attachOpportunityIntelligenceInvocationMetadata,
  executeGovernedOpportunityIntelligenceRequest,
  finishOpportunityIntelligenceAgentRun,
  type OpportunityIntelligenceGovernanceStore,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import {
  buildBoundedPreparedPostingChunks,
  mergeOpportunityExtractionChunks,
  OPPORTUNITY_EXTRACTION_PROMPT_VERSION,
  OPPORTUNITY_EXTRACTION_SCHEMA_VERSION,
  type PreparedPosting,
  type PreparedPostingChunk,
  preparedPostingFactsAsOutput,
  prepareOpportunityPosting,
} from './opportunity-posting-preparation.js';
import { opportunityWithSourceContent } from './opportunity-source-content.js';
import { getCollection } from './smrt.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface OpportunityLike {
  id?: unknown;
  postingUrl?: unknown;
  title?: unknown;
}

interface ArcDevJob {
  availableHoursPerWeek?: unknown;
  categories?: Array<{ name?: unknown }>;
  company?: { name?: unknown } | null;
  createdAt?: unknown;
  description?: unknown;
  estimatedWeeks?: unknown;
  experienceLevel?: unknown;
  jobType?: unknown;
  maxAnnualSalary?: unknown;
  maxHourlyRate?: unknown;
  minAnnualSalary?: unknown;
  minHourlyRate?: unknown;
  randomKey?: unknown;
  requiredLocations?: unknown[];
  title?: unknown;
}

interface DetailCandidate {
  location?: string;
  title: string;
  url: string;
}

interface BaseOpportunityDetailResult {
  candidates?: DetailCandidate[];
  message: string;
  provider:
    | 'aijobs'
    | 'apple-careers'
    | 'ashby'
    | 'bamboohr'
    | 'generic'
    | 'google-careers'
    | 'greenhouse'
    | 'lever'
    | 'freelancer'
    | 'unsupported'
    | 'workday'
    | 'workable'
    | 'ycombinator';
}

interface UnresolvedOpportunityDetail extends BaseOpportunityDetailResult {
  status: 'ambiguous' | 'not_found' | 'unsupported';
}

interface ResolvedOpportunityDetail extends BaseOpportunityDetailResult {
  canonicalUrl: string;
  compNotes?: string;
  descriptionRaw: string;
  employmentType?: string;
  equityMaxPercent?: number | null;
  equityMinPercent?: number | null;
  externalId?: string;
  hourlyMax?: number | null;
  hourlyMin?: number | null;
  locationNotes?: string;
  preferredSkills?: string;
  postedAt?: Date | null;
  qualifications?: string;
  requiredSkills?: string;
  responsibilities?: string;
  salaryMax?: number | null;
  salaryMin?: number | null;
  status: 'resolved';
  title?: string;
  workMode?: string;
  currency?: string;
}

export type OpportunityDetailResult =
  | ResolvedOpportunityDetail
  | UnresolvedOpportunityDetail;

export interface LoadOpportunityDetailsOptions {
  db?: Awaited<ReturnType<typeof resolveDatabase>>;
  normalizeCanonicalUrl?: (canonicalUrl: string) => Promise<string>;
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
  employmentType?: string;
  id?: string;
  locationName?: string;
  publishedDate?: string;
  title?: string;
  workplaceType?: string;
}

interface AshbyPosting extends AshbyBoardJob {
  compensationPhilosophyPlainText?: string | null;
  compensationTierSummary?: string | null;
  compensationTiers?: unknown[];
  descriptionHtml?: string;
  descriptionPlainText?: string;
  scrapeableCompensationSalarySummary?: string | null;
}

interface LeverPosting {
  additional?: string;
  additionalPlain?: string;
  categories?: {
    commitment?: string;
    location?: string;
  };
  createdAt?: number;
  description?: string;
  descriptionPlain?: string;
  hostedUrl?: string;
  id?: string;
  lists?: Array<{ content?: string; text?: string }>;
  text?: string;
  workplaceType?: string;
}

interface FreelancerProjectSeoDocument {
  budget?: { max?: number | string; min?: number | string };
  breadcrumb?: { skill?: string };
  currencyDetails?: { code?: string };
  description?: string;
  endTime?: number | string;
  formattedBudget?: string;
  projectId?: number | string;
  seoUrl?: string;
  skills?: Array<{ name?: string }>;
  startTime?: number | string;
  title?: string;
  type?: string;
}

interface YcJobPostingSchema {
  '@type'?: string;
  applicantLocationRequirements?: { name?: string };
  baseSalary?: {
    currency?: string;
    Value?: {
      maxValue?: number | string;
      minValue?: number | string;
      unitText?: string;
      value?: number | string;
    };
    value?: {
      maxValue?: number | string;
      minValue?: number | string;
      unitText?: string;
      value?: number | string;
    };
  };
  datePosted?: string;
  description?: string;
  employmentType?: string;
  hiringOrganization?: {
    name?: string;
  };
  jobLocation?:
    | Array<{
        address?: {
          addressCountry?: string;
          addressLocality?: string;
          addressRegion?: string;
        };
      }>
    | {
        address?: {
          addressCountry?: string;
          addressLocality?: string;
          addressRegion?: string;
        };
      };
  jobLocationType?: string;
  skills?: string;
  title?: string;
}

interface AppleCareersLocation {
  city?: string;
  countryName?: string;
  name?: string;
  stateProvince?: string;
}

interface AppleCareersPosting {
  description?: string;
  id?: string;
  jobNumber?: string;
  jobSummary?: string;
  locations?: AppleCareersLocation[];
  localizations?: Record<
    string,
    {
      posting?: {
        description?: string;
        jobSummary?: string;
        minimumQualifications?: string;
        postingTitle?: string;
        preferredQualifications?: string;
      };
    }
  >;
  longPostingDate?: string;
  minimumQualifications?: string;
  positionId?: string;
  postingDateMeta?: string;
  postingTitle?: string;
  preferredQualifications?: string;
  transformedPostingTitle?: string;
}

interface GoogleCareersPosting {
  canonicalUrl: string;
  descriptionHtml: string;
  externalId: string;
  locationNotes: string;
  title: string;
}

interface OpportunityLlmExtractionOptions {
  aiClient?: Pick<AIInterface, 'chat'>;
  apiKey?: string;
  baseUrl?: string;
  agentRunId?: string;
  expectedSourceContentFingerprint?: string;
  fencedOpportunityUpdate?: (
    opportunityId: string,
    expectedFingerprint: string,
    updates: Record<string, unknown>,
  ) => Promise<boolean>;
  model?: string;
  governanceStore?: OpportunityIntelligenceGovernanceStore;
  profile?: string;
  signal?: AbortSignal;
  sourceContentVersion?: number;
  sourceCrawlId?: string;
  sourceCrawlItemId?: string;
  sourceId?: string;
  timeout?: number;
  user?: Pick<User, 'id'> | null;
}

type OpportunityLlmSettings = AiProfileClient;

type OpportunityLlmProcessStatus = 'error' | 'processed' | 'skipped';
type OpportunityLlmResult = {
  message: string;
  opportunityId?: string;
  stale?: boolean;
  status: OpportunityLlmProcessStatus;
  updatedFields?: string[];
};

const llmStringFields = [
  'title',
  'locationNotes',
  'locations',
  'currency',
  'compNotes',
  'descriptionSummary',
  'applyUrl',
  'applyInstructions',
] as const;
const llmListFields = [
  'requiredSkills',
  'preferredSkills',
  'responsibilities',
  'qualifications',
  'domainTags',
  'roleTags',
] as const;
const llmNumberFields = [
  'salaryMin',
  'salaryMax',
  'hourlyMin',
  'hourlyMax',
  'equityMinPercent',
  'equityMaxPercent',
] as const;
const llmBooleanFields = [
  'greenfieldSignal',
  'founderSignal',
  'relocationSupported',
  'visaOrEorPossible',
] as const;
const llmDateFields = ['postedAt', 'expiresAt'] as const;
const employmentTypes = [
  'full_time',
  'contract',
  'fractional',
  'advisory',
  'founder',
  'unknown',
] as const;
const seniorities = [
  'senior',
  'staff',
  'principal',
  'founding',
  'lead',
  'exec',
  'unknown',
] as const;
const workModes = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
const applyMethodValues = [
  'company_site',
  'email',
  'recruiter',
  'platform',
  'referral',
  'other',
  'unknown',
] as const;
// Job boards that re-list a posting but are not the place you actually apply.
const aggregatorHostMarkers = [
  'indeed.',
  'linkedin.',
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
  'google.com',
];

function applyHostIsAggregator(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return aggregatorHostMarkers.some((marker) => host.includes(marker));
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function isKnownValue(value: unknown): boolean {
  const text = stringValue(value);
  return Boolean(text && text.toLowerCase() !== 'unknown');
}

async function opportunityLlmSettings(
  options: OpportunityLlmExtractionOptions,
): Promise<OpportunityLlmSettings | null> {
  const clientOptions = {
    aiClient: options.aiClient,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    timeout: options.timeout,
    usageTags: {
      feature: 'admin-opportunity-llm-extraction',
    },
  };
  return await resolveOpportunityIntelligenceAiProfileClient(clientOptions);
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function compactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => stringValue(value)),
  );
}

function sourceTextForOpportunity(
  opportunity: Record<string, unknown>,
): string {
  return (
    stringValue(opportunity.descriptionRaw) ||
    stringValue(opportunity.descriptionSummary)
  );
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const text = stringValue(value).toLowerCase();
  if (!text) return undefined;
  if (['1', 'true', 'yes', 'y', 'supported'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'unsupported'].includes(text)) return false;
  return undefined;
}

function dateValue(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeListValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter(Boolean).join('\n');
  }
  return stringValue(value);
}

function normalizeEnumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  synonyms: Record<string, T[number]> = {},
): T[number] | '' {
  const text = stringValue(value).toLowerCase().replaceAll('-', '_');
  if (!text) return '';
  if ((allowed as readonly string[]).includes(text)) return text as T[number];
  const compact = text.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if ((allowed as readonly string[]).includes(compact))
    return compact as T[number];
  return synonyms[compact] ?? synonyms[text] ?? '';
}

export function normalizeOpportunityLlmExtraction(
  extraction: unknown,
): Record<string, unknown> {
  const source = unknownRecord(extraction);
  const updates: Record<string, unknown> = {};

  for (const field of llmStringFields) {
    const value = stringValue(source[field]);
    if (value) updates[field] = value;
  }

  for (const field of llmListFields) {
    const value = normalizeListValue(source[field]);
    if (value) updates[field] = value;
  }

  for (const field of llmNumberFields) {
    const value = numberValue(source[field]);
    if (value !== null) updates[field] = value;
  }

  for (const field of llmBooleanFields) {
    const value = booleanValue(source[field]);
    if (value !== undefined) updates[field] = value;
  }

  for (const field of llmDateFields) {
    const value = dateValue(source[field]);
    if (value) updates[field] = value;
  }

  const employmentType = normalizeEnumValue(
    source.employmentType,
    employmentTypes,
    {
      fulltime: 'full_time',
      full_time_employment: 'full_time',
      part_time: 'fractional',
    },
  );
  if (employmentType && employmentType !== 'unknown') {
    updates.employmentType = employmentType;
  }

  const seniority = normalizeEnumValue(source.seniority, seniorities, {
    executive: 'exec',
    founder: 'founding',
    staff_plus: 'staff',
  });
  if (seniority && seniority !== 'unknown') updates.seniority = seniority;

  const workMode = normalizeEnumValue(source.workMode, workModes, {
    in_person: 'onsite',
    on_site: 'onsite',
  });
  if (workMode && workMode !== 'unknown') updates.workMode = workMode;

  const applyMethod = normalizeEnumValue(
    source.applyMethod,
    applyMethodValues,
    {
      apply_on_company_site: 'company_site',
      company: 'company_site',
      company_website: 'company_site',
      employer_site: 'company_site',
      ats: 'company_site',
      job_board: 'platform',
      board: 'platform',
      external: 'platform',
      email_application: 'email',
    },
  );
  if (applyMethod && applyMethod !== 'unknown') {
    updates.applyMethod = applyMethod;
  }

  return updates;
}

function normalizeTitle(value: unknown): string {
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

function parseDate(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUnixSecondsDate(value: unknown): Date | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
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

export function htmlToPlainText(value: unknown): string {
  const html = decodeHtmlEntities(stringValue(value));
  return decodeHtmlEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*li\b[^>]*>/gi, '\n- ')
      .replace(/<\s*\/(p|div|h[1-6]|section|article|ul|ol|li)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function htmlAttributeValue(tag: string, name: string): string {
  const pattern = new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = tag.match(pattern);
  return decodeHtmlEntities(match?.[2] ?? '').trim();
}

function metaContent(html: string, selector: RegExp): string {
  const tag = html.match(selector)?.[0] ?? '';
  return htmlAttributeValue(tag, 'content');
}

function firstTagText(html: string, tagName: string): string {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    'i',
  );
  return displayTitle(htmlToPlainText(html.match(pattern)?.[1] ?? ''));
}

export function summaryFromDescription(description: string): string {
  const paragraph = description
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find((part) => part.length > 80);
  const summary = paragraph || description.trim();
  return summary.length > 700 ? `${summary.slice(0, 697).trim()}...` : summary;
}

function normalizedHeaderText(value: string): string {
  return value
    .replace(/^[-*•\d.)\s]+/, '')
    .replace(/[:：]\s*$/, '')
    .toLowerCase()
    .replace(/[^\w+#./ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function skillSectionKind(line: string): 'preferred' | 'required' | null {
  const text = normalizedHeaderText(line);
  if (!text || text.length > 90) return null;

  if (
    /\b(preferred|nice to have|nice-to-have|bonus|bonus points|plus)\b/.test(
      text,
    )
  ) {
    return 'preferred';
  }

  if (
    /\b(requirements?|required qualifications?|minimum qualifications?|basic qualifications?|qualifications?|skills?|what you bring|you have|must have|what we re looking for|what we're looking for)\b/.test(
      text,
    )
  ) {
    return 'required';
  }

  return null;
}

function isBulletLine(line: string): boolean {
  return /^(\s*[-*•]|\s*\d+[.)])\s+/.test(line);
}

function stripBullet(line: string): string {
  return line
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .trim();
}

function looksLikeSectionHeading(line: string): boolean {
  const text = stripBullet(line);
  if (!text || isBulletLine(line) || text.length > 90) return false;
  if (/[.!?]$/.test(text)) return false;
  return /^[A-Z][A-Za-z0-9 /&,+#.-]+:?$/.test(text);
}

function pushUniqueSkill(items: string[], item: string): void {
  const normalized = item
    .replace(/\s+/g, ' ')
    .replace(/[.;]\s*$/, '')
    .trim();
  if (!normalized || normalized.length > 180) return;
  if (
    items.some(
      (existing) => existing.toLowerCase() === normalized.toLowerCase(),
    )
  ) {
    return;
  }
  items.push(normalized);
}

function collectSkillSection(lines: string[], startIndex: number): string[] {
  const items: string[] = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (skillSectionKind(trimmed)) break;
    if (items.length > 0 && looksLikeSectionHeading(trimmed)) break;

    if (isBulletLine(trimmed)) {
      pushUniqueSkill(items, stripBullet(trimmed));
      continue;
    }

    if (items.length === 0 && trimmed.length <= 140) {
      pushUniqueSkill(items, trimmed);
      continue;
    }

    break;
  }

  return items;
}

export function extractSkillListingsFromDescription(description: string): {
  preferredSkills: string;
  requiredSkills: string;
} {
  const required: string[] = [];
  const preferred: string[] = [];
  const lines = description.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const kind = skillSectionKind(lines[index]);
    if (!kind) continue;
    const items = collectSkillSection(lines, index);
    for (const item of items) {
      pushUniqueSkill(kind === 'preferred' ? preferred : required, item);
    }
  }

  return {
    preferredSkills: preferred.join('\n'),
    requiredSkills: required.join('\n'),
  };
}

// Deterministic crawl-time fallback: the raw requirement bullets are closer to
// qualifications than atomic skills, so park them there until the LLM extract
// step refines the posting into atomic skills, responsibilities, and
// qualifications.
export function qualificationsFromDescription(description: string): string {
  const { requiredSkills, preferredSkills } =
    extractSkillListingsFromDescription(description);
  return [requiredSkills, preferredSkills].filter(Boolean).join('\n');
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

function canonicalAshbyUrl(boardSlug: string, jobId: string): string {
  return `https://jobs.ashbyhq.com/${boardSlug}/${jobId}`;
}

function leverJobPath(url: URL): { boardSlug: string; jobId: string } | null {
  if (url.hostname !== 'jobs.lever.co') return null;
  const [boardSlug, jobId] = url.pathname.split('/').filter(Boolean);
  if (!boardSlug || !jobId) return null;
  return { boardSlug, jobId };
}

function canonicalLeverUrl(boardSlug: string, jobId: string): string {
  return `https://jobs.lever.co/${boardSlug}/${jobId}`;
}

function workableJobPath(
  url: URL,
): { accountSlug: string; jobCode: string } | null {
  if (url.hostname !== 'apply.workable.com') return null;
  const [accountSlug, marker, jobCode] = url.pathname
    .split('/')
    .filter(Boolean);
  if (!accountSlug || marker !== 'j' || !jobCode) return null;
  return { accountSlug, jobCode };
}

function canonicalWorkableUrl(accountSlug: string, jobCode: string): string {
  return `https://apply.workable.com/${accountSlug}/j/${jobCode}`;
}

function isArcDevJobUrl(url: URL): boolean {
  return (
    (url.hostname === 'arc.dev' || url.hostname === 'www.arc.dev') &&
    /^\/remote-jobs\/details\//.test(url.pathname)
  );
}

function workableMarkdownUrl(accountSlug: string, jobCode: string): string {
  return `https://apply.workable.com/${accountSlug}/jobs/view/${jobCode}.md`;
}

function workModeFromValue(value: unknown): string | undefined {
  const text = stringValue(value).toLowerCase();
  if (!text) return undefined;
  if (text.includes('remote') || text.includes('telecommute')) return 'remote';
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

function annualToHourly(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round((numeric / 2080) * 100) / 100;
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

function markdownToPlainText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function compensationTextFromAshbyPosting(posting: AshbyPosting): string {
  return [
    posting.scrapeableCompensationSalarySummary,
    posting.compensationTierSummary,
    posting.compensationPhilosophyPlainText,
  ]
    .map(stringValue)
    .filter(Boolean)
    .join('\n');
}

function currencyFromCompensationText(text: string): string {
  if (/\bCAD\b|CA\$/i.test(text)) return 'CAD';
  if (/\bUSD\b|US\$|\$/i.test(text)) return 'USD';
  if (/\bGBP\b|£/i.test(text)) return 'GBP';
  if (/\bEUR\b|€/i.test(text)) return 'EUR';
  return '';
}

function parseCompensationNumber(value: string): number | null {
  const cleaned = value.replace(/[$,£€]/g, '').trim();
  if (!cleaned) return null;
  const multiplier = /k$/i.test(cleaned) ? 1_000 : 1;
  const numeric = Number(cleaned.replace(/k$/i, ''));
  return Number.isFinite(numeric) ? numeric * multiplier : null;
}

function compensationRangeFromText(text: string): {
  max: number | null;
  min: number | null;
} {
  const matches = Array.from(text.matchAll(/[$£€]?\s*(\d[\d,]*(?:\.\d+)?k?)/gi))
    .map((match) => parseCompensationNumber(match[1] ?? ''))
    .filter((value): value is number => value !== null);
  const realistic = matches.filter((value) => value >= 1);
  if (realistic.length === 0) return { max: null, min: null };
  return {
    max: realistic.length > 1 ? Math.max(...realistic) : null,
    min: Math.min(...realistic),
  };
}

function percentRangeFromText(text: string): {
  max: number | null;
  min: number | null;
} {
  const matches = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*%/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  if (matches.length === 0) return { max: null, min: null };
  return {
    max: matches.length > 1 ? Math.max(...matches) : null,
    min: Math.min(...matches),
  };
}

function ycNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(stringValue(value).replace(/[$,£€]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractAshbyCompensation(
  posting: AshbyPosting,
): Pick<
  ResolvedOpportunityDetail,
  | 'compNotes'
  | 'currency'
  | 'hourlyMax'
  | 'hourlyMin'
  | 'salaryMax'
  | 'salaryMin'
> {
  const text = compensationTextFromAshbyPosting(posting);
  if (!text) return {};

  const range = compensationRangeFromText(text);
  const isHourly = /\b(hour|hourly|\/hr|\/hour)\b/i.test(text);
  return {
    compNotes: text,
    currency: currencyFromCompensationText(text),
    hourlyMax: isHourly ? range.max : null,
    hourlyMin: isHourly ? range.min : null,
    salaryMax: isHourly ? null : range.max,
    salaryMin: isHourly ? null : range.min,
  };
}

function leverDescriptionRaw(posting: LeverPosting): string {
  const sections = [
    stringValue(posting.descriptionPlain) ||
      htmlToPlainText(posting.description),
    ...(posting.lists ?? []).map((list) => {
      const heading = stringValue(list.text);
      const content = stringValue(list.content);
      return [heading, htmlToPlainText(content)].filter(Boolean).join('\n');
    }),
    stringValue(posting.additionalPlain) || htmlToPlainText(posting.additional),
  ];
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n');
}

function leverJobDetail(
  boardSlug: string,
  jobId: string,
  posting: LeverPosting,
): ResolvedOpportunityDetail {
  const canonicalUrl =
    stringValue(posting.hostedUrl) || canonicalLeverUrl(boardSlug, jobId);
  const descriptionRaw = leverDescriptionRaw(posting);
  const locationNotes = stringValue(posting.categories?.location);
  return {
    canonicalUrl,
    descriptionRaw,
    employmentType: employmentTypeFromValue(posting.categories?.commitment),
    externalId: stringValue(posting.id) || jobId,
    locationNotes,
    message: 'Loaded Lever posting details.',
    postedAt:
      typeof posting.createdAt === 'number'
        ? new Date(posting.createdAt)
        : null,
    provider: 'lever',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title: displayTitle(posting.text),
    workMode: workModeFromValue(
      [posting.workplaceType, locationNotes, descriptionRaw].join(' '),
    ),
  };
}

function candidatesFromGreenhouse(jobs: GreenhouseJob[]): DetailCandidate[] {
  return jobs.slice(0, 8).map((job) => ({
    location: stringValue(job.location?.name),
    title: displayTitle(job.title),
    url: stringValue(job.absolute_url),
  }));
}

function candidatesFromAshby(
  boardSlug: string,
  jobs: AshbyBoardJob[],
): DetailCandidate[] {
  return jobs.slice(0, 8).map((job) => ({
    location: stringValue(job.locationName),
    title: displayTitle(job.title),
    url: job.id ? canonicalAshbyUrl(boardSlug, job.id) : '',
  }));
}

function missingBoardMatchTitleResult(
  provider: 'ashby' | 'greenhouse',
  candidates: DetailCandidate[],
): UnresolvedOpportunityDetail {
  return {
    candidates,
    message: `A saved opportunity title is required to match ${provider === 'ashby' ? 'Ashby' : 'Greenhouse'} board listings.`,
    provider,
    status: 'unsupported',
  };
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  url: string,
): Promise<T | null> {
  const response = await fetchImpl(url);
  if (!response.ok) return null;
  return (await response.json()) as T;
}

async function fetchText(
  fetchImpl: FetchLike,
  url: string,
): Promise<string | null> {
  const response = await fetchImpl(url);
  if (!response.ok) return null;
  return await response.text();
}

function greenhouseBoardToken(url: URL): string {
  const board = url.searchParams.get('for');
  if (board) return board;

  const [firstSegment] = url.pathname.split('/').filter(Boolean);
  return firstSegment ?? '';
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

  if (host === 'fireblocks.com' || host === 'www.fireblocks.com') {
    const jobToken = greenhouseJobToken(url);
    if (
      /^\/careers\/position(?:\/[^/]+)?\/?$/i.test(url.pathname) &&
      jobToken
    ) {
      return 'fireblocks';
    }
  }
  if (host === 'ripple.com' || host === 'www.ripple.com') {
    const jobToken = greenhouseJobToken(url);
    if (
      /^\/careers\/all-jobs\/job(?:\/[^/]+)?\/?$/i.test(url.pathname) &&
      jobToken
    ) {
      return 'ripple';
    }
  }

  return '';
}

function greenhouseJobDetail(job: GreenhouseJob): ResolvedOpportunityDetail {
  const descriptionRaw = htmlToPlainText(job.content);
  const location = stringValue(job.location?.name);
  // Raw requirement bullets become qualifications; the LLM extract step turns
  // the posting into atomic skills + responsibilities + qualifications.
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

async function resolveGreenhouseBoard(
  boardToken: string,
  opportunity: OpportunityLike,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  if (!boardToken) {
    return {
      message: 'Could not determine the Greenhouse board token.',
      provider: 'greenhouse',
      status: 'unsupported',
    };
  }

  const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
    fetchImpl,
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`,
  );
  const jobs = data?.jobs ?? [];
  const targetTitle = normalizeTitle(opportunity.title);
  const candidates = candidatesFromGreenhouse(jobs);
  if (!targetTitle)
    return missingBoardMatchTitleResult('greenhouse', candidates);

  const exactMatches = jobs.filter(
    (job) => normalizeTitle(job.title) === targetTitle,
  );

  if (exactMatches.length === 1) return greenhouseJobDetail(exactMatches[0]);

  if (exactMatches.length > 1) {
    return {
      candidates,
      message: 'Multiple Greenhouse jobs matched this title.',
      provider: 'greenhouse',
      status: 'ambiguous',
    };
  }

  return {
    candidates,
    message: 'No exact Greenhouse job match was found on this board.',
    provider: 'greenhouse',
    status: 'not_found',
  };
}

async function resolveGreenhouseJob(
  boardToken: string,
  jobToken: string,
  opportunity: OpportunityLike,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  if (!boardToken || !jobToken) {
    return {
      message: 'Could not determine the Greenhouse job token.',
      provider: 'greenhouse',
      status: 'unsupported',
    };
  }

  const directJob = await fetchJson<GreenhouseJob>(
    fetchImpl,
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(jobToken)}?content=true`,
  );
  if (directJob?.id || directJob?.absolute_url) {
    return greenhouseJobDetail(directJob);
  }

  const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
    fetchImpl,
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`,
  );
  const jobs = data?.jobs ?? [];
  const targetTitle = normalizeTitle(opportunity.title);
  const matched =
    jobs.find((job) => stringValue(job.id) === jobToken) ??
    jobs.find((job) => stringValue(job.absolute_url).includes(jobToken)) ??
    jobs.find((job) => normalizeTitle(job.title) === targetTitle);

  if (matched) return greenhouseJobDetail(matched);

  return {
    candidates: candidatesFromGreenhouse(jobs),
    message: 'No exact Greenhouse job match was found for this token/title.',
    provider: 'greenhouse',
    status: 'not_found',
  };
}

async function resolveAshbyJob(
  boardSlug: string,
  jobId: string,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const canonicalUrl = canonicalAshbyUrl(boardSlug, jobId);
  const html = await fetchText(fetchImpl, canonicalUrl);
  if (!html) {
    return {
      message: 'Could not load the Ashby job page.',
      provider: 'ashby',
      status: 'not_found',
    };
  }

  const posting = extractJsonValue<AshbyPosting>(html, '"posting":', '{');
  if (!posting?.id) {
    return {
      message: 'Could not parse the Ashby job posting payload.',
      provider: 'ashby',
      status: 'unsupported',
    };
  }

  const descriptionRaw =
    stringValue(posting.descriptionPlainText) ||
    htmlToPlainText(posting.descriptionHtml);
  const qualifications = qualificationsFromDescription(descriptionRaw);
  const compensation = extractAshbyCompensation(posting);
  return {
    canonicalUrl,
    descriptionRaw,
    employmentType: employmentTypeFromValue(posting.employmentType),
    externalId: stringValue(posting.id),
    locationNotes: stringValue(posting.locationName),
    message: 'Loaded Ashby posting details.',
    postedAt: posting.publishedDate
      ? parseDate(`${posting.publishedDate}T00:00:00.000Z`)
      : null,
    provider: 'ashby',
    qualifications,
    status: 'resolved',
    title: displayTitle(posting.title),
    workMode: workModeFromValue(posting.workplaceType || posting.locationName),
    ...compensation,
  };
}

async function resolveLeverJob(
  boardSlug: string,
  jobId: string,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const data = await fetchJson<LeverPosting>(
    fetchImpl,
    `https://api.lever.co/v0/postings/${encodeURIComponent(boardSlug)}/${encodeURIComponent(jobId)}`,
  );
  if (!data) {
    return {
      message: 'Could not load the Lever posting details.',
      provider: 'lever',
      status: 'not_found',
    };
  }

  const detail = leverJobDetail(boardSlug, jobId, data);
  if (!detail.title || !detail.descriptionRaw) {
    return {
      message: 'Could not parse the Lever posting payload.',
      provider: 'lever',
      status: 'unsupported',
    };
  }
  return detail;
}

function canonicalYcUrl(companySlug: string, jobSlug: string): string {
  return `https://www.ycombinator.com/companies/${companySlug}/jobs/${jobSlug}`;
}

function ycJobPath(url: URL): { companySlug: string; jobSlug: string } | null {
  if (
    url.hostname !== 'www.ycombinator.com' &&
    url.hostname !== 'ycombinator.com'
  ) {
    return null;
  }
  const [, companiesSegment, companySlug, jobsSegment, jobSlug] =
    url.pathname.split('/');
  if (companiesSegment !== 'companies' || jobsSegment !== 'jobs') return null;
  if (!companySlug || !jobSlug) return null;
  return { companySlug, jobSlug };
}

function jsonLdItems(value: unknown): unknown[] {
  const record = unknownRecord(value);
  const graph = record['@graph'];
  return [
    ...(Array.isArray(value) ? value : [value]),
    ...(Array.isArray(graph) ? graph : []),
  ];
}

function extractJsonLdJobPosting(html: string): YcJobPostingSchema | null {
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const attributes = decodeHtmlEntities(script[1] ?? '');
    if (!/\btype=["']application\/ld\+json["']/i.test(attributes)) continue;

    const body = decodeHtmlEntities(script[2] ?? '').trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as unknown;
      const items = jsonLdItems(parsed);
      const posting = items.find((item): item is YcJobPostingSchema => {
        const record = unknownRecord(item);
        return stringValue(record['@type']).toLowerCase() === 'jobposting';
      });
      if (posting) return posting;
    } catch {}
  }
  return null;
}

function ycEmbeddedField(html: string, field: string): string {
  const decoded = decodeHtmlEntities(html);
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`);
  const match = decoded.match(pattern);
  return decodeHtmlEntities(match?.[1] ?? '').trim();
}

function locationFromYcPosting(
  posting: YcJobPostingSchema,
  html: string,
): string {
  const embedded = ycEmbeddedField(html, 'location');
  if (embedded) return embedded;

  const locations = Array.isArray(posting.jobLocation)
    ? posting.jobLocation
    : posting.jobLocation
      ? [posting.jobLocation]
      : [];
  const parts = locations
    .map((location) => {
      const address = location.address ?? {};
      return [
        stringValue(address.addressLocality),
        stringValue(address.addressRegion),
        stringValue(address.addressCountry),
      ]
        .filter(Boolean)
        .join(', ');
    })
    .filter(Boolean);
  const applicantCountry = stringValue(
    posting.applicantLocationRequirements?.name,
  );
  if (applicantCountry && parts.length === 0) parts.push(applicantCountry);
  return parts.join(' / ');
}

function extractYcCompensation(
  posting: YcJobPostingSchema,
  html: string,
): Pick<
  ResolvedOpportunityDetail,
  | 'compNotes'
  | 'currency'
  | 'equityMaxPercent'
  | 'equityMinPercent'
  | 'salaryMax'
  | 'salaryMin'
> {
  const salary = posting.baseSalary?.value;
  const salaryMin = ycNumberValue(salary?.minValue);
  const salaryMax = ycNumberValue(salary?.maxValue);
  const currency = stringValue(posting.baseSalary?.currency);
  const salaryRange = ycEmbeddedField(html, 'salaryRange');
  const equityRange = ycEmbeddedField(html, 'equityRange');
  const minExperience = ycEmbeddedField(html, 'minExperience');
  const visa = ycEmbeddedField(html, 'visa');
  const equity = percentRangeFromText(equityRange);
  const compNotes = [
    salaryRange ? `Salary: ${salaryRange}` : '',
    equityRange ? `Equity: ${equityRange}` : '',
    minExperience ? `Experience: ${minExperience}` : '',
    visa ? `Visa: ${visa}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    compNotes,
    currency,
    equityMaxPercent: equity.max,
    equityMinPercent: equity.min,
    salaryMax,
    salaryMin,
  };
}

function extractJsonLdCompensation(
  posting: YcJobPostingSchema,
): Pick<
  ResolvedOpportunityDetail,
  | 'compNotes'
  | 'currency'
  | 'hourlyMax'
  | 'hourlyMin'
  | 'salaryMax'
  | 'salaryMin'
> {
  const salary = posting.baseSalary?.value ?? posting.baseSalary?.Value;
  const min = ycNumberValue(salary?.minValue ?? salary?.value);
  const max = ycNumberValue(salary?.maxValue ?? salary?.value);
  const unitText = stringValue(salary?.unitText).toLowerCase();
  const currency = stringValue(posting.baseSalary?.currency);
  const compNotes = [
    min !== null || max !== null
      ? `Compensation: ${[min, max].filter((value) => value !== null).join(' - ')}${currency ? ` ${currency}` : ''}${unitText ? ` / ${unitText}` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (unitText.includes('hour')) {
    return { compNotes, currency, hourlyMax: max, hourlyMin: min };
  }
  return { compNotes, currency, salaryMax: max, salaryMin: min };
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

function appleCareersLocation(
  location: AppleCareersPosting['locations'],
): string {
  const first = Array.isArray(location) ? location[0] : null;
  if (!first) return '';
  const city = stringValue(first.city || first.name);
  const state = stringValue(first.stateProvince);
  const country = stringValue(first.countryName);
  return [city, state, country]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(', ');
}

function appleCareersJobId(url: URL): string {
  const [, , , jobNumber] = url.pathname.split('/');
  return jobNumber ?? '';
}

function isAppleCareersJobUrl(url: URL): boolean {
  return (
    url.hostname === 'jobs.apple.com' && /\/details\/[^/]+/i.test(url.pathname)
  );
}

function canonicalAppleCareersUrl(
  url: URL,
  posting: AppleCareersPosting,
): string {
  const jobNumber = stringValue(
    posting.jobNumber || posting.id || appleCareersJobId(url),
  );
  const slug =
    stringValue(posting.transformedPostingTitle) ||
    normalizeTitle(posting.postingTitle).replace(/\s+/g, '-');
  return new URL(
    `/en-us/details/${encodeURIComponent(jobNumber)}${slug ? `/${slug}` : ''}`,
    url,
  ).toString();
}

function extractAppleCareersPosting(html: string): AppleCareersPosting | null {
  const data = extractAppleHydrationData(html);
  const loaderData = data?.loaderData;
  if (!loaderData || typeof loaderData !== 'object') return null;
  const jobDetails = (loaderData as Record<string, unknown>).jobDetails;
  if (!jobDetails || typeof jobDetails !== 'object') return null;
  const jobsData = (jobDetails as Record<string, unknown>).jobsData;
  return jobsData && typeof jobsData === 'object'
    ? (jobsData as AppleCareersPosting)
    : null;
}

function localizedApplePosting(posting: AppleCareersPosting) {
  const localization = posting.localizations?.en_US?.posting;
  return localization ?? {};
}

async function resolveAppleCareersJob(
  url: URL,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const html = await fetchText(fetchImpl, url.toString());
  if (!html) {
    return {
      message: 'Could not load the Apple Careers posting page.',
      provider: 'apple-careers',
      status: 'not_found',
    };
  }

  const posting = extractAppleCareersPosting(html);
  const localized = posting ? localizedApplePosting(posting) : {};
  const title = displayTitle(localized.postingTitle || posting?.postingTitle);
  const descriptionParts = [
    localized.jobSummary || posting?.jobSummary,
    localized.description || posting?.description,
    localized.minimumQualifications || posting?.minimumQualifications
      ? `Minimum Qualifications\n${localized.minimumQualifications || posting?.minimumQualifications}`
      : '',
    localized.preferredQualifications || posting?.preferredQualifications
      ? `Preferred Qualifications\n${localized.preferredQualifications || posting?.preferredQualifications}`
      : '',
  ].filter(Boolean);
  const descriptionRaw = descriptionParts.join('\n\n');
  if (!posting || !title || !descriptionRaw) {
    return {
      message: 'Could not parse the Apple Careers posting payload.',
      provider: 'apple-careers',
      status: 'unsupported',
    };
  }

  const locationNotes = appleCareersLocation(posting.locations);
  const qualifications = qualificationsFromDescription(descriptionRaw);
  return {
    canonicalUrl: canonicalAppleCareersUrl(url, posting),
    descriptionRaw,
    externalId: stringValue(
      posting.jobNumber || posting.id || posting.positionId,
    ),
    locationNotes,
    message: 'Loaded Apple Careers posting details.',
    postedAt: parseDate(posting.longPostingDate || posting.postingDateMeta),
    provider: 'apple-careers',
    qualifications,
    status: 'resolved',
    title,
    workMode: workModeFromValue(locationNotes),
  };
}

function googleCareersJobId(url: URL): string {
  const leaf = url.pathname.split('/').filter(Boolean).pop() ?? '';
  return leaf.split('-')[0] ?? '';
}

function isGoogleCareersJobUrl(url: URL): boolean {
  return (
    url.hostname === 'www.google.com' &&
    url.pathname.startsWith('/about/careers/applications/jobs/results/') &&
    Boolean(googleCareersJobId(url))
  );
}

function extractGoogleCareersPosting(
  url: URL,
  html: string,
): GoogleCareersPosting {
  const title = displayTitle(
    metaContent(html, /<meta\b[^>]*property=["']og:title["'][^>]*>/i) ||
      firstTagText(html, 'h1') ||
      htmlToPlainText(
        html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '',
      ).replace(/\s+—\s+Google Careers\s*$/i, ''),
  );
  const canonicalUrl =
    htmlAttributeValue(
      html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0] ?? '',
      'href',
    ) || url.toString();
  const locationNotes = displayTitle(
    htmlToPlainText(
      html.match(
        /<span\b[^>]*class=["'][^"']*\br0wTof\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      )?.[1] ?? '',
    ),
  );
  const descriptionHtml = [
    ...Array.from(
      html.matchAll(
        /<div\b[^>]*class=["'][^"']*\bKwJkGe\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
      ),
      (match) => match[1] ?? '',
    ),
    ...Array.from(
      html.matchAll(
        /<div\b[^>]*class=["'][^"']*\baG5W3\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
      ),
      (match) => match[1] ?? '',
    ),
  ].join('\n');
  return {
    canonicalUrl: new URL(canonicalUrl, url).toString(),
    descriptionHtml,
    externalId: googleCareersJobId(url),
    locationNotes,
    title,
  };
}

async function resolveGoogleCareersJob(
  url: URL,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const html = await fetchText(fetchImpl, url.toString());
  if (!html) {
    return {
      message: 'Could not load the Google Careers posting page.',
      provider: 'google-careers',
      status: 'not_found',
    };
  }

  const posting = extractGoogleCareersPosting(url, html);
  const descriptionRaw = htmlToPlainText(posting.descriptionHtml);
  if (!posting.title || !descriptionRaw) {
    return {
      message: 'Could not parse the Google Careers posting payload.',
      provider: 'google-careers',
      status: 'unsupported',
    };
  }
  const qualifications = qualificationsFromDescription(descriptionRaw);
  return {
    canonicalUrl: posting.canonicalUrl,
    descriptionRaw,
    externalId: posting.externalId,
    locationNotes: posting.locationNotes,
    message: 'Loaded Google Careers posting details.',
    provider: 'google-careers',
    qualifications,
    status: 'resolved',
    title: posting.title,
    workMode: workModeFromValue(posting.locationNotes),
  };
}

function findFreelancerRawDocument(
  value: unknown,
): FreelancerProjectSeoDocument | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFreelancerRawDocument(item);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const rawDocument = record.rawDocument;
  if (rawDocument && typeof rawDocument === 'object') {
    const document = rawDocument as FreelancerProjectSeoDocument;
    if (stringValue(document.title) && stringValue(document.description)) {
      return document;
    }
  }

  for (const item of Object.values(record)) {
    const found = findFreelancerRawDocument(item);
    if (found) return found;
  }
  return null;
}

function freelancerDateFromEpochSeconds(value: unknown): Date | null {
  const number = numberValue(value);
  if (number === null) return null;
  const date = new Date(number * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function freelancerCanonicalUrl(
  url: URL,
  document: FreelancerProjectSeoDocument,
): string {
  const seoUrl = stringValue(document.seoUrl);
  return new URL(
    `/projects/${seoUrl || url.pathname.replace(/^\/projects\//, '')}`,
    url,
  ).toString();
}

async function resolveFreelancerJob(
  url: URL,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const html = await fetchText(fetchImpl, url.toString());
  if (!html) {
    return {
      message: 'Could not load the Freelancer project page.',
      provider: 'freelancer',
      status: 'not_found',
    };
  }

  const projectsSeo = extractJsonValue<Record<string, unknown>>(
    html,
    '"projectsSeo":',
    '{',
  );
  const document = findFreelancerRawDocument(projectsSeo);
  const title = displayTitle(document?.title);
  const descriptionRaw = stringValue(document?.description);
  if (!document || !title || !descriptionRaw) {
    return {
      message: 'Could not parse the Freelancer project payload.',
      provider: 'freelancer',
      status: 'unsupported',
    };
  }

  const skills = (document.skills ?? [])
    .map((skill) => stringValue(skill.name))
    .filter(Boolean)
    .join(', ');
  const budgetMin = numberValue(document.budget?.min);
  const budgetMax = numberValue(document.budget?.max);
  const currency = stringValue(document.currencyDetails?.code);
  const compNotes = [
    stringValue(document.formattedBudget),
    document.type ? `Project type: ${document.type}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    canonicalUrl: freelancerCanonicalUrl(url, document),
    compNotes,
    currency,
    descriptionRaw,
    employmentType: 'contract',
    externalId: stringValue(document.projectId),
    message: 'Loaded Freelancer project details.',
    postedAt: freelancerDateFromEpochSeconds(document.startTime),
    provider: 'freelancer',
    qualifications: qualificationsFromDescription(descriptionRaw),
    requiredSkills: skills,
    salaryMax: budgetMax,
    salaryMin: budgetMin,
    status: 'resolved',
    title,
    workMode: 'remote',
  };
}

async function resolveArcDevJob(
  url: URL,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const html = await fetchText(fetchImpl, url.toString());
  if (!html) {
    return {
      message: 'Could not load the Arc.dev posting page.',
      provider: 'generic',
      status: 'not_found',
    };
  }

  const job = extractJsonValue<ArcDevJob>(html, '"job":', '{');
  const descriptionRaw = markdownToPlainText(stringValue(job?.description));
  const title = displayTitle(job?.title);
  if (!job || !title || !descriptionRaw) {
    return {
      message: 'Could not parse the Arc.dev posting payload.',
      provider: 'generic',
      status: 'unsupported',
    };
  }

  const categoryNames = (job.categories ?? [])
    .map((category) => stringValue(category.name))
    .filter(Boolean);
  const locationNotes = (job.requiredLocations ?? [])
    .map((location) => displayTitle(location))
    .filter(Boolean)
    .join(', ');
  const hourlyMin =
    Number(job.minHourlyRate) || annualToHourly(job.minAnnualSalary);
  const hourlyMax =
    Number(job.maxHourlyRate) || annualToHourly(job.maxAnnualSalary);
  const compNotes = [
    job.availableHoursPerWeek
      ? `${job.availableHoursPerWeek} available hours/week`
      : '',
    job.estimatedWeeks ? `${job.estimatedWeeks} estimated weeks` : '',
  ]
    .filter(Boolean)
    .join('; ');

  return {
    canonicalUrl: url.toString(),
    compNotes,
    descriptionRaw,
    employmentType: employmentTypeFromValue(job.jobType),
    externalId: stringValue(job.randomKey),
    hourlyMax,
    hourlyMin,
    locationNotes,
    message: 'Loaded Arc.dev posting details.',
    postedAt: parseUnixSecondsDate(job.createdAt),
    provider: 'generic',
    qualifications: qualificationsFromDescription(descriptionRaw),
    requiredSkills: categoryNames.join(', '),
    status: 'resolved',
    title,
    workMode:
      workModeFromValue([locationNotes, url.toString()].join(' ')) ?? 'remote',
  } satisfies OpportunityDetailResult;
}

async function resolveGenericJsonLdJob(
  url: URL,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const html = await fetchText(fetchImpl, url.toString());
  if (!html) {
    return {
      message: 'Could not load the generic posting page.',
      provider: 'generic',
      status: 'not_found',
    };
  }

  const posting = extractJsonLdJobPosting(html);
  if (!posting) {
    return {
      message: 'Could not parse a JSON-LD job posting payload.',
      provider: 'generic',
      status: 'unsupported',
    };
  }

  const canonicalUrl =
    htmlAttributeValue(
      html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0] ?? '',
      'href',
    ) || url.toString();
  const descriptionRaw = htmlToPlainText(posting.description);
  const qualifications = qualificationsFromDescription(descriptionRaw);
  const compensation = extractJsonLdCompensation(posting);
  const locationNotes = locationFromYcPosting(posting, html);
  return {
    canonicalUrl: new URL(canonicalUrl, url).toString(),
    descriptionRaw,
    employmentType: employmentTypeFromValue(posting.employmentType),
    externalId: stringValue(
      unknownRecord(unknownRecord(posting).Identifier).Value ??
        unknownRecord(unknownRecord(posting).identifier).value,
    ),
    locationNotes,
    message: 'Loaded generic JSON-LD posting details.',
    postedAt: parseDate(posting.datePosted),
    provider: 'generic',
    qualifications,
    requiredSkills: stringValue(posting.skills),
    status: 'resolved',
    title: displayTitle(posting.title),
    workMode: workModeFromValue(
      [posting.jobLocationType, locationNotes].filter(Boolean).join(' '),
    ),
    ...compensation,
  };
}

function parseWorkableMarkdownSummary(markdown: string): {
  employmentType: string | undefined;
  locationNotes: string;
  postedAt: Date | null;
  title: string;
  workMode: string | undefined;
} {
  const title = displayTitle(markdown.match(/^#\s+(.+)$/m)?.[1] ?? '');
  const summaryLine = stringValue(
    markdown
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('>')),
  ).replace(/^>\s*/, '');
  const parts = summaryLine
    .split(/\s+·\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const locationNotes = parts[1] ?? '';
  const employmentText = parts.find((part) =>
    /full[- ]time|part[- ]time|contract|fractional|advisor/i.test(part),
  );
  const postedAt = parseDate(
    summaryLine.match(/\bPosted\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\b/i)?.[1],
  );
  const workplace = markdown.match(/^\*\*Workplace:\*\*\s*(.+)$/im)?.[1] ?? '';

  return {
    employmentType: employmentTypeFromValue(employmentText),
    locationNotes,
    postedAt,
    title,
    workMode: workModeFromValue([workplace, locationNotes].join(' ')),
  };
}

async function resolveWorkableJob(
  accountSlug: string,
  jobCode: string,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const markdown = await fetchText(
    fetchImpl,
    workableMarkdownUrl(accountSlug, jobCode),
  );
  if (!markdown) {
    return {
      message: 'Could not load the Workable markdown posting.',
      provider: 'workable',
      status: 'not_found',
    };
  }

  const descriptionRaw = markdownToPlainText(markdown);
  const parsed = parseWorkableMarkdownSummary(markdown);
  if (!parsed.title || !descriptionRaw) {
    return {
      message: 'Could not parse the Workable markdown posting.',
      provider: 'workable',
      status: 'unsupported',
    };
  }

  const qualifications = qualificationsFromDescription(descriptionRaw);
  return {
    canonicalUrl: canonicalWorkableUrl(accountSlug, jobCode),
    descriptionRaw,
    employmentType: parsed.employmentType,
    externalId: jobCode,
    locationNotes: parsed.locationNotes,
    message: 'Loaded Workable posting details.',
    postedAt: parsed.postedAt,
    provider: 'workable',
    qualifications,
    status: 'resolved',
    title: parsed.title,
    workMode: parsed.workMode,
  };
}

async function resolveAiJobsJob(
  url: URL,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const html = await fetchText(fetchImpl, url.toString());
  if (!html) {
    return {
      message: 'Could not load the AI Jobs.net posting page.',
      provider: 'aijobs',
      status: 'not_found',
    };
  }

  const descriptionRaw =
    metaContent(
      html,
      /<meta\b[^>]*(?:name|property)=["']description["'][^>]*>/i,
    ) ||
    htmlToPlainText(
      html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html,
    );
  const title =
    firstTagText(html, 'h1') ||
    metaContent(html, /<meta\b[^>]*property=["']og:title["'][^>]*>/i) ||
    displayTitle(
      url.pathname
        .split('/')
        .filter(Boolean)[1]
        ?.replace(/-\d+$/, '')
        .replace(/-/g, ' '),
    );
  const canonicalUrl = html.match(
    /<link\b[^>]*rel=["']canonical["'][^>]*>/i,
  )?.[0]
    ? htmlAttributeValue(
        html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0] ?? '',
        'href',
      )
    : url.toString();
  const locationNotes = metaContent(
    html,
    /<meta\b[^>]*property=["']job:location["'][^>]*>/i,
  );
  const qualifications = qualificationsFromDescription(descriptionRaw);

  return {
    canonicalUrl: canonicalUrl || url.toString(),
    descriptionRaw,
    externalId: url.pathname.match(/-(\d+)\/?$/)?.[1] ?? '',
    locationNotes,
    message: 'Loaded AI Jobs.net posting details.',
    provider: 'aijobs',
    qualifications,
    status: 'resolved',
    title,
    workMode: workModeFromValue(
      [title, locationNotes, descriptionRaw].join(' '),
    ),
  };
}

function isBambooHrJobUrl(url: URL): boolean {
  return (
    url.hostname.endsWith('.bamboohr.com') &&
    /^\/careers\/[^/]+\/?$/i.test(url.pathname)
  );
}

function bambooHrJobId(url: URL): string {
  return url.pathname.split('/').filter(Boolean).pop() ?? '';
}

async function resolveBambooHrJob(
  url: URL,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const html = await fetchText(fetchImpl, url.toString());
  if (!html) {
    return {
      message: 'Could not load the BambooHR posting page.',
      provider: 'bamboohr',
      status: 'not_found',
    };
  }

  const title = displayTitle(
    metaContent(html, /<meta\b[^>]*property=["']og:title["'][^>]*>/i) ||
      metaContent(html, /<meta\b[^>]*property=["']twitter:title["'][^>]*>/i) ||
      firstTagText(html, 'h1'),
  );
  const descriptionRaw = htmlToPlainText(
    metaContent(html, /<meta\b[^>]*property=["']og:description["'][^>]*>/i) ||
      metaContent(
        html,
        /<meta\b[^>]*property=["']twitter:description["'][^>]*>/i,
      ),
  );

  if (!title || !descriptionRaw) {
    return {
      message: 'Could not parse the BambooHR posting metadata.',
      provider: 'bamboohr',
      status: 'unsupported',
    };
  }

  return {
    canonicalUrl:
      metaContent(html, /<meta\b[^>]*property=["']og:url["'][^>]*>/i) ||
      url.toString(),
    descriptionRaw,
    externalId: bambooHrJobId(url),
    locationNotes: metaContent(
      html,
      /<meta\b[^>]*property=["']og:site_name["'][^>]*>/i,
    ),
    message: 'Loaded BambooHR posting details from page metadata.',
    provider: 'bamboohr',
    qualifications: qualificationsFromDescription(descriptionRaw),
    status: 'resolved',
    title,
    workMode: workModeFromValue([title, descriptionRaw].join(' ')),
  };
}

async function resolveYcJob(
  url: URL,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const path = ycJobPath(url);
  if (!path) {
    return {
      message: 'Could not determine the YC company/job slug.',
      provider: 'ycombinator',
      status: 'unsupported',
    };
  }

  const canonicalUrl = canonicalYcUrl(path.companySlug, path.jobSlug);
  const html = await fetchText(fetchImpl, canonicalUrl);
  if (!html) {
    return {
      message: 'Could not load the YC job page.',
      provider: 'ycombinator',
      status: 'not_found',
    };
  }

  const posting = extractJsonLdJobPosting(html);
  if (!posting) {
    return {
      message: 'Could not parse the YC job posting payload.',
      provider: 'ycombinator',
      status: 'unsupported',
    };
  }

  const descriptionRaw = htmlToPlainText(posting.description);
  const qualifications = qualificationsFromDescription(descriptionRaw);
  const compensation = extractYcCompensation(posting, html);
  const locationNotes = locationFromYcPosting(posting, html);
  return {
    canonicalUrl,
    descriptionRaw,
    employmentType: employmentTypeFromValue(posting.employmentType),
    externalId: path.jobSlug,
    locationNotes,
    message: 'Loaded YC Work at a Startup posting details.',
    postedAt: parseDate(posting.datePosted),
    provider: 'ycombinator',
    qualifications,
    status: 'resolved',
    title: displayTitle(posting.title),
    workMode: workModeFromValue(
      [posting.jobLocationType, locationNotes].filter(Boolean).join(' '),
    ),
    ...compensation,
  };
}

async function resolveAshbyBoard(
  boardSlug: string,
  opportunity: OpportunityLike,
  fetchImpl: FetchLike,
): Promise<OpportunityDetailResult> {
  const boardUrl = `https://jobs.ashbyhq.com/${boardSlug}`;
  const html = await fetchText(fetchImpl, boardUrl);
  if (!html) {
    return {
      message: 'Could not load the Ashby board page.',
      provider: 'ashby',
      status: 'not_found',
    };
  }

  const jobs =
    extractJsonValue<AshbyBoardJob[]>(html, '"jobPostings":', '[') ?? [];
  const targetTitle = normalizeTitle(opportunity.title);
  const candidates = candidatesFromAshby(boardSlug, jobs);
  if (!targetTitle) return missingBoardMatchTitleResult('ashby', candidates);

  const exactMatches = jobs.filter(
    (job) => normalizeTitle(job.title) === targetTitle,
  );

  if (exactMatches.length === 1 && exactMatches[0].id) {
    return await resolveAshbyJob(boardSlug, exactMatches[0].id, fetchImpl);
  }

  if (exactMatches.length > 1) {
    return {
      candidates,
      message: 'Multiple Ashby jobs matched this title.',
      provider: 'ashby',
      status: 'ambiguous',
    };
  }

  return {
    candidates,
    message: 'No exact Ashby job match was found on this board.',
    provider: 'ashby',
    status: 'not_found',
  };
}

export async function resolveOpportunityDetails(
  opportunity: OpportunityLike,
  fetchImpl: FetchLike = fetch,
): Promise<OpportunityDetailResult> {
  const postingUrl = stringValue(opportunity.postingUrl);
  if (!postingUrl) {
    return {
      message: 'No posting URL is stored for this opportunity.',
      provider: 'unsupported',
      status: 'unsupported',
    };
  }

  let url: URL;
  try {
    url = new URL(postingUrl);
  } catch {
    return {
      message: 'Posting URL is not a valid URL.',
      provider: 'unsupported',
      status: 'unsupported',
    };
  }

  if (url.hostname.endsWith('greenhouse.io')) {
    const boardToken = greenhouseBoardToken(url);
    const jobToken = greenhouseJobToken(url);
    if (url.pathname.includes('/job_app') || jobToken) {
      return await resolveGreenhouseJob(
        boardToken,
        jobToken,
        opportunity,
        fetchImpl,
      );
    }
    return await resolveGreenhouseBoard(boardToken, opportunity, fetchImpl);
  }

  const knownGreenhouseBoard = knownGreenhouseBoardToken(url);
  if (knownGreenhouseBoard) {
    return await resolveGreenhouseJob(
      knownGreenhouseBoard,
      greenhouseJobToken(url),
      opportunity,
      fetchImpl,
    );
  }

  if (ycJobPath(url)) return await resolveYcJob(url, fetchImpl);

  if (isAppleCareersJobUrl(url)) {
    return await resolveAppleCareersJob(url, fetchImpl);
  }

  if (isGoogleCareersJobUrl(url)) {
    return await resolveGoogleCareersJob(url, fetchImpl);
  }

  if (isArcDevJobUrl(url)) {
    return await resolveArcDevJob(url, fetchImpl);
  }

  if (
    (url.hostname === 'www.freelancer.com' ||
      url.hostname === 'freelancer.com') &&
    url.pathname.startsWith('/projects/')
  ) {
    return await resolveFreelancerJob(url, fetchImpl);
  }

  if (
    ['ai-jobs.net', 'www.ai-jobs.net', 'aijobs.net', 'www.aijobs.net'].includes(
      url.hostname,
    )
  ) {
    if (/^\/job\//.test(url.pathname)) {
      return await resolveAiJobsJob(url, fetchImpl);
    }
  }

  if (isBambooHrJobUrl(url)) {
    return await resolveBambooHrJob(url, fetchImpl);
  }

  if (url.hostname === 'jobs.ashbyhq.com') {
    const [boardSlug, jobId] = url.pathname.split('/').filter(Boolean);
    if (!boardSlug) {
      return {
        message: 'Could not determine the Ashby board slug.',
        provider: 'ashby',
        status: 'unsupported',
      };
    }
    if (jobId) return await resolveAshbyJob(boardSlug, jobId, fetchImpl);
    return await resolveAshbyBoard(boardSlug, opportunity, fetchImpl);
  }

  const leverPath = leverJobPath(url);
  if (leverPath) {
    return await resolveLeverJob(
      leverPath.boardSlug,
      leverPath.jobId,
      fetchImpl,
    );
  }

  const workablePath = workableJobPath(url);
  if (workablePath) {
    return await resolveWorkableJob(
      workablePath.accountSlug,
      workablePath.jobCode,
      fetchImpl,
    );
  }

  if (
    /\bjobs?\b|career|position|opening|vacanc|apply/i.test(url.pathname) &&
    !['linkedin.com', 'www.linkedin.com'].includes(url.hostname)
  ) {
    return await resolveGenericJsonLdJob(url, fetchImpl);
  }

  return {
    message: 'Detail loading is not implemented for this posting source yet.',
    provider: 'unsupported',
    status: 'unsupported',
  };
}

export function buildOpportunityLlmExtractionMessages(
  input: PreparedPostingChunk | Record<string, unknown>,
): AIMessage[] {
  const chunk: PreparedPostingChunk =
    'preparedVersion' in input
      ? (input as PreparedPostingChunk)
      : (() => {
          const prepared = prepareOpportunityPosting(input);
          return {
            chunkCount: 1,
            chunkIndex: 0,
            facts: prepared.facts,
            inputTokenCeiling: 0,
            inputTokenCount: 0,
            preparedFingerprint: prepared.fingerprint,
            preparedVersion: prepared.version,
            sections: prepared.sections,
            source: prepared.source,
          };
        })();
  const expectedFields = [
    ...llmStringFields,
    ...llmListFields,
    ...llmNumberFields,
    ...llmBooleanFields,
    ...llmDateFields,
    'employmentType',
    'seniority',
    'workMode',
    'applyMethod',
  ];

  const instructions = [
    'You extract structured fields from a job posting and return ONE JSON object.',
    'Output JSON only — no Markdown, no prose, and never echo or repeat this prompt or the posting text back.',
    'Omit a key (or use null) when the posting does not state it.',
    'List fields are arrays of short strings, one item each.',
    'requiredSkills and preferredSkills are ATOMIC technologies, tools, languages, or named skills ONLY — short canonical names like "Python", "TypeScript", "Kubernetes", "PostgreSQL", "RAG", "AWS", "Golang". Never put sentences, responsibilities, or experience requirements here. Split compound phrases into individual skills (e.g. "Strong Python and Postgres" -> ["Python","PostgreSQL"]).',
    'responsibilities are concise phrases for what the person will do day to day (e.g. "Build agentic workflows", "Own backend reliability", "Mentor engineers").',
    'qualifications are concise phrases for experience, seniority, education, and soft requirements (e.g. "10+ years backend experience", "0->1 startup execution", "Strong ownership"). Requirement sentences that are not atomic skills go here.',
    'Enums (use exactly): employmentType full_time|contract|fractional|advisory|founder|unknown; seniority senior|staff|principal|founding|lead|exec|unknown; workMode remote|hybrid|onsite|unknown.',
    'applyMethod company_site|email|recruiter|platform|referral|other; applyUrl only when the posting names a distinct employer/ATS apply URL; applyInstructions a short note like "Apply on company site".',
  ].join('\n');

  return [
    { content: instructions, role: 'system' },
    {
      content: [
        `Prepared payload version: ${chunk.preparedVersion}.`,
        `Chunk ${chunk.chunkIndex + 1} of ${chunk.chunkCount}.`,
        `Return a JSON object using only these keys when the posting supports them: ${expectedFields.join(', ')}.`,
        'Deterministic facts are authoritative; do not contradict them.',
        `Prepared posting payload with source-section provenance:\n${JSON.stringify(
          {
            facts: chunk.facts,
            sections: chunk.sections,
            source: chunk.source,
          },
        )}`,
      ].join('\n\n'),
      role: 'user',
    },
  ];
}

async function requestOpportunityLlmExtraction(
  opportunity: Record<string, unknown>,
  prepared: PreparedPosting,
  settings: OpportunityLlmSettings,
  options: OpportunityLlmExtractionOptions,
): Promise<{
  conflicts: ReturnType<typeof mergeOpportunityExtractionChunks>['conflicts'];
  fieldProvenance: ReturnType<
    typeof mergeOpportunityExtractionChunks
  >['fieldProvenance'];
  inputTokenCounts: number[];
  output: Record<string, unknown>;
}> {
  const chunks = await buildBoundedPreparedPostingChunks({
    buildMessages: buildOpportunityLlmExtractionMessages,
    counter: settings.aiClient.countTokens
      ? settings.aiClient.countTokens.bind(settings.aiClient)
      : undefined,
    model: settings.model,
    prepared,
  });
  const results: Array<{
    chunkIndex: number;
    output: Record<string, unknown>;
    sectionIds: string[];
  }> = [];

  for (const chunk of chunks) {
    options.signal?.throwIfAborted();
    const messages = buildOpportunityLlmExtractionMessages(chunk);
    const invoke = async (requestId = '') => {
      const chatOptions: ChatOptions = {
        maxTokens: 2_048,
        reasoning: { maxTokens: 1_024 },
        responseFormat: { type: 'json_object' },
        signal: options.signal,
        temperature: 0,
        timeout: settings.timeout,
        ...(requestId ? { user: requestId } : {}),
      };
      if (settings.model) chatOptions.model = settings.model;
      const response = await settings.aiClient.chat(messages, chatOptions);
      const content = stringValue(response.content);
      if (!content)
        throw new Error('LLM extraction returned an empty response.');
      const responseMetadata = response as unknown as Record<string, unknown>;
      const providerRequestId =
        stringValue(
          responseMetadata.providerRequestId ??
            responseMetadata.requestId ??
            responseMetadata.id,
        ) || requestId;
      let output: Record<string, unknown>;
      try {
        output = requireJsonObjectFromText(content, 'LLM extraction');
      } catch (error) {
        throw attachOpportunityIntelligenceInvocationMetadata(error, {
          providerRequestId,
          usage: response.usage,
        });
      }
      return {
        output,
        providerRequestId,
        usage: response.usage,
      };
    };

    const output =
      options.agentRunId && !options.aiClient
        ? (
            await executeGovernedOpportunityIntelligenceRequest({
              estimatedInputTokens: chunk.inputTokenCount,
              identity: {
                agentRunId: options.agentRunId,
                contentFingerprint:
                  stringValue(options.expectedSourceContentFingerprint) ||
                  stringValue(opportunity.sourceContentFingerprint) ||
                  prepared.fingerprint,
                feature: `opportunity-extraction-chunk-${chunk.chunkIndex + 1}`,
                model: settings.model,
                opportunityId: stringValue(opportunity.id),
                outputSchemaVersion: OPPORTUNITY_EXTRACTION_SCHEMA_VERSION,
                preparedPayloadVersion: prepared.version,
                profile: settings.profile,
                promptVersion: OPPORTUNITY_EXTRACTION_PROMPT_VERSION,
                sourceCrawlId: options.sourceCrawlId,
                sourceCrawlItemId: options.sourceCrawlItemId,
              },
              inputTokenCeiling: chunk.inputTokenCeiling,
              invoke,
              maxOutputTokens: 2_048,
              signal: options.signal,
              store: options.governanceStore,
            })
          ).output
        : (await invoke()).output;
    results.push({
      chunkIndex: chunk.chunkIndex,
      output,
      sectionIds: chunk.sections.map((section) => section.id),
    });
  }

  return {
    ...mergeOpportunityExtractionChunks(results, prepared.facts),
    inputTokenCounts: chunks.map((chunk) => chunk.inputTokenCount),
  };
}

async function recordOpportunityLlmAudit(options: {
  error?: string;
  input: Record<string, unknown>;
  opportunityId: string;
  output?: Record<string, unknown>;
  status: string;
  user?: Pick<User, 'id'> | null;
}): Promise<void> {
  try {
    await recordAgentAudit({
      application: {
        opportunityId: options.opportunityId,
        sourceId: options.input.sourceId,
      },
      error: options.error,
      input: options.input,
      output: options.output,
      runType: 'opportunity_llm_extract',
      status: options.status,
      user: options.user,
    });
  } catch {
    // Extraction should not fail only because audit storage is unavailable.
  }
}

function opportunityLlmAuditInput(options: {
  opportunity?: Record<string, unknown> | null;
  opportunityId: string;
  request: OpportunityLlmExtractionOptions;
  settings?: OpportunityLlmSettings | null;
}): Record<string, unknown> {
  let selectedProfile: ReturnType<
    typeof resolveOpportunityIntelligenceProfile
  > | null = null;
  try {
    selectedProfile = resolveOpportunityIntelligenceProfile();
  } catch {
    // Audit prerequisite failures without weakening the fail-closed resolver.
  }
  return compactRecord({
    contentFingerprint: options.request.expectedSourceContentFingerprint,
    contentVersion: options.request.sourceContentVersion,
    model: options.settings?.model ?? selectedProfile?.model,
    opportunityId: options.opportunityId,
    postingUrl: stringValue(options.opportunity?.postingUrl),
    profile:
      options.settings?.profile ?? selectedProfile?.profile ?? 'unconfigured',
    provider: options.settings?.provider ?? 'bifrost',
    sourceCrawlId: options.request.sourceCrawlId,
    sourceCrawlItemId: options.request.sourceCrawlItemId,
    sourceId: options.request.sourceId,
  });
}

function assignKnownText(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
  options: { replaceKnown?: boolean } = {},
): void {
  if (!isKnownValue(value)) return;
  if (!options.replaceKnown && isKnownValue(record[key])) return;
  record[key] = stringValue(value);
}

function assignKnownNumber(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const next = numberValue(value);
  if (next === null || numberValue(record[key]) !== null) return;
  record[key] = next;
}

function applyOpportunityLlmUpdates(
  opportunity: Record<string, unknown>,
  updates: Record<string, unknown>,
): string[] {
  const applied: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (llmNumberFields.includes(key as (typeof llmNumberFields)[number])) {
      if (numberValue(value) === null || numberValue(opportunity[key]) !== null)
        continue;
      opportunity[key] = value;
      applied.push(key);
      continue;
    }

    if (llmBooleanFields.includes(key as (typeof llmBooleanFields)[number])) {
      // Boolean model defaults are ambiguous. Only let LLM extraction assert a
      // positive signal; deterministic/user-provided false values stay intact.
      if (value !== true || opportunity[key] === true) continue;
      opportunity[key] = true;
      applied.push(key);
      continue;
    }

    if (llmDateFields.includes(key as (typeof llmDateFields)[number])) {
      if (!dateValue(value) || dateValue(opportunity[key])) continue;
      opportunity[key] = value;
      applied.push(key);
      continue;
    }

    if (llmListFields.includes(key as (typeof llmListFields)[number])) {
      // Extraction owns the list fields (skills, responsibilities,
      // qualifications, tags), so a fresh extraction replaces stale values
      // rather than being blocked by whatever the crawler seeded.
      if (!isKnownValue(value) || opportunity[key] === value) continue;
      opportunity[key] = value;
      applied.push(key);
      continue;
    }

    if (!isKnownValue(value) || isKnownValue(opportunity[key])) continue;
    opportunity[key] = value;
    applied.push(key);
  }

  return applied;
}

export function applyResolvedOpportunityDetails(
  opportunity: Record<string, unknown>,
  result: Extract<OpportunityDetailResult, { status: 'resolved' }>,
  options: { now?: Date; refreshDescription?: boolean } = {},
): void {
  const refreshDescription = options.refreshDescription ?? true;

  opportunity.canonicalUrl = result.canonicalUrl;
  opportunity.freshness = 'fresh';
  opportunity.lastSeenAt = options.now ?? new Date();
  opportunity.postingUrl = result.canonicalUrl;

  if (refreshDescription || !isKnownValue(opportunity.descriptionRaw)) {
    opportunity.descriptionRaw = result.descriptionRaw;
    opportunity.descriptionSummary = summaryFromDescription(
      result.descriptionRaw,
    );
  }

  assignKnownText(opportunity, 'externalId', result.externalId);
  assignKnownText(opportunity, 'locationNotes', result.locationNotes);
  assignKnownText(opportunity, 'preferredSkills', result.preferredSkills);
  assignKnownText(opportunity, 'requiredSkills', result.requiredSkills);
  assignKnownText(opportunity, 'qualifications', result.qualifications);
  assignKnownText(opportunity, 'responsibilities', result.responsibilities);
  assignKnownText(opportunity, 'title', result.title, { replaceKnown: true });
  assignKnownText(opportunity, 'employmentType', result.employmentType);
  assignKnownText(opportunity, 'workMode', result.workMode);
  assignKnownText(opportunity, 'currency', result.currency);
  assignKnownText(opportunity, 'compNotes', result.compNotes);

  if (result.postedAt && !opportunity.postedAt) {
    opportunity.postedAt = result.postedAt;
  }

  assignKnownNumber(opportunity, 'salaryMin', result.salaryMin);
  assignKnownNumber(opportunity, 'salaryMax', result.salaryMax);
  assignKnownNumber(opportunity, 'hourlyMin', result.hourlyMin);
  assignKnownNumber(opportunity, 'hourlyMax', result.hourlyMax);
  assignKnownNumber(opportunity, 'equityMinPercent', result.equityMinPercent);
  assignKnownNumber(opportunity, 'equityMaxPercent', result.equityMaxPercent);
}

// A non-aggregator listing URL is itself where you apply (company site / ATS).
// Aggregator shells (Indeed, LinkedIn, …) are not, so leave applyUrl empty there
// — that gap is surfaced in the UI as "needs company apply URL".
function seedApplyFromHost(opportunity: Record<string, unknown>): string[] {
  const applied: string[] = [];
  const listingUrl =
    stringValue(opportunity.postingUrl) ||
    stringValue(opportunity.canonicalUrl);
  if (!listingUrl || applyHostIsAggregator(listingUrl)) return applied;

  if (!isKnownValue(opportunity.applyUrl)) {
    opportunity.applyUrl = listingUrl;
    applied.push('applyUrl');
  }
  if (!isKnownValue(opportunity.applyMethod)) {
    opportunity.applyMethod = 'company_site';
    applied.push('applyMethod');
  }
  return applied;
}

function snakeCaseField(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export async function defaultFencedOpportunityUpdate(
  opportunityId: string,
  expectedFingerprint: string,
  updates: Record<string, unknown>,
): Promise<boolean> {
  const database = await resolveDatabase(getDbConfig());
  const data = Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [snakeCaseField(key), value]),
  );
  const result = await database.update(
    'opportunities',
    {
      id: opportunityId,
      source_content_fingerprint: expectedFingerprint,
    },
    data,
  );
  if (result.affected === 0) return false;
  await bumpOpportunityChangeFeed(database, [opportunityId]);
  return true;
}

function expectedFingerprint(options: OpportunityLlmExtractionOptions): string {
  return stringValue(options.expectedSourceContentFingerprint);
}

function opportunityMatchesExpectedFingerprint(
  opportunity: Record<string, unknown> | null,
  options: OpportunityLlmExtractionOptions,
): boolean {
  const expected = expectedFingerprint(options);
  return (
    !expected ||
    (Boolean(opportunity) &&
      stringValue(opportunity?.sourceContentFingerprint) === expected)
  );
}

export async function processOpportunityWithLlm(
  opportunityId: string,
  options: OpportunityLlmExtractionOptions = {},
): Promise<OpportunityLlmResult> {
  options.signal?.throwIfAborted();
  const collection = await getCollection('Opportunity');
  let opportunity = (await collection.get(
    opportunityId,
  )) as unknown as MutableRecord | null;
  if (!opportunity) {
    const message = 'Opportunity not found.';
    await recordOpportunityLlmAudit({
      error: message,
      input: opportunityLlmAuditInput({
        opportunityId,
        request: options,
      }),
      opportunityId,
      status: 'failed',
      user: options.user,
    });
    return {
      message,
      opportunityId,
      status: 'error',
    };
  }

  if (!opportunityMatchesExpectedFingerprint(opportunity, options)) {
    return {
      message: 'Skipped stale opportunity extraction content fingerprint.',
      opportunityId,
      stale: true,
      status: 'skipped',
    };
  }

  if (
    !sourceTextForOpportunity(opportunity) &&
    stringValue(opportunity.postingUrl)
  ) {
    await loadOpportunityDetails(opportunityId);
    opportunity = (await collection.get(
      opportunityId,
    )) as unknown as MutableRecord | null;
  }

  if (!opportunityMatchesExpectedFingerprint(opportunity, options)) {
    return {
      message: 'Skipped stale opportunity extraction content fingerprint.',
      opportunityId,
      stale: true,
      status: 'skipped',
    };
  }

  const intelligenceOpportunity = opportunity
    ? opportunityWithSourceContent(opportunity)
    : null;
  if (
    !opportunity ||
    !sourceTextForOpportunity(intelligenceOpportunity ?? {})
  ) {
    const message =
      'Opportunity needs captured posting text before LLM extraction can run.';
    await recordOpportunityLlmAudit({
      error: message,
      input: opportunityLlmAuditInput({
        opportunity: intelligenceOpportunity,
        opportunityId,
        request: options,
      }),
      opportunityId,
      status: 'failed',
      user: options.user,
    });
    return {
      message,
      opportunityId,
      status: 'error',
    };
  }

  const prepared = prepareOpportunityPosting(
    intelligenceOpportunity ?? opportunity,
  );
  const deterministicFields = applyOpportunityLlmUpdates(
    opportunity,
    normalizeOpportunityLlmExtraction(preparedPostingFactsAsOutput(prepared)),
  );
  const preparationUpdates = {
    ...Object.fromEntries(
      deterministicFields.map((field) => [field, opportunity?.[field]]),
    ),
    preparedPostingFingerprint: prepared.fingerprint,
    preparedPostingJson: JSON.stringify(prepared),
    preparedPostingVersion: prepared.version,
    updated_at: new Date(),
  };
  const expected = expectedFingerprint(options);
  if (expected) {
    const update =
      options.fencedOpportunityUpdate ?? defaultFencedOpportunityUpdate;
    const persisted = await update(opportunityId, expected, preparationUpdates);
    if (!persisted) {
      return {
        message: 'Discarded stale opportunity preparation results.',
        opportunityId,
        stale: true,
        status: 'skipped',
        updatedFields: [],
      };
    }
    Object.assign(opportunity, preparationUpdates);
  } else {
    Object.assign(opportunity, preparationUpdates);
    await opportunity.save();
  }

  const settings = await opportunityLlmSettings(options);
  const auditInput = {
    ...opportunityLlmAuditInput({
      opportunity: intelligenceOpportunity,
      opportunityId,
      request: options,
      settings,
    }),
    preparedPostingFingerprint: prepared.fingerprint,
    preparedPostingVersion: prepared.version,
  };
  if (!settings) {
    const message =
      'Configure the dedicated key for the explicitly selected opportunity-intelligence profile before extraction.';
    await recordOpportunityLlmAudit({
      error: message,
      input: auditInput,
      opportunityId,
      output: { deterministicFields },
      status: 'failed',
      user: options.user,
    });
    return {
      message,
      opportunityId,
      status: 'error',
      updatedFields: deterministicFields,
    };
  }

  const ownedAgentRunId =
    !options.agentRunId && !options.aiClient
      ? await startOpportunityIntelligenceAgentRun({
          opportunityId,
          sourceCrawlId: options.sourceCrawlId,
          sourceId: options.sourceId,
          userId: stringValue(options.user?.id),
        })
      : '';
  const requestOptions = ownedAgentRunId
    ? { ...options, agentRunId: ownedAgentRunId }
    : options;

  try {
    const extraction = await requestOpportunityLlmExtraction(
      intelligenceOpportunity ?? opportunity,
      prepared,
      settings,
      requestOptions,
    );
    const updates = normalizeOpportunityLlmExtraction(extraction.output);
    const updatedFields = [
      ...deterministicFields,
      ...applyOpportunityLlmUpdates(opportunity, updates),
      ...seedApplyFromHost(opportunity),
    ].filter((field, index, fields) => fields.indexOf(field) === index);
    if (updatedFields.length === 0) {
      const current = (await collection.get(
        opportunityId,
      )) as unknown as MutableRecord | null;
      if (!opportunityMatchesExpectedFingerprint(current, options)) {
        await recordOpportunityLlmAudit({
          input: auditInput,
          opportunityId,
          output: {
            discardedAsStale: true,
            extractionConflicts: extraction.conflicts,
            extractionFieldProvenance: extraction.fieldProvenance,
            inputTokenCounts: extraction.inputTokenCounts,
            updatedFields,
          },
          status: 'succeeded',
          user: options.user,
        });
        if (ownedAgentRunId) {
          await finishOpportunityIntelligenceAgentRun(
            ownedAgentRunId,
            'succeeded',
          );
        }
        return {
          message: 'Discarded stale opportunity extraction results.',
          opportunityId,
          stale: true,
          status: 'skipped',
          updatedFields: [],
        };
      }
      await recordOpportunityLlmAudit({
        input: auditInput,
        opportunityId,
        output: {
          extractionConflicts: extraction.conflicts,
          extractionFieldProvenance: extraction.fieldProvenance,
          inputTokenCounts: extraction.inputTokenCounts,
          updatedFields,
        },
        status: 'succeeded',
        user: options.user,
      });
      if (ownedAgentRunId) {
        await finishOpportunityIntelligenceAgentRun(
          ownedAgentRunId,
          'succeeded',
        );
      }
      return {
        message: 'LLM extraction completed but returned no supported fields.',
        opportunityId,
        status: 'processed',
        updatedFields,
      };
    }

    const persistedUpdates = Object.fromEntries(
      updatedFields.map((field) => [field, opportunity?.[field]]),
    );
    Object.assign(persistedUpdates, {
      freshness: 'fresh',
      lastSeenAt: new Date(),
      preparedPostingFingerprint: prepared.fingerprint,
      preparedPostingJson: JSON.stringify(prepared),
      preparedPostingVersion: prepared.version,
      updated_at: new Date(),
    });
    if (expected) {
      const update =
        options.fencedOpportunityUpdate ?? defaultFencedOpportunityUpdate;
      const persisted = await update(opportunityId, expected, persistedUpdates);
      if (!persisted) {
        await recordOpportunityLlmAudit({
          input: auditInput,
          opportunityId,
          output: {
            discardedAsStale: true,
            extractionConflicts: extraction.conflicts,
            extractionFieldProvenance: extraction.fieldProvenance,
            inputTokenCounts: extraction.inputTokenCounts,
            updatedFields,
          },
          status: 'succeeded',
          user: options.user,
        });
        if (ownedAgentRunId) {
          await finishOpportunityIntelligenceAgentRun(
            ownedAgentRunId,
            'succeeded',
          );
        }
        return {
          message: 'Discarded stale opportunity extraction results.',
          opportunityId,
          stale: true,
          status: 'skipped',
          updatedFields: [],
        };
      }
    } else {
      Object.assign(opportunity, persistedUpdates);
      await opportunity.save();
    }

    await recordOpportunityLlmAudit({
      input: auditInput,
      opportunityId,
      output: {
        extractionConflicts: extraction.conflicts,
        extractionFieldProvenance: extraction.fieldProvenance,
        inputTokenCounts: extraction.inputTokenCounts,
        updatedFields,
      },
      status: 'succeeded',
      user: options.user,
    });
    if (ownedAgentRunId) {
      await finishOpportunityIntelligenceAgentRun(ownedAgentRunId, 'succeeded');
    }

    return {
      message: `Updated ${updatedFields.length} opportunity fields from LLM extraction.`,
      opportunityId,
      status: 'processed',
      updatedFields,
    };
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'LLM extraction failed.';
    await recordOpportunityLlmAudit({
      error: message,
      input: auditInput,
      opportunityId,
      output: llmJsonParseDiagnostics(cause),
      status: 'failed',
      user: options.user,
    });
    if (ownedAgentRunId) {
      await finishOpportunityIntelligenceAgentRun(
        ownedAgentRunId,
        'failed',
        message,
      );
    }
    if (options.signal?.aborted) throw cause;
    return {
      message,
      opportunityId,
      status: 'error',
    };
  }
}

export async function bulkProcessOpportunitiesWithLlm(
  opportunityIds: string[],
  options: OpportunityLlmExtractionOptions = {},
) {
  const uniqueOpportunityIds = Array.from(
    new Set(opportunityIds.map(stringValue).filter(Boolean)),
  );
  if (uniqueOpportunityIds.length === 0) {
    return {
      count: 0,
      failed: 0,
      message: 'Select at least one opportunity.',
      results: [],
      status: 'error',
    };
  }

  const results: OpportunityLlmResult[] = [];
  for (const id of uniqueOpportunityIds) {
    results.push(await processOpportunityWithLlm(id, options));
  }

  const processed = results.filter((result) => result.status === 'processed');
  const failed = results.length - processed.length;
  return {
    count: processed.length,
    failed,
    message:
      failed > 0
        ? `Processed ${processed.length} opportunities; ${failed} failed.`
        : `Processed ${processed.length} opportunities.`,
    results,
    status: processed.length > 0 ? 'processed' : 'error',
  };
}

export async function loadOpportunityDetails(
  opportunityId: string,
  fetchImpl: FetchLike = fetch,
  options: LoadOpportunityDetailsOptions = {},
) {
  const collection = await getCollection(
    'Opportunity',
    options.db ? { db: options.db } : undefined,
  );
  const opportunity = (await collection.get(
    opportunityId,
  )) as unknown as MutableRecord | null;
  if (!opportunity) {
    return {
      message: 'Opportunity not found.',
      provider: 'unsupported',
      status: 'not_found',
    } satisfies OpportunityDetailResult;
  }

  const result = await resolveOpportunityDetails(opportunity, fetchImpl);
  if (result.status === 'resolved') {
    const resolved = options.normalizeCanonicalUrl
      ? {
          ...result,
          canonicalUrl: await options.normalizeCanonicalUrl(
            result.canonicalUrl,
          ),
        }
      : result;
    applyResolvedOpportunityDetails(opportunity, resolved);
    await opportunity.save();
    return resolved;
  }

  if (result.status === 'not_found') {
    opportunity.freshness = 'stale';
    await opportunity.save();
  }

  return result;
}
