<script lang="ts" module>
import type { AdminRecord } from '$lib/admin/dock';
import type { OpportunityScreeningProjection } from '$lib/server/opportunity-screening-projection';

const dimensions = {
  role_mismatch: 'Role differs from your target',
  country_mismatch: 'Work-country mismatch',
  work_mode_mismatch: 'Work-mode mismatch',
  authorization_mismatch: 'Work-authorization constraint',
  role_relevant: 'Role may be relevant',
  unresolved_constraint: 'Unresolved posting constraint',
  sponsorship_path: 'Conditional sponsorship path',
} as const;
const statuses = {
  clear_mismatch: 'Screened out',
  potentially_relevant: 'Potentially relevant',
  uncertain: 'Uncertain',
} as const;
const explanations: Record<string, string> = {
  target_roles_missing: 'Preferred roles are not established.',
  target_country_missing: 'Target work country is not established.',
  work_modes_missing: 'Preferred work modes are not established.',
  sponsorship_unknown: 'Sponsorship requirements need clarification.',
  authorization_scope_conditional:
    'Work authorization has a condition that needs review.',
  source_constraint_unresolved: 'A posting constraint needs clarification.',
  conflicting_role_evidence: 'The posting contains conflicting role evidence.',
  sponsorship_path_requires_user_decision:
    'The stated sponsorship path needs your review.',
};
function text(value: unknown, max = 32768): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function reasons(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((item) => text(item, 200))
  );
}
export function currentOpportunityScreening(
  record: AdminRecord,
): OpportunityScreeningProjection | null {
  try {
    const value =
      record.screeningProjection as OpportunityScreeningProjection | null;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.version !== 'opportunity-screening-projection/v1' ||
      value.mode !== 'coarse_screen' ||
      value.sourceStatus !== 'current' ||
      !Object.hasOwn(statuses, value.status) ||
      typeof value.excludeFromDefaultTriage !== 'boolean' ||
      !text(value.requestId, 200) ||
      !text(record.sourceContentFingerprint, 200) ||
      value.sourceContentFingerprint !== record.sourceContentFingerprint ||
      !Number.isSafeInteger(record.sourceContentVersion) ||
      Number(record.sourceContentVersion) < 1 ||
      value.sourceContentVersion !== record.sourceContentVersion ||
      ![
        value.sourceFingerprint,
        value.profileFingerprint,
        value.inputFingerprint,
      ].every(
        (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash),
      ) ||
      !Array.isArray(value.evidence) ||
      value.evidence.length > 7 ||
      !Array.isArray(value.conditionalPaths) ||
      value.conditionalPaths.length > 7 ||
      !reasons(value.uncertainties) ||
      !reasons(value.holdReasons)
    )
      return null;
    const source =
      typeof record.sourceContentJson === 'string'
        ? JSON.parse(record.sourceContentJson)
        : null;
    if (!source || typeof source !== 'object' || Array.isArray(source))
      return null;
    const validWitness = (
      witness: OpportunityScreeningProjection['evidence'][number]['witness'],
    ) => {
      if (
        !witness ||
        typeof witness !== 'object' ||
        !text(witness.id, 200) ||
        !text(witness.text) ||
        ![
          'sourceContentJson.descriptionRaw',
          'sourceContentJson.title',
          'sourceContentJson.locationNotes',
          'sourceContentJson.workMode',
        ].includes(witness.path)
      )
        return false;
      const original = source[witness.path.slice('sourceContentJson.'.length)];
      if (typeof original !== 'string') return false;
      if (witness.spanStart !== undefined || witness.spanEnd !== undefined)
        return (
          witness.path === 'sourceContentJson.descriptionRaw' &&
          Number.isSafeInteger(witness.spanStart) &&
          Number.isSafeInteger(witness.spanEnd) &&
          Number(witness.spanStart) >= 0 &&
          Number(witness.spanEnd) > Number(witness.spanStart) &&
          Number(witness.spanEnd) <= original.length &&
          Number(witness.spanEnd) - Number(witness.spanStart) ===
            witness.text.length &&
          original.slice(witness.spanStart, witness.spanEnd) === witness.text
        );
      return witness.path === 'sourceContentJson.descriptionRaw'
        ? original.includes(witness.text)
        : original === witness.text;
    };
    if (
      !value.evidence.every(
        (item) =>
          item &&
          Object.hasOwn(dimensions, item.dimension) &&
          Number.isFinite(item.probability) &&
          item.probability >= 0.85 &&
          item.probability <= 1 &&
          Number.isFinite(item.confidence) &&
          item.confidence >= 0.85 &&
          item.confidence <= 1 &&
          validWitness(item.witness),
      ) ||
      !value.conditionalPaths.every(
        (path) =>
          path &&
          path.kind === 'offered_sponsorship' &&
          validWitness(path.witness) &&
          value.evidence.some(
            (item) =>
              item.dimension === 'sponsorship_path' &&
              item.witness.id === path.witness.id &&
              item.witness.text === path.witness.text,
          ),
      )
    )
      return null;
    if (
      new Set(value.evidence.map((item) => item.dimension)).size !==
      value.evidence.length
    )
      return null;
    if (
      value.status === 'clear_mismatch' &&
      !value.evidence.some((item) => item.dimension.endsWith('_mismatch'))
    )
      return null;
    if (
      value.status === 'potentially_relevant' &&
      !value.evidence.some((item) => item.dimension === 'role_relevant')
    )
      return null;
    if (
      value.excludeFromDefaultTriage !==
      (value.status === 'clear_mismatch' && value.holdReasons.length === 0)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
function reasonLabel(reason: string): string {
  if (reason.startsWith('uncited_')) {
    const dimension = reason.slice(
      'uncited_'.length,
    ) as keyof typeof dimensions;
    return `${dimensions[dimension] ?? 'This screening conclusion'} lacks a cited source.`;
  }
  return explanations[reason] ?? 'Screening needs clarification.';
}
</script>

<script lang="ts">
let { record, compact = false } = $props<{ record: AdminRecord; compact?: boolean }>();
const current = $derived(currentOpportunityScreening(record));
const statusLabel = $derived(current?.status === 'clear_mismatch' && !current.excludeFromDefaultTriage ? 'Uncertain' : current ? statuses[current.status] : '');
const postingHref = $derived.by(() => {
  try {
    const url = new URL(String(record.postingUrl || record.applyUrl || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
});
</script>

{#if current}
  <section class="screening" class:compact aria-label="Coarse opportunity screening">
    <p class="status">Coarse screening: <strong>{statusLabel}</strong></p>
    <p class="scope">Screening does not establish overall fit, a match score or work authorization.</p>
    <details open={!compact}>
      <summary onclick={(event) => event.stopPropagation()}>Screening reasons and source quotes</summary>
      {#each current.evidence as item}
        <p class="reason">{dimensions[item.dimension]}</p>
        <blockquote><span class="quote">{item.witness.text}</span><cite>{#if postingHref}<a href={postingHref} target="_blank" rel="noreferrer noopener">Captured posting</a>{:else}Captured posting{/if}</cite></blockquote>
      {/each}
      {#if !current.evidence.length}<p>No cited conclusion is established.</p>{/if}
      {#each [...new Set([...current.uncertainties, ...current.holdReasons])] as reason}
        <p class="uncertainty">{reasonLabel(reason)}</p>
      {/each}
      {#if current.conditionalPaths.length}
        <p class="conditional">Sponsorship is a conditional path requiring review. It does not establish eligibility, work authorization or relocation approval.</p>
      {/if}
    </details>
  </section>
{/if}

<style>
.screening { min-width: 0; margin: 0.75rem 0; font-size: 0.875rem; line-height: 1.45; overflow-wrap: anywhere; }
.screening p { margin: 0.35rem 0; }
.status, .reason { font-weight: 600; }
.scope, cite { color: var(--text-muted, #555); }
summary { cursor: pointer; }
blockquote { margin: 0.5rem 0 0.75rem; padding-left: 0.75rem; border-left: 2px solid var(--border-color, #d1d5db); }
.quote { white-space: pre-wrap; }
cite { display: block; font-style: normal; font-size: 0.75rem; }
.compact { font-size: 0.75rem; }
</style>
