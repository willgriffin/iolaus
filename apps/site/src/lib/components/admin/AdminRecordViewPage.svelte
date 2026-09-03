<script lang="ts">
import { Form as SmrtForm } from '@happyvertical/smrt-svelte/forms';
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import BadgeCheck from '@lucide/svelte/icons/badge-check';
import Edit3 from '@lucide/svelte/icons/edit-3';
import ExternalLink from '@lucide/svelte/icons/external-link';
import MessageSquareText from '@lucide/svelte/icons/message-square-text';
import RotateCw from '@lucide/svelte/icons/rotate-cw';
import Save from '@lucide/svelte/icons/save';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { enhance } from '$app/forms';
import { notifyOpportunityListChanged } from '$lib/admin/opportunity-list-refresh';
import { displayFieldLabel, type ResourceField } from '$lib/admin/resources';
import { taskWorkTargetForRecord } from '$lib/admin/task-work-target';
import { recommendationDecisionDefinitions } from '$lib/objects/workflow';
import type { OpportunityRelationEditorData } from '$lib/server/admin-resource-route';
import AdminRecordValue from './AdminRecordValue.svelte';
import OpportunityWorkflowForms from './OpportunityWorkflowForms.svelte';
import ResourceFormFields from './ResourceFormFields.svelte';

type AdminRecord = Record<string, unknown> & { id?: string };
type ViewLinkAction = {
  href: string;
  label: string;
  title: string;
};
type ReviewStatusOption = {
  label: string;
  tone: 'amber' | 'green' | 'red';
  value: string;
};
type AdminActionFeedback = {
  count?: number;
  failed?: number;
  message?: string;
  status?: string;
  updatedFields?: string[];
};
type EvidenceEntry = {
  requirement?: unknown;
  sources?: Array<{
    excerpt?: unknown;
    kind?: unknown;
    title?: unknown;
  }>;
  status?: unknown;
};
type AgentRunEntry = {
  created_at?: unknown;
  error?: unknown;
  finishedAt?: unknown;
  runType?: unknown;
  status?: unknown;
  updated_at?: unknown;
};

const reviewStatuses: ReviewStatusOption[] = [
  { label: 'Apply', tone: 'green', value: 'apply' },
  { label: 'Maybe', tone: 'amber', value: 'maybe' },
  { label: 'Reject', tone: 'red', value: 'reject' },
];

let { data, form } = $props<{
  data: {
    company?: AdminRecord | null;
    opportunityRelations?: OpportunityRelationEditorData[];
    referenceOptions: import('$lib/admin/resources').ReferenceOptionsByField;
    record: AdminRecord;
    resource: import('$lib/admin/resources').AdminResource;
  };
  form?: unknown;
}>();

function referenceLabel(field: string, id: string): string {
  if (!id) return '';
  return (
    data.referenceOptions?.[field]?.find(
      (option: { label: string; value: string }) => option.value === id,
    )?.label ?? ''
  );
}

const companyId = $derived(stringValue('companyId'));
const companyName = $derived(
  referenceLabel('companyId', companyId) ||
    stringFromValue(data.company?.name) ||
    'Unknown company',
);
const companyWebsite = $derived(
  stringFromValue(data.company?.websiteUrl) ||
    stringFromValue(data.company?.careersUrl),
);
const sourceId = $derived(stringValue('sourceId'));
const appliedApplicationId = $derived(stringValue('applicationId'));
const appliedApplicationStatus = $derived(stringValue('applicationStatus'));
const applyMethodValue = $derived(stringValue('applyMethod'));
const applyUrlValue = $derived(
  isApplyableUrl(stringValue('applyUrl')) ? stringValue('applyUrl') : '',
);
const applyInstructionsValue = $derived(stringValue('applyInstructions'));
const needsApplyUrl = $derived(
  applyMethodValue === 'company_site' && !applyUrlValue,
);

const listHref = $derived(`/admin/${data.resource.slug}`);
const editHref = $derived(
  `/admin/${data.resource.slug}/${data.record.id ?? ''}/edit`,
);
const reviewHref = $derived(
  data.resource.slug === 'applications'
    ? `/admin/applications/${encodeURIComponent(String(data.record.id ?? ''))}`
    : '',
);
const isOpportunityRecord = $derived(data.resource.slug === 'opportunities');
const isCompanyRecord = $derived(data.resource.slug === 'companies');
const isSourceRecord = $derived(data.resource.slug === 'sources');
const isTaskRecord = $derived(data.resource.slug === 'tasks');
const taskWorkTarget = $derived(
  isTaskRecord ? taskWorkTargetForRecord(data.record) : null,
);
const isRecommendationTask = $derived(
  isTaskRecord && stringValue('taskType') === 'review_recommendation',
);
const opportunityRelations = $derived(
  isOpportunityRecord ? (data.opportunityRelations ?? []) : [],
);
const opportunityFactIntakes = $derived(
  isOpportunityRecord ? arrayValue<AdminRecord>('factIntakes') : [],
);
let opportunityReviewStatus = $state('');
let opportunityReviewRating = $state('');
let opportunityReviewNotes = $state('');
let opportunityReviewRecordId = $state('');
let opportunityExtractionState = $state<
  'idle' | 'processing' | 'processed' | 'queued' | 'error'
>('idle');
let opportunityExtractionMessage = $state('');
let lastOpportunityActionForm = $state<unknown>(null);
let sourceCrawlState = $state<'idle' | 'queueing' | 'queued' | 'error'>('idle');
let sourceCrawlMessage = $state('');
let sourceCrawlRecordId = $state('');
const actionFeedbackMessage = $derived(
  opportunityExtractionMessage ||
    stringFromValue(feedbackValue(form, 'message')),
);
const actionFeedbackFailedCount = $derived(
  numberFromValue(feedbackValue(form, 'failed')),
);
const actionFeedbackTone = $derived(
  opportunityExtractionState !== 'idle'
    ? opportunityExtractionState
    : actionFeedbackFailedCount > 0
      ? 'error'
      : stringFromValue(feedbackValue(form, 'status')),
);
const overviewFields = $derived(
  ['companyId', 'sourceId', 'status', 'humanReviewStatus', 'workMode']
    .map(fieldForKey)
    .filter((field): field is ResourceField =>
      Boolean(field && hasDisplayValue(field)),
    ),
);
const descriptionFields = $derived(
  data.resource.fields.filter(
    (field: ResourceField) =>
      shouldShowDescriptionField(field) && hasDisplayValue(field),
  ),
);
const detailFields = $derived(
  data.resource.fields
    .filter((field: ResourceField) => shouldShowDetailField(field))
    .sort(
      (left: ResourceField, right: ResourceField) =>
        fieldPriority(left) - fieldPriority(right),
    ),
);

function titleValue(): string {
  for (const key of ['title', 'name', 'label', 'profileKey', 'status']) {
    const value = data.record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return data.resource.singularLabel;
}

function stringValue(key: string): string {
  return stringFromValue(data.record[key]);
}

function stringFromValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

function numberFromValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function feedbackValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function arrayValue<T>(key: string): T[] {
  const value = data.record[key];
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function stringListFor(key: string): string[] {
  return arrayValue<unknown>(key).map(stringFromValue).filter(Boolean);
}

function evidenceEntries(): EvidenceEntry[] {
  return arrayValue<EvidenceEntry>('evidenceMatrix').filter((entry) =>
    Boolean(stringFromValue(entry.requirement)),
  );
}

function evidenceGapCount(): number {
  return evidenceEntries().filter(
    (entry) => stringFromValue(entry.status) !== 'supported',
  ).length;
}

function agentRunEntries(): AgentRunEntry[] {
  return arrayValue<AgentRunEntry>('agentRuns').filter((entry) =>
    Boolean(stringFromValue(entry.runType)),
  );
}

function humanizeValue(value: unknown, fallback = ''): string {
  const text = stringFromValue(value);
  if (!text) return fallback;
  return text.replaceAll('_', ' ');
}

function relationFields(
  editor: OpportunityRelationEditorData,
): ResourceField[] {
  return editor.resource.fields.filter(
    (field: ResourceField) => field.key !== 'opportunityId',
  );
}

function relationSummary(
  editor: OpportunityRelationEditorData,
  record: AdminRecord,
): string {
  return relationFields(editor)
    .map((field) => {
      const raw = record[field.key];
      const text = stringFromValue(raw);
      if (!text) return '';
      const label =
        data.referenceOptions?.[field.key]?.find(
          (option: { label: string; value: string }) => option.value === text,
        )?.label ??
        editor.referenceOptions?.[field.key]?.find(
          (option: { label: string; value: string }) => option.value === text,
        )?.label ??
        editor.comboOptions?.[field.key]?.find(
          (option: { label: string; value: string }) => option.value === text,
        )?.label ??
        text;
      return `${displayFieldLabel(field)}: ${humanizeValue(label)}`;
    })
    .filter(Boolean)
    .join(' · ');
}

function displayDate(value: unknown): string {
  const text = stringFromValue(value);
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function evidenceStatusLabel(status: unknown): string {
  return stringFromValue(status) === 'supported' ? 'Supported' : 'Gap';
}

function evidenceStatusClass(status: unknown): string {
  return stringFromValue(status) === 'supported' ? 'supported' : 'gap';
}

function agentRunDate(run: AgentRunEntry): string {
  return displayDate(run.finishedAt ?? run.updated_at ?? run.created_at);
}

function latestScoreLabel(): string {
  const score = stringValue('latestScore');
  const recommendation = stringValue('latestRecommendation').replaceAll(
    '_',
    ' ',
  );
  if (!score && !recommendation) return 'Unscored';
  return [score ? `${score}/100` : '', recommendation]
    .filter(Boolean)
    .join(' / ');
}

function fieldForKey(key: string): ResourceField | null {
  return (
    data.resource.fields.find((field: ResourceField) => field.key === key) ??
    null
  );
}

function hasDisplayValue(field: ResourceField): boolean {
  if (field.kind === 'checkbox') return data.record[field.key] !== undefined;
  return Boolean(stringValue(field.key));
}

function isExternalUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// A posting link is only useful if it points at an actual posting, not a bare
// board homepage (e.g. https://ca.indeed.com/). Mirrors the opportunity card.
function isApplyableUrl(value: string): boolean {
  if (!isExternalUrl(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(
      (parsed.pathname && parsed.pathname !== '/') || parsed.search,
    );
  } catch {
    return false;
  }
}

function viewLinkActions(): ViewLinkAction[] {
  const actions: ViewLinkAction[] = [];
  const seen = new Set<string>();
  for (const [key, label] of [
    ['postingUrl', 'View posting'],
    ['canonicalUrl', 'Canonical posting'],
    ['applicationUrl', 'Application page'],
  ] as const) {
    const url = stringValue(key);
    if (url && isApplyableUrl(url) && !seen.has(url)) {
      seen.add(url);
      actions.push({ href: url, label, title: url });
    }
  }

  for (const field of data.resource.fields) {
    if (['postingUrl', 'canonicalUrl', 'applicationUrl'].includes(field.key))
      continue;
    const value = stringValue(field.key);
    if (!isExternalUrl(value) || seen.has(value)) continue;
    seen.add(value);
    actions.push({
      href: value,
      label: displayFieldLabel(field),
      title: value,
    });
  }

  return actions;
}

function hasApplyablePostingLink(): boolean {
  return [stringValue('postingUrl'), stringValue('canonicalUrl')].some(
    isApplyableUrl,
  );
}

function compensationSummary(): string {
  const currency = stringValue('currency');
  const salaryMin = stringValue('salaryMin');
  const salaryMax = stringValue('salaryMax');
  const hourlyMin = stringValue('hourlyMin');
  const hourlyMax = stringValue('hourlyMax');
  const equityMin = stringValue('equityMinPercent');
  const equityMax = stringValue('equityMaxPercent');

  const ranges: string[] = [];
  if (salaryMin || salaryMax) {
    ranges.push(formatRange(salaryMin, salaryMax, currency, ''));
  }
  if (hourlyMin || hourlyMax) {
    ranges.push(formatRange(hourlyMin, hourlyMax, currency, '/hr'));
  }
  if (equityMin || equityMax) {
    ranges.push(formatRange(equityMin, equityMax, '', '% equity'));
  }
  return ranges.filter(Boolean).join(' / ');
}

function formatRange(
  minimum: string,
  maximum: string,
  prefix: string,
  suffix: string,
): string {
  const start = minimum ? `${prefix}${minimum}` : '';
  const end = maximum ? `${prefix}${maximum}` : '';
  const range =
    start && end && start !== end ? `${start}-${end}` : start || end;
  return suffix && range ? `${range}${suffix}` : range;
}

function isOverviewOnlyField(field: ResourceField): boolean {
  return [
    'companyId',
    'currency',
    'equityMaxPercent',
    'equityMinPercent',
    'hourlyMax',
    'hourlyMin',
    'humanReviewStatus',
    'salaryMax',
    'salaryMin',
    'sourceId',
    'status',
    'title',
    'workMode',
  ].includes(field.key);
}

function isHiddenViewField(field: ResourceField): boolean {
  if (field.key === 'postingUrl' || field.key === 'canonicalUrl') return true;
  if (
    [
      'artifactRefsJson',
      'createdBy',
      'createdByProfileId',
      'externalId',
      'externalTaskId',
      'organizationProfileId',
      'preferenceSnapshotJson',
      'rawPayloadJson',
      'updated_at',
      'created_at',
    ].includes(field.key)
  ) {
    return true;
  }
  if (/^external/i.test(field.key)) return true;
  if (/Json$/.test(field.key) && field.kind === 'textarea') return true;
  return false;
}

function isDescriptionField(field: ResourceField): boolean {
  return (
    field.kind === 'textarea' &&
    /(description|summary|instructions|notes|body|rawText)/i.test(field.key)
  );
}

function shouldShowDescriptionField(field: ResourceField): boolean {
  if (isOpportunityRecord) return field.key === 'descriptionRaw';
  return isDescriptionField(field);
}

function shouldShowDetailField(field: ResourceField): boolean {
  if (isHiddenViewField(field)) return false;
  if (isOverviewOnlyField(field)) return false;
  if (isDescriptionField(field)) return false;
  return hasDisplayValue(field);
}

function fieldPriority(field: ResourceField): number {
  const order = [
    'employmentType',
    'seniority',
    'locationNotes',
    'locations',
    'relocationSupported',
    'visaOrEorPossible',
    'requiredSkills',
    'preferredSkills',
    'responsibilities',
    'qualifications',
    'domainTags',
    'roleTags',
    'greenfieldSignal',
    'founderSignal',
    'freshness',
    'humanRating',
    'humanReviewNotes',
    'compNotes',
  ];
  const index = order.indexOf(field.key);
  return index === -1 ? 1000 : index;
}

function setOpportunityReviewStatus(status: string): void {
  opportunityReviewStatus = status;
}

function enhanceOpportunityExtraction() {
  return async ({
    result,
    update,
  }: {
    result: { data?: AdminActionFeedback; type: string };
    update: (options: {
      invalidateAll?: boolean;
      reset?: boolean;
    }) => Promise<void>;
  }) => {
    if (result.type === 'success') {
      await update({ invalidateAll: true, reset: false });
      const failed = numberFromValue(result.data?.failed);
      const status = stringFromValue(result.data?.status);
      opportunityExtractionState =
        (status === 'processed' || status === 'queued') && failed === 0
          ? status
          : 'error';
      opportunityExtractionMessage =
        result.data?.message ?? 'Opportunity processing completed.';
      return;
    }

    opportunityExtractionState = 'error';
    opportunityExtractionMessage =
      result.data?.message ?? 'Could not process opportunity.';
  };
}

function enhanceSourceCrawlNow() {
  return async ({
    result,
    update,
  }: {
    result: { data?: { message?: string; status?: string }; type: string };
    update: (options: {
      invalidateAll?: boolean;
      reset?: boolean;
    }) => Promise<void>;
  }) => {
    if (result.type === 'success' && result.data?.status === 'queued') {
      await update({ invalidateAll: true, reset: false });
      sourceCrawlState = 'queued';
      sourceCrawlMessage = result.data.message ?? 'Crawl queued.';
      return;
    }

    sourceCrawlState = 'error';
    sourceCrawlMessage = result.data?.message ?? 'Could not queue crawl.';
  };
}

$effect(() => {
  const nextId = String(data.record.id ?? '');
  if (nextId === opportunityReviewRecordId) return;
  opportunityReviewRecordId = nextId;
  opportunityReviewStatus = stringValue('humanReviewStatus');
  opportunityReviewRating = stringValue('humanRating');
  opportunityReviewNotes = stringValue('humanReviewNotes');
  opportunityExtractionState = 'idle';
  opportunityExtractionMessage = '';
});

$effect(() => {
  const nextId = isSourceRecord ? String(data.record.id ?? '') : '';
  if (nextId === sourceCrawlRecordId) return;
  sourceCrawlRecordId = nextId;
  sourceCrawlState = 'idle';
  sourceCrawlMessage = '';
});

$effect(() => {
  if (!isOpportunityRecord || !form || form === lastOpportunityActionForm)
    return;
  lastOpportunityActionForm = form;
  notifyOpportunityListChanged(String(data.record.id ?? ''));
});
</script>

<section class="record-view-page" class:is-opportunity={isOpportunityRecord}>
  <header class="record-page-header">
    <div>
      <a class="back-link" href={listHref}>
        <ArrowLeft size={15} strokeWidth={2.2} />
        <span>{data.resource.label}</span>
      </a>
      {#if !isOpportunityRecord}
        <h1>{titleValue()}</h1>
        <p>{data.resource.singularLabel}</p>
      {/if}
    </div>
    <div class="record-actions">
      {#each viewLinkActions() as action}
        <a
          class="secondary-action"
          href={action.href}
          target="_blank"
          rel="noreferrer"
          title={action.title}
        >
          <ExternalLink size={16} strokeWidth={2.2} />
          <span>{action.label}</span>
        </a>
      {/each}
      {#if isOpportunityRecord && !hasApplyablePostingLink()}
        <span class="secondary-action disabled" title="No direct posting URL was captured for this opportunity">
          <ExternalLink size={16} strokeWidth={2.2} />
          <span>No posting URL</span>
        </span>
      {/if}
      {#if reviewHref}
        <a class="secondary-action" href={reviewHref}>
          <MessageSquareText size={16} strokeWidth={2.2} />
          <span>Review</span>
        </a>
      {/if}
      {#if isOpportunityRecord}
        <form
          method="POST"
          action="?/processOpportunity"
          use:enhance={enhanceOpportunityExtraction}
          onsubmit={() => {
            opportunityExtractionState = 'processing';
            opportunityExtractionMessage = 'Queueing opportunity...';
          }}
        >
          <input type="hidden" name="opportunityId" value={data.record.id ?? ''} />
          <button
            class="secondary-action"
            type="submit"
            disabled={opportunityExtractionState === 'processing'}
          >
            <Sparkles size={16} strokeWidth={2.2} />
            <span>{opportunityExtractionState === 'processing' ? 'Processing' : 'Process'}</span>
          </button>
        </form>
      {/if}
      {#if isCompanyRecord}
        <form method="POST" action="?/researchCompany" use:enhance>
          <input type="hidden" name="companyId" value={data.record.id ?? ''} />
          <button class="secondary-action" type="submit">
            <Sparkles size={16} strokeWidth={2.2} />
            <span>Research</span>
          </button>
        </form>
      {/if}
      {#if isSourceRecord}
        <form
          method="POST"
          action="?/crawlSourceNow"
          use:enhance={enhanceSourceCrawlNow}
          onsubmit={() => {
            sourceCrawlState = 'queueing';
            sourceCrawlMessage = '';
          }}
        >
          <input type="hidden" name="sourceId" value={data.record.id ?? ''} />
          <button
            class="secondary-action"
            type="submit"
            disabled={sourceCrawlState === 'queueing'}
          >
            <RotateCw size={16} strokeWidth={2.2} />
            <span>{sourceCrawlState === 'queueing' ? 'Queueing' : 'Crawl now'}</span>
          </button>
        </form>
      {/if}
      <a class="primary-action" href={editHref}>
        <Edit3 size={16} strokeWidth={2.2} />
        <span>Edit</span>
      </a>
    </div>
  </header>

  {#if isSourceRecord && sourceCrawlMessage}
    <p class={`record-action-feedback ${sourceCrawlState}`}>
      {sourceCrawlMessage}
    </p>
  {:else if actionFeedbackMessage}
    <p class={`record-action-feedback ${actionFeedbackTone}`}>
      {actionFeedbackMessage}
    </p>
  {/if}

  {#if taskWorkTarget}
    <section class="task-work-target" aria-label="Task work target">
      <a class="primary-action" href={taskWorkTarget.href}>
        <ExternalLink size={16} strokeWidth={2.2} />
        <span>{taskWorkTarget.label}</span>
      </a>
      <p>{taskWorkTarget.description}</p>
    </section>
  {/if}

  {#if isRecommendationTask}
    <section class="panel workflow-panel" aria-label="Recommendation decision">
      <h2 class="panel-title">Recommendation decision</h2>
      <form method="POST" action="?/processRecommendationTask" class="stack-form">
        <input type="hidden" name="taskId" value={data.record.id ?? ''} />
        <label>
          <span>Decision</span>
          <select name="decision" required>
            {#each recommendationDecisionDefinitions as decision}
              <option value={decision.value}>{decision.label}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Decider profile ID</span>
          <input type="text" name="deciderProfileId" />
        </label>
        <label class="wide">
          <span>Rationale</span>
          <textarea name="reason" rows="3" value={stringValue('blockerReason')}></textarea>
        </label>
        <label class="wide">
          <span>Override inconclusive posting check</span>
          <input
            name="preflightOverrideReason"
            placeholder="Reason only after you personally verified the posting is open"
          />
        </label>
        <button class="primary-action" type="submit">
          <BadgeCheck size={16} strokeWidth={2.2} />
          <span>Record decision</span>
        </button>
      </form>
    </section>
  {/if}

  {#if isOpportunityRecord}
    <aside class="opportunity-summary" aria-label="Opportunity summary">
      <div class="summary-head">
        <span class="summary-eyebrow">Opportunity</span>
        <h2>{titleValue()}</h2>
        <p class="summary-company">
          {#if companyId}
            <a
              href={`/admin/companies/${companyId}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {companyName}
            </a>
          {:else}
            <span>{companyName}</span>
          {/if}
          {#if companyWebsite}
            <a class="summary-company-ext" href={companyWebsite} target="_blank" rel="noreferrer" title="Company website">
              <ExternalLink size={13} strokeWidth={2.4} />
            </a>
          {/if}
        </p>
      </div>

      <dl class="summary-facts field-list">
        <div>
          <dt>Source</dt>
          <dd>
            {#if sourceId}
              <a href={`/admin/sources/${sourceId}`}>{referenceLabel('sourceId', sourceId) || 'Source'}</a>
            {:else}
              —
            {/if}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{humanizeValue(stringValue('status'), '—')}</dd>
        </div>
        <div>
          <dt>User review</dt>
          <dd>{humanizeValue(stringValue('humanReviewStatus'), '—')}</dd>
        </div>
        <div>
          <dt>Work mode</dt>
          <dd>{humanizeValue(stringValue('workMode'), '—')}</dd>
        </div>
        <div>
          <dt>Compensation</dt>
          <dd>{compensationSummary() || '—'}</dd>
        </div>
        <div>
          <dt>Apply</dt>
          <dd class="apply-cell">
            {#if applyUrlValue}
              <a href={applyUrlValue} target="_blank" rel="noreferrer">
                {humanizeValue(applyMethodValue, 'Apply')}
              </a>
            {:else}
              <span>{humanizeValue(applyMethodValue, '—')}</span>
            {/if}
            {#if needsApplyUrl}
              <small class="apply-flag">No direct apply URL — find it on the company site</small>
            {/if}
            {#if applyInstructionsValue}
              <small>{applyInstructionsValue}</small>
            {/if}
          </dd>
        </div>
      </dl>

      {#if appliedApplicationId}
        <div class="summary-applied">
          <span class="summary-eyebrow">Application</span>
          <strong>{humanizeValue(appliedApplicationStatus, 'In progress')}</strong>
          <a class="primary-action" href={`/admin/applications/${encodeURIComponent(appliedApplicationId)}`}>
            <ExternalLink size={16} strokeWidth={2.2} />
            <span>Open application</span>
          </a>
        </div>
      {:else}
        <form method="POST" action="?/reviewOpportunity" class="opportunity-review-bar">
          <input type="hidden" name="opportunityId" value={data.record.id ?? ''} />
          <input type="hidden" name="humanReviewStatus" value={opportunityReviewStatus} />
          <input type="hidden" name="reviewedByProfileId" value={stringValue('reviewedByProfileId')} />
          <label class="review-control status-control">
            <span>User review</span>
            <div class="status-toggle-group" aria-label="User review status">
              {#each reviewStatuses as status}
                <button
                  type="submit"
                  name="humanReviewStatus"
                  value={status.value}
                  formaction={status.value === 'apply' ? '?/acceptOpportunity' : undefined}
                  class:active={opportunityReviewStatus === status.value}
                  class={`status-toggle ${status.tone}`}
                  aria-pressed={opportunityReviewStatus === status.value}
                  title={status.value === 'apply' ? 'Apply and start an application' : status.label}
                  onclick={() => setOpportunityReviewStatus(status.value)}
                >
                  {status.label}
                </button>
              {/each}
            </div>
          </label>
          <label class="review-control rating-control">
            <span>Rating</span>
            <select name="humanRating" bind:value={opportunityReviewRating}>
              <option value="">None</option>
              {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as rating}
                <option value={rating}>{rating}/10</option>
              {/each}
            </select>
          </label>
          <label class="review-control notes-control">
            <span>Reason / notes</span>
            <textarea name="humanReviewNotes" rows="2" bind:value={opportunityReviewNotes}></textarea>
          </label>
          <label class="review-control notes-control">
            <span>Override inconclusive posting check</span>
            <input
              name="preflightOverrideReason"
              placeholder="Only after you personally verified it is open"
            />
          </label>
          <button class="primary-action review-save-action" type="submit">
            <Save size={16} strokeWidth={2.2} />
            <span>Save review</span>
          </button>
        </form>
      {/if}
    </aside>
  {/if}

  {#if isOpportunityRecord}
    <section class="panel workflow-panel" aria-label="Opportunity workflow">
      <h2 class="panel-title">Application and notes</h2>
      {#if appliedApplicationId}
        <p class="panel-note">
          {humanizeValue(appliedApplicationStatus, 'Draft')} application —
          <a href={`/admin/applications/${encodeURIComponent(appliedApplicationId)}`}>open it</a>
          to generate the packet or record a submission.
        </p>
      {/if}
      <OpportunityWorkflowForms record={data.record} />
      {#if opportunityFactIntakes.length > 0}
        <ul class="related-list">
          {#each opportunityFactIntakes as intake, index (intake.id ?? index)}
            <li class="related-item">
              <div class="related-item-head">
                <strong>Intake {opportunityFactIntakes.length - index}</strong>
                <span>{humanizeValue(intake.status, 'Draft')}</span>
                {#if intake.updated_at}
                  <span>Updated {displayDate(intake.updated_at)}</span>
                {/if}
              </div>
              {#if stringFromValue(intake.intakeContext)}
                <p class="related-meta">{stringFromValue(intake.intakeContext)}</p>
              {/if}
              {#if stringFromValue(intake.rawText)}
                <p>{stringFromValue(intake.rawText)}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="panel-note">No notes are linked to this opportunity yet.</p>
      {/if}
    </section>
  {/if}

  {#if !isOpportunityRecord}
    {#if overviewFields.length > 0 || compensationSummary()}
    <dl class="panel field-list record-overview" aria-label="Important details">
      {#each overviewFields as field}
        <div>
          <dt>{displayFieldLabel(field)}</dt>
          <dd>
            <AdminRecordValue
              {field}
              record={data.record}
              referenceOptions={data.referenceOptions}
            />
          </dd>
        </div>
      {/each}
      {#if compensationSummary()}
        <div>
          <dt>Compensation</dt>
          <dd>{compensationSummary()}</dd>
        </div>
      {/if}
    </dl>
    {/if}
  {/if}

  {#if descriptionFields.length > 0}
    <section class="panel description-section" aria-label="Description">
      {#each descriptionFields as field}
        <article>
          <span class="field-kicker">{displayFieldLabel(field)}</span>
          <AdminRecordValue
            {field}
            record={data.record}
            referenceOptions={data.referenceOptions}
          />
        </article>
      {/each}
    </section>
  {/if}

  {#if isOpportunityRecord && (stringValue('latestScore') || stringValue('latestRecommendation') || stringValue('latestScoreSummary') || stringListFor('latestDataQualityWarnings').length > 0 || evidenceEntries().length > 0 || agentRunEntries().length > 0)}
    {@const warnings = stringListFor('latestDataQualityWarnings')}
    {@const fitReasons = stringListFor('latestFitReasons')}
    {@const risks = stringListFor('latestRisks')}
    {@const missingInfo = stringListFor('latestMissingInfo')}
    {@const evidence = evidenceEntries()}
    {@const runs = agentRunEntries()}
    <section class="panel record-intelligence" aria-label="Opportunity intelligence">
      <div class="intel-head">
        <span class="field-kicker">Recommendation</span>
        <strong>{latestScoreLabel()}</strong>
      </div>
      {#if stringValue('latestScoreSummary')}
        <p>{stringValue('latestScoreSummary')}</p>
      {/if}
      <div class="intelligence-meta">
        <span>{evidenceGapCount()} evidence gaps</span>
        <span>{warnings.length} quality warnings</span>
      </div>
      {#if fitReasons.length > 0}
        <div class="intelligence-list-block">
          <h2>Fit</h2>
          <ul>
            {#each fitReasons as reason}
              <li>{reason}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if risks.length > 0}
        <div class="intelligence-list-block">
          <h2>Risks</h2>
          <ul>
            {#each risks as risk}
              <li>{risk}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if missingInfo.length > 0}
        <div class="intelligence-list-block">
          <h2>Missing Info</h2>
          <ul>
            {#each missingInfo as item}
              <li>{item}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if warnings.length > 0}
        <div class="intelligence-list-block">
          <h2>Quality Warnings</h2>
          <ul class="warning-list">
            {#each warnings as warning}
              <li>{warning}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if evidence.length > 0}
        <div class="intelligence-list-block">
          <h2>Evidence And Gaps</h2>
          <div class="evidence-list">
            {#each evidence as entry}
              <article class={`evidence-item ${evidenceStatusClass(entry.status)}`}>
                <header>
                  <strong>{stringFromValue(entry.requirement)}</strong>
                  <span>{evidenceStatusLabel(entry.status)}</span>
                </header>
                {#if entry.sources && entry.sources.length > 0}
                  <ul>
                    {#each entry.sources as source}
                      <li>
                        <span>{stringFromValue(source.title) || stringFromValue(source.kind) || 'Evidence'}</span>
                        {#if stringFromValue(source.excerpt)}
                          <small>{stringFromValue(source.excerpt)}</small>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p>No reviewed evidence matched this requirement.</p>
                {/if}
              </article>
            {/each}
          </div>
        </div>
      {/if}
      {#if runs.length > 0}
        <div class="intelligence-list-block">
          <h2>Agent History</h2>
          <dl class="agent-run-list">
            {#each runs as run}
              <div>
                <dt>{humanizeValue(run.runType, 'run')}</dt>
                <dd>
                  <span>{humanizeValue(run.status, 'unknown')}</span>
                  {#if agentRunDate(run)}
                    <time>{agentRunDate(run)}</time>
                  {/if}
                  {#if stringFromValue(run.error)}
                    <small>{stringFromValue(run.error)}</small>
                  {/if}
                </dd>
              </div>
            {/each}
          </dl>
        </div>
      {/if}
    </section>
  {/if}

  <section class="panel record-details" aria-label={`${data.resource.singularLabel} details`}>
    <h2 class="panel-title">{data.resource.singularLabel} details</h2>
    <dl class="field-list">
      {#each detailFields as field}
        <div class:wide={field.kind === 'textarea'}>
          <dt>{displayFieldLabel(field)}</dt>
          <dd>
            <AdminRecordValue
              {field}
              record={data.record}
              referenceOptions={data.referenceOptions}
            />
          </dd>
        </div>
      {/each}
    </dl>
  </section>

  {#each opportunityRelations as editor (editor.kind)}
    <section
      class="panel workflow-panel"
      aria-label={`Opportunity ${editor.label.toLowerCase()}`}
      data-relation={editor.kind}
    >
      <div class="panel-head">
        <h2 class="panel-title">{editor.label}</h2>
        <a class="panel-link" href={`/admin/${editor.resource.slug}`}>
          All {editor.resource.label.toLowerCase()}
        </a>
      </div>
      <p class="panel-note">{editor.resource.description}</p>
      {#if editor.records.length > 0}
        <ul class="related-list">
          {#each editor.records as relation (relation.id)}
            <li class="related-item related-item-row">
              <span>{relationSummary(editor, relation) || relation.id}</span>
              <form method="POST" action="?/deleteOpportunityRelation" class="inline-form">
                <input type="hidden" name="relation" value={editor.kind} />
                <input type="hidden" name="id" value={relation.id ?? ''} />
                <button
                  type="submit"
                  class="icon-action"
                  aria-label={`Remove ${editor.resource.singularLabel.toLowerCase()}`}
                  title={`Remove ${editor.resource.singularLabel.toLowerCase()}`}
                >
                  <Trash2 size={15} strokeWidth={2.2} />
                </button>
              </form>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="panel-note">None attached yet.</p>
      {/if}
      <SmrtForm method="POST" action="?/createOpportunityRelation">
        <input type="hidden" name="relation" value={editor.kind} />
        <ResourceFormFields
          comboOptions={editor.comboOptions}
          fields={relationFields(editor)}
          referenceOptions={editor.referenceOptions}
          record={{ opportunityId: data.record.id ?? '' }}
        />
        <button class="secondary-action" type="submit">
          <Save size={16} strokeWidth={2.2} />
          <span>Add {editor.resource.singularLabel.toLowerCase()}</span>
        </button>
      </SmrtForm>
    </section>
  {/each}
</section>

<style>
  .record-view-page {
    display: grid;
    gap: 20px;
    color: var(--smrt-color-on-surface);
  }

  .record-page-header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 18px;
  }

  .record-page-header h1 {
    margin: 8px 0 4px;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-medium-font);
  }

  .record-page-header p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.45;
    text-transform: capitalize;
  }

  .back-link,
  .primary-action,
  .secondary-action {
    display: inline-flex;
    min-height: 36px;
    align-items: center;
    gap: 8px;
    color: var(--smrt-color-primary);
    font-weight: 800;
    text-decoration: none;
  }

  .back-link {
    min-height: 0;
  }

  .primary-action,
  .secondary-action {
    padding: 0 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
  }

  .primary-action {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .secondary-action:disabled {
    color: var(--smrt-color-on-surface-variant);
    cursor: progress;
    opacity: 0.72;
    text-decoration: none;
  }

  .back-link:hover,
  .back-link:focus-visible,
  .secondary-action:hover,
  .secondary-action:focus-visible {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  .record-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: end;
    gap: 8px;
  }

  .record-actions form {
    display: contents;
  }

  .record-action-feedback {
    max-width: 900px;
    margin: -4px 0 0;
    padding: 10px 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.4;
  }

  .record-action-feedback.processing {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-primary);
  }

  .record-action-feedback.processed {
    border-color: var(--smrt-color-success);
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .record-action-feedback.queued {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-primary);
  }

  .record-action-feedback.error {
    border-color: var(--smrt-color-error);
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  /* ===== Shared section + field primitives ===== */
  .panel {
    display: grid;
    gap: 12px;
    max-width: 940px;
    margin: 0;
  }

  .panel + .panel {
    padding-top: 18px;
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .panel-title {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .field-kicker {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.4 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .field-list {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .field-list > div {
    display: grid;
    grid-template-columns: minmax(110px, max-content) minmax(0, 1fr);
    gap: 4px 16px;
    align-items: baseline;
  }

  .field-list > div.wide {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .field-list dd {
    margin: 0;
    min-width: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
    overflow-wrap: anywhere;
  }

  .field-list dd a {
    color: var(--smrt-color-primary);
    text-decoration: none;
  }

  .field-list dd a:hover {
    text-decoration: underline;
  }

  .task-work-target {
    display: grid;
    max-width: 720px;
    justify-items: start;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
  }

  .task-work-target p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 13px;
    line-height: 1.4;
  }

  .opportunity-review-bar {
    position: sticky;
    top: 0;
    z-index: 3;
    display: grid;
    grid-template-columns: minmax(250px, 1.2fr) minmax(120px, 0.5fr) minmax(
        280px,
        1fr
      ) auto;
    gap: 10px;
    align-items: end;
    max-width: 1160px;
    padding: 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.08);
  }

  .review-control {
    display: grid;
    gap: 6px;
    min-width: 0;
    color: var(--smrt-color-on-surface);
    font-weight: 800;
  }

  .review-control > span {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .status-toggle-group {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }

  .status-toggle {
    min-height: 34px;
    border: 1px solid currentColor;
    border-radius: 6px;
    background: var(--smrt-color-surface);
    font-weight: 900;
  }

  .status-toggle.green {
    color: var(--smrt-color-on-success-container);
  }

  .status-toggle.amber {
    color: var(--smrt-color-on-warning-container);
  }

  .status-toggle.red {
    color: var(--smrt-color-on-error-container);
  }

  .status-toggle.green.active {
    background: var(--smrt-color-success);
    color: var(--smrt-color-on-success);
  }

  .status-toggle.amber.active {
    background: var(--smrt-color-warning);
    color: var(--smrt-color-on-warning);
  }

  .status-toggle.red.active {
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
  }

  .opportunity-review-bar select,
  .opportunity-review-bar textarea {
    width: 100%;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    padding: 8px 10px;
  }

  .opportunity-review-bar textarea {
    min-height: 36px;
    resize: vertical;
  }

  .review-save-action {
    margin-top: 0;
    white-space: nowrap;
  }

  /* Opportunity view: two-column layout with the review form as a sticky
     right column. Header spans both columns; all other content stays left. */
  .record-view-page.is-opportunity {
    grid-template-columns: minmax(0, 1fr) clamp(280px, 26vw, 340px);
    column-gap: 22px;
    align-items: start;
  }

  .record-view-page.is-opportunity > .record-page-header {
    grid-column: 1 / -1;
  }

  .record-view-page.is-opportunity
    > :not(.record-page-header):not(.opportunity-summary) {
    grid-column: 1;
    min-width: 0;
  }

  .record-view-page.is-opportunity > .opportunity-summary {
    grid-column: 2;
    grid-row: 2 / span 999;
    align-self: start;
    position: sticky;
    top: 16px;
    display: grid;
    gap: 14px;
    padding: 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 10px;
    background: var(--smrt-color-surface-container-low);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.06);
  }

  .opportunity-summary .summary-head {
    display: grid;
    gap: 4px;
  }

  .summary-eyebrow {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .opportunity-summary h2 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-small-font);
    overflow-wrap: anywhere;
  }

  .summary-company {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }

  .summary-company a {
    color: var(--smrt-color-primary);
    font-weight: 800;
    text-decoration: none;
  }

  .summary-company a:hover {
    text-decoration: underline;
  }

  .summary-company-ext {
    display: inline-flex;
    color: var(--smrt-color-on-surface-variant);
  }

  /* summary-facts is a .field-list; it only adds the in-card divider. */
  .summary-facts {
    padding: 12px 0;
    border-top: 1px solid var(--smrt-color-outline-variant);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .summary-facts dd {
    text-transform: capitalize;
  }

  .summary-facts dd a {
    text-transform: none;
  }

  .apply-cell {
    display: grid;
    gap: 4px;
  }

  .apply-cell small {
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    line-height: 1.35;
    text-transform: none;
  }

  .apply-cell .apply-flag {
    color: var(--smrt-color-on-warning-container);
    font-weight: 700;
  }

  .summary-applied {
    display: grid;
    justify-items: start;
    gap: 8px;
  }

  .summary-applied strong {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-small-font);
    text-transform: capitalize;
  }

  /* Review form nests inside the sticky aside as a vertical stack. */
  .opportunity-summary .opportunity-review-bar {
    position: static;
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    max-width: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .intel-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .intel-head strong {
    color: var(--smrt-color-on-success-container);
    font: var(--smrt-typography-title-small-font);
    text-transform: capitalize;
  }

  .record-intelligence p {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.45;
  }

  .intelligence-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .intelligence-meta span {
    padding: 4px 8px;
    border-radius: 999px;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .record-intelligence ul {
    display: grid;
    gap: 5px;
    margin: 0;
    padding-left: 17px;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.4;
  }

  .record-intelligence .warning-list {
    color: var(--smrt-color-on-warning-container);
  }

  .intelligence-list-block {
    display: grid;
    gap: 7px;
    padding-top: 10px;
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .intelligence-list-block h2 {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .evidence-list {
    display: grid;
    gap: 8px;
  }

  .evidence-item {
    display: grid;
    gap: 7px;
    padding-left: 10px;
    border-left: 3px solid var(--smrt-color-warning);
  }

  .evidence-item.supported {
    border-left-color: var(--smrt-color-success);
  }

  .evidence-item header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .evidence-item header strong {
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.35;
  }

  .evidence-item header span {
    color: var(--smrt-color-on-surface-variant);
    font: 800 10px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .evidence-item p,
  .evidence-item small,
  .agent-run-list small {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    line-height: 1.4;
  }

  .evidence-item li span {
    display: block;
    font-weight: 800;
  }

  .agent-run-list {
    display: grid;
    gap: 8px;
    margin: 0;
  }

  .agent-run-list > div {
    display: grid;
    grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
    gap: 4px 16px;
    align-items: baseline;
  }

  .agent-run-list dd {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin: 0;
  }

  .agent-run-list time {
    color: var(--smrt-color-on-surface-variant);
  }

  .description-section article {
    display: grid;
    gap: 6px;
  }

  .description-section :global(.formatted-text) {
    line-height: 1.55;
  }

  /* One label style + base value style for every field list. */
  dl {
    margin: 0;
  }

  dt {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.4 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  dd {
    min-width: 0;
    margin: 0;
    color: var(--smrt-color-on-surface);
    overflow-wrap: anywhere;
    line-height: 1.45;
  }

  @media (max-width: 1024px) {
    .record-view-page.is-opportunity {
      grid-template-columns: 1fr;
    }

    .record-view-page.is-opportunity > .opportunity-summary {
      position: static;
      grid-column: 1;
      grid-row: auto;
    }
  }

  @media (max-width: 760px) {
    .record-page-header {
      display: grid;
    }

    .record-actions {
      justify-content: start;
    }

    .opportunity-review-bar {
      position: static;
      grid-template-columns: 1fr;
    }
  }

  .workflow-panel {
    padding: 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
  }

  .workflow-panel + .workflow-panel,
  .panel + .workflow-panel {
    padding-top: 14px;
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .panel-link {
    color: var(--smrt-color-primary);
    font-size: 13px;
    font-weight: 800;
    text-decoration: none;
  }

  .panel-link:hover {
    text-decoration: underline;
  }

  .panel-note {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 13px;
    line-height: 1.45;
  }

  .panel-note a {
    color: var(--smrt-color-primary);
  }

  .stack-form {
    display: grid;
    gap: 10px;
  }

  .grid-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stack-form label {
    display: grid;
    gap: 4px;
    min-width: 0;
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .stack-form label.wide,
  .stack-form button {
    grid-column: 1 / -1;
  }

  .stack-form button {
    justify-self: start;
  }

  .stack-form select,
  .stack-form input,
  .stack-form textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    text-transform: none;
  }

  .stack-form textarea {
    resize: vertical;
  }

  .related-list {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .related-item {
    display: grid;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    font-size: 13px;
    line-height: 1.45;
  }

  .related-item p {
    margin: 0;
  }

  .related-item-row {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }

  .related-item-head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
  }

  .related-item-head strong {
    color: var(--smrt-color-on-surface);
  }

  .related-meta {
    color: var(--smrt-color-on-surface-variant);
  }

  .inline-form {
    display: inline-flex;
    margin: 0;
  }

  .icon-action {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }

  .icon-action:hover,
  .icon-action:focus-visible {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  @media (max-width: 720px) {
    .grid-form {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
