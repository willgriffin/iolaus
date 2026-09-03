<script lang="ts">
import {
  displayFieldLabel,
  type ReferenceOption,
  type ReferenceOptionsByField,
  type ResourceField,
  referenceForField,
} from '$lib/admin/resources';

type AdminRecord = Record<string, unknown>;

let {
  compact = false,
  field,
  record,
  referenceOptions = {},
} = $props<{
  compact?: boolean;
  field: ResourceField;
  record: AdminRecord;
  referenceOptions?: ReferenceOptionsByField;
}>();

const value = $derived(stringValue(record[field.key]));
const reference = $derived(referenceForField(field));
const referenceOption = $derived(
  value
    ? (referenceOptions[field.key]?.find(
        (option: ReferenceOption) => option.value === value,
      ) ?? null)
    : null,
);
const isUnknownId = $derived(
  !reference && Boolean(value) && /(?:^id$|id$)/i.test(field.key),
);
const isFormattedText = $derived(
  !compact && (field.kind === 'textarea' || value.includes('\n')),
);
const urlValue = $derived(urlFromValue(value));
const referenceTarget = $derived(
  field.key === 'companyId' ? '_blank' : undefined,
);
const referenceRel = $derived(
  referenceTarget ? 'noreferrer noopener' : undefined,
);

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

function isDateField(): boolean {
  return (
    field.kind === 'date' ||
    field.kind === 'datetime' ||
    field.key === 'created_at' ||
    field.key === 'updated_at' ||
    field.key.endsWith('At')
  );
}

function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: field.kind === 'date' ? undefined : 'numeric',
    minute: field.kind === 'date' ? undefined : '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function displayText(): string {
  if (!value) return '';
  if (isDateField()) return displayDate(value);
  if (field.kind === 'select') return humanizedValue(value);
  if (compact && value.length > 96) return `${value.slice(0, 93)}...`;
  return value;
}

function humanizedValue(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replace(/\bwill\b/gi, 'user')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function urlFromValue(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function urlLabel(): string {
  if (!urlValue) return value;
  if (/posting|canonical/i.test(field.key)) return 'View posting';
  return urlValue.hostname.replace(/^www\./, '') || 'Open link';
}
</script>

{#if reference}
  {#if !value}
    <span class="empty-value">None</span>
  {:else if referenceOption?.href}
    <a
      class="reference-link"
      href={referenceOption.href}
      target={referenceTarget}
      rel={referenceRel}
    >
      {referenceOption.label}
    </a>
  {:else}
    <span class:reference-placeholder={!referenceOption}>
      {referenceOption?.label ?? value}
    </span>
  {/if}
{:else if isUnknownId}
  <span class="reference-placeholder">{field.label.replace(/\s+ID$/i, '')}</span>
{:else if urlValue}
  <a
    class="reference-link"
    href={value}
    target="_blank"
    rel="noreferrer"
    title={value}
  >
    {compact ? urlValue.hostname.replace(/^www\./, '') : urlLabel()}
  </a>
{:else if displayText()}
  <span class:formatted-text={isFormattedText}>{displayText()}</span>
{:else}
  <span class="empty-value">None</span>
{/if}

<style>
  .reference-link {
    color: var(--smrt-color-primary);
    font-weight: 800;
    text-decoration: none;
  }

  .reference-link:hover,
  .reference-link:focus-visible {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  .empty-value,
  .reference-placeholder {
    color: var(--smrt-color-on-surface-variant);
  }

  .formatted-text {
    white-space: pre-wrap;
  }
</style>
