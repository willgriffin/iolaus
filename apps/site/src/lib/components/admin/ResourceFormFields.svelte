<script lang="ts">
import {
  CheckboxInput,
  DateTimeInput,
  NumberInput,
  SelectInput,
  TextareaInput,
  TextInput,
} from '@happyvertical/smrt-svelte/forms';
import {
  displayFieldLabel,
  type ReferenceOption,
  type ReferenceOptionsByField,
  type ResourceField,
  referenceForField,
  referenceIsEditable,
} from '$lib/admin/resources';

type AdminRecord = Record<string, unknown>;
type ComboOption = { label: string; value: string };

let {
  comboOptions = {},
  fields,
  referenceOptions = {},
  record = {},
} = $props<{
  comboOptions?: Record<string, ComboOption[]>;
  fields: ResourceField[];
  referenceOptions?: ReferenceOptionsByField;
  record?: AdminRecord;
}>();

const primaryFields = $derived(
  fields.filter((field: ResourceField) => !isAdvancedFormField(field)),
);
const advancedFields = $derived(fields.filter(isAdvancedFormField));

const advancedFieldKeys = new Set([
  'artifactRefsJson',
  'canonicalUrl',
  'createdBy',
  'createdByProfileId',
  'externalId',
  'externalTaskId',
  'metadata',
  'organizationProfileId',
  'preferenceSnapshotJson',
  'rawPayloadJson',
]);

function isAdvancedFormField(field: ResourceField): boolean {
  if (advancedFieldKeys.has(field.key)) return true;
  if (/^(created|updated)_at$/i.test(field.key)) return true;
  if (/^external/i.test(field.key)) return true;
  if (/Json$/.test(field.key) && field.kind === 'textarea') return true;
  return false;
}

function fieldDefault(field: ResourceField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.kind === 'select') return field.options?.[0] ?? '';
  if (field.kind === 'checkbox') return false;
  return '';
}

function valueFor(field: ResourceField): string {
  const key = field.key;
  const value = record[key];
  if (value === null || value === undefined) return String(fieldDefault(field));
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

function numberValue(field: ResourceField): number | null {
  const value = record[field.key] ?? fieldDefault(field);
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return null;
}

function datetimeValue(field: ResourceField): string {
  const value = valueFor(field);
  return value ? value.slice(0, 16) : '';
}

function dateValue(field: ResourceField): string {
  const value = valueFor(field);
  return value ? value.slice(0, 10) : '';
}

function isChecked(field: ResourceField): boolean {
  const value = record[field.key] ?? fieldDefault(field);
  return value === true || value === 'true';
}

function selectOptions(field: ResourceField) {
  return (field.options ?? []).map((option) => ({
    value: option,
    label: option,
  }));
}

function comboValue(field: ResourceField): string {
  const value = valueFor(field);
  const option = comboOptions[field.key]?.find(
    (item: ComboOption) => item.value === value,
  );
  return option?.label ?? value;
}

function referenceOptionsFor(field: ResourceField): ReferenceOption[] {
  return referenceOptions[field.key] ?? [];
}

function selectedReferenceOption(field: ResourceField): ReferenceOption | null {
  const value = valueFor(field);
  if (!value) return null;
  return (
    referenceOptionsFor(field).find((option) => option.value === value) ?? {
      label: value,
      value,
    }
  );
}

function referenceSelectOptions(field: ResourceField): ReferenceOption[] {
  const options = referenceOptionsFor(field);
  const selected = selectedReferenceOption(field);
  if (!selected || options.some((option) => option.value === selected.value)) {
    return options;
  }
  return [selected, ...options];
}

function fieldLabel(field: ResourceField): string {
  return field.label;
}
</script>

{#snippet fieldControl(field: ResourceField)}
  {@const reference = referenceForField(field)}
  {@const selectedReference = selectedReferenceOption(field)}
  {#if reference && !referenceIsEditable(field)}
    <label class="reference-field">
      <span>
        {displayFieldLabel(field)}
        {#if field.required}
          <strong class="required-marker" aria-label="required">*</strong>
        {/if}
      </span>
      <input type="hidden" name={field.key} value={valueFor(field)} />
      {#if selectedReference?.href && !selectedReference.missing}
        <a href={selectedReference.href}>{selectedReference.label}</a>
      {:else}
        <strong class:missing-reference={selectedReference?.missing}>
          {selectedReference?.label ?? 'None'}
        </strong>
      {/if}
      {#if field.description}
        <small>{field.description}</small>
      {/if}
    </label>
  {:else if reference}
    <label class="reference-field">
      <span>
        {displayFieldLabel(field)}
        {#if field.required}
          <strong class="required-marker" aria-label="required">*</strong>
        {/if}
      </span>
      <select name={field.key} required={field.required} value={valueFor(field)}>
        <option value="">None</option>
        {#each referenceSelectOptions(field) as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      {#if field.description}
        <small>{field.description}</small>
      {/if}
    </label>
  {:else if field.kind === 'textarea'}
    <TextareaInput
      name={field.key}
      rows={field.rows ?? 3}
      required={field.required}
      placeholder={field.placeholder ?? ''}
      value={valueFor(field)}
      label={fieldLabel(field)}
      description={field.description ?? field.label}
    />
  {:else if field.kind === 'select'}
    <SelectInput
      name={field.key}
      required={field.required}
      value={valueFor(field)}
      label={fieldLabel(field)}
      description={field.description ?? field.label}
      options={selectOptions(field)}
    />
  {:else if field.kind === 'checkbox'}
    <CheckboxInput
      name={field.key}
      checked={isChecked(field)}
      label={fieldLabel(field)}
      description={field.description ?? field.label}
    />
  {:else if field.kind === 'datetime'}
    <DateTimeInput
      name={field.key}
      value={datetimeValue(field)}
      label={fieldLabel(field)}
      description={field.description ?? field.label}
    />
  {:else if field.kind === 'date'}
    <label class="native-field">
      <span>
        {field.label}
        {#if field.required}
          <strong class="required-marker" aria-label="required">*</strong>
        {/if}
      </span>
      <input name={field.key} type="date" value={dateValue(field)} required={field.required} />
      {#if field.description}
        <small>{field.description}</small>
      {/if}
    </label>
  {:else if field.kind === 'combo'}
    <label class="combo-field">
      <span>
        {field.label}
        {#if field.required}
          <strong class="required-marker" aria-label="required">*</strong>
        {/if}
      </span>
      <input
        list={`combo-${field.key}`}
        name={field.key}
        value={comboValue(field)}
        required={field.required}
        placeholder={field.placeholder ?? (field.combo?.allowCreate === false ? 'Search existing' : 'Search or create')}
      />
      <datalist id={`combo-${field.key}`}>
        {#each comboOptions[field.key] ?? [] as option}
          <option value={option.label}></option>
        {/each}
      </datalist>
      {#if field.description}
        <small>{field.description}</small>
      {/if}
    </label>
  {:else if field.kind === 'number'}
    <NumberInput
      name={field.key}
      step={0.01}
      value={numberValue(field)}
      required={field.required}
      placeholder={field.placeholder ?? ''}
      label={fieldLabel(field)}
      description={field.description ?? field.label}
    />
  {:else}
    <TextInput
      name={field.key}
      value={valueFor(field)}
      required={field.required}
      placeholder={field.placeholder ?? ''}
      label={fieldLabel(field)}
      description={field.description ?? field.label}
    />
    {#if field.key === 'wardenReference'}
      <p class="field-note secret-note">
        Store passwords, tokens, cookies, and recovery codes in Warden only.
        Keep this field to the non-secret item or folder reference.
      </p>
    {/if}
  {/if}
{/snippet}

<div class="fields-grid">
  {#each primaryFields as field}
    <div class="form-field-cell" class:wide={field.kind === 'textarea'}>
      {@render fieldControl(field)}
    </div>
  {/each}

  {#if advancedFields.length > 0}
    <details class="advanced-fields">
      <summary>Advanced fields</summary>
      <div class="advanced-fields-grid">
        {#each advancedFields as field}
          <div class="form-field-cell" class:wide={field.kind === 'textarea'}>
            {@render fieldControl(field)}
          </div>
        {/each}
      </div>
    </details>
  {/if}
</div>

<style>
  .fields-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px 12px;
    align-items: start;
  }

  .form-field-cell {
    min-width: 0;
  }

  .wide {
    grid-column: 1 / -1;
  }

  .advanced-fields {
    grid-column: 1 / -1;
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 4px;
  }

  .advanced-fields summary {
    cursor: pointer;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 800;
  }

  .advanced-fields-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px 12px;
    margin-top: 12px;
  }

  .fields-grid :global(.smrt-text-field),
  .fields-grid :global(.smrt-select-field),
  .fields-grid :global(.smrt-number),
  .fields-grid :global(.smrt-datetime),
  .fields-grid :global(.smrt-checkbox-field) {
    min-width: 0;
    width: 100%;
  }

  .fields-grid :global(.smrt-text-field),
  .fields-grid :global(.smrt-select-field),
  .fields-grid :global(.smrt-number),
  .fields-grid :global(.smrt-datetime) {
    gap: 6px;
  }

  .fields-grid :global(.smrt-text-field .container),
  .fields-grid :global(.smrt-select-field .container),
  .fields-grid :global(.smrt-number .input-wrapper),
  .fields-grid :global(.smrt-datetime .input-wrapper) {
    min-height: 0;
    padding: 0;
    border-radius: 0;
    background: transparent;
  }

  .fields-grid :global(.smrt-text-field .container:hover),
  .fields-grid :global(.smrt-select-field .container:hover) {
    background: transparent;
  }

  .fields-grid :global(.smrt-text-field .content),
  .fields-grid :global(.smrt-select-field .content) {
    height: auto;
    gap: 6px;
    padding-top: 0;
  }

  .fields-grid :global(.smrt-text-field .label),
  .fields-grid :global(.smrt-select-field .label),
  .fields-grid :global(.smrt-number .smrt-label),
  .fields-grid :global(.smrt-datetime .smrt-label) {
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.2;
    text-transform: none;
    transform: none;
  }

  .fields-grid :global(.smrt-text-field.focused .label),
  .fields-grid :global(.smrt-text-field.has-value .label),
  .fields-grid :global(.smrt-text-field.listening .label),
  .fields-grid :global(.smrt-select-field.focused .label),
  .fields-grid :global(.smrt-select-field.has-value .label) {
    color: var(--smrt-color-on-surface);
    transform: none;
  }

  .fields-grid :global(.smrt-text-field .input),
  .fields-grid :global(.smrt-select-field .input),
  .fields-grid :global(.smrt-number input),
  .fields-grid :global(.smrt-datetime .smrt-input) {
    min-height: 38px;
    height: 38px;
    width: 100%;
    padding: 0 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: 14px;
    letter-spacing: 0;
    line-height: 1.4;
  }

  .fields-grid :global(.smrt-text-field.multiline .input) {
    min-height: 96px;
    height: auto;
    padding: 8px 10px;
    resize: vertical;
  }

  .fields-grid :global(.smrt-text-field .input:focus),
  .fields-grid :global(.smrt-select-field .input:focus),
  .fields-grid :global(.smrt-number input:focus),
  .fields-grid :global(.smrt-datetime .smrt-input:focus),
  .combo-field input:focus,
  .reference-field select:focus,
  .native-field input:focus {
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 3px
      color-mix(in srgb, var(--smrt-color-primary) 12%, transparent);
    outline: none;
  }

  .fields-grid :global(.smrt-text-field .active-indicator),
  .fields-grid :global(.smrt-select-field .active-indicator) {
    display: none;
  }

  .fields-grid :global(.smrt-select-field .trailing-icon) {
    position: absolute;
    right: 10px;
    bottom: 9px;
    color: var(--smrt-color-on-surface-variant);
    pointer-events: none;
  }

  .fields-grid :global(.smrt-select-field .input) {
    padding-right: 34px;
  }

  .fields-grid :global(.smrt-text-field .supporting-text),
  .fields-grid :global(.smrt-select-field .supporting-text),
  .fields-grid :global(.smrt-number .validation-error),
  .fields-grid :global(.smrt-datetime .listening-indicator),
  .fields-grid :global(.smrt-datetime .parsing-indicator),
  .fields-grid :global(.smrt-datetime .error-indicator) {
    min-height: 0;
    padding: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.35;
  }

  .fields-grid :global(.smrt-checkbox-field) {
    display: inline-flex;
    min-height: 38px;
    align-items: center;
    gap: 10px;
    padding-top: 19px;
  }

  .fields-grid :global(.smrt-checkbox-field .container) {
    flex: 0 0 auto;
  }

  .fields-grid :global(.smrt-checkbox-field .label) {
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
  }

  :global(.smrt-input),
  :global(.input) {
    font-size: 14px;
  }

  .combo-field,
  .reference-field,
  .native-field {
    display: grid;
    gap: 6px;
    color: var(--smrt-color-on-surface);
    font-weight: 700;
  }

  .combo-field span,
  .reference-field span,
  .native-field span {
    font-size: 13px;
  }

  .required-marker {
    color: var(--smrt-color-on-error-container);
    font-weight: 900;
  }

  .combo-field small,
  .reference-field small,
  .native-field small,
  .field-note {
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.35;
  }

  .field-note {
    margin: -4px 0 0;
  }

  .secret-note {
    color: var(--smrt-color-on-error-container);
    font-weight: 700;
  }

  .combo-field input,
  .reference-field select,
  .native-field input {
    min-height: 38px;
    width: 100%;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    padding: 0 10px;
  }

  .reference-field a,
  .reference-field strong {
    min-height: 38px;
    display: inline-flex;
    align-items: center;
    color: var(--smrt-color-primary);
    font-size: 14px;
    text-decoration: none;
  }

  .reference-field a:hover,
  .reference-field a:focus-visible {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  .reference-field .missing-reference {
    color: var(--smrt-color-on-error-container);
  }
</style>
