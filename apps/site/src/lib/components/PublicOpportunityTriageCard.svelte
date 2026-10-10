<script lang="ts">
import Banknote from '@lucide/svelte/icons/banknote';
import Building2 from '@lucide/svelte/icons/building-2';
import CalendarDays from '@lucide/svelte/icons/calendar-days';
import ExternalLink from '@lucide/svelte/icons/external-link';
import MapPin from '@lucide/svelte/icons/map-pin';
import { flushSync } from 'svelte';
import {
  TRIAGE_SWIPE_MAX_TILT_DEG,
  TRIAGE_SWIPE_THRESHOLD_PX,
  type TriageDrag,
  triageDragTransform,
  triageReleaseVerdict,
  triageSwipeProgress,
} from '$lib/admin/triage-gestures.js';
import type {
  PublicOpportunity,
  PublicOpportunityDetail,
} from '$lib/public-opportunity-contract.js';
import {
  opportunityLabel,
  postedCompensation,
  postedDate,
  postingLink,
} from '$lib/public-opportunity-presentation.js';
import { canonicalSkillSlug } from '$lib/skill-canonical.js';

type Decision = 'passed' | 'later' | 'saved';
let {
  opportunity,
  detail = null,
  detailState = 'loading',
  selectedSkills = [],
  busy = false,
  onAction,
  onOriginalOpen,
  onRetry,
}: {
  opportunity: PublicOpportunity;
  detail?: PublicOpportunityDetail | null;
  detailState?: 'loading' | 'ready' | 'error';
  selectedSkills?: string[];
  busy?: boolean;
  onAction: (decision: Decision) => void;
  onOriginalOpen?: () => void;
  onRetry?: () => void;
} = $props();

let drag = $state<TriageDrag | null>(null);
let pointerId: number | null = null;
let mouseDrag = $state(false);
let originX = 0;
let originY = 0;
let reducedMotion = $state(false);

const location = $derived(
  opportunity.location.text || opportunity.location.countries.join(', '),
);
const pay = $derived(postedCompensation(opportunity.compensation));
const posted = $derived(postedDate(opportunity.posted_at));
const original = $derived(postingLink(opportunity.posting_url));
const selected = $derived(
  new Set(selectedSkills.map((value) => canonicalSkillSlug(value))),
);
const allSkills = $derived(
  [
    ...new Map(
      [
        ...opportunity.skills.required,
        ...opportunity.skills.preferred,
        ...(opportunity.skills.mentioned ?? []),
      ].map((skill) => [skill.slug, skill]),
    ).values(),
  ].sort(
    (left, right) =>
      Number(skillMatchesSearch(right)) - Number(skillMatchesSearch(left)),
  ),
);
const qualifications = $derived(
  (detail?.qualifications_text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
);
const visibleSkills = $derived(allSkills.slice(0, 8));
const extraSkills = $derived(allSkills.slice(8));
const hasSearchSkill = $derived(allSkills.some(skillMatchesSearch));
const transform = $derived(
  triageDragTransform(drag ?? { dx: 0, dy: 0 }, {
    maxTilt: mouseDrag ? 0 : TRIAGE_SWIPE_MAX_TILT_DEG,
    reducedMotion,
    threshold: TRIAGE_SWIPE_THRESHOLD_PX,
  }),
);
const progress = $derived(
  drag ? triageSwipeProgress(drag, TRIAGE_SWIPE_THRESHOLD_PX) : 0,
);
const cardStyle = $derived(
  drag
    ? `transform: translate3d(${transform.translate}px, 0, 0) rotate(${transform.rotate}deg);`
    : '',
);

function skillMatchesSearch(skill: { slug: string; label: string }) {
  return (
    selected.has(canonicalSkillSlug(skill.slug)) ||
    selected.has(canonicalSkillSlug(skill.label))
  );
}

function isDraggableOrigin(target: EventTarget | null) {
  const element = target as Element | null;
  if (!element || typeof element.closest !== 'function') return false;
  return !element.closest(
    'a, button, input, select, textarea, summary, [contenteditable], [role=button]',
  );
}

function startsOnText(event: PointerEvent) {
  const element = event.target as Element;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) {
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      )
        return true;
    }
  }
  return false;
}

function startDrag(event: PointerEvent) {
  if (busy || event.button !== 0 || !event.isPrimary) return;
  if (!isDraggableOrigin(event.target)) return;
  mouseDrag = event.pointerType === 'mouse';
  // Let native text selection own mouse drags that begin on copy. A drag that
  // begins in empty space owns the gesture even if it later crosses text.
  if (mouseDrag && startsOnText(event)) return;
  if (mouseDrag) event.preventDefault();
  const deck = event.currentTarget as Element | null;
  try {
    deck?.setPointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture is only a convenience for drags that leave the card.
  }
  pointerId = event.pointerId;
  originX = event.clientX;
  originY = event.clientY;
  flushSync(() => {
    drag = { dx: 0, dy: 0 };
  });
}

function moveDrag(event: PointerEvent) {
  if (pointerId !== event.pointerId || !drag) return;
  if (selectedText()) {
    cancelDrag();
    return;
  }
  flushSync(() => {
    drag = { dx: event.clientX - originX, dy: event.clientY - originY };
  });
}

function selectedText() {
  try {
    const selection = window.getSelection?.();
    return Boolean(selection && !selection.isCollapsed);
  } catch {
    return false;
  }
}

function endDrag(event: PointerEvent) {
  if (pointerId !== event.pointerId) return;
  const released = drag;
  pointerId = null;
  drag = null;
  if (!released) return;
  const verdict = triageReleaseVerdict(released, {
    selectedText: selectedText(),
    threshold: TRIAGE_SWIPE_THRESHOLD_PX,
  });
  if (verdict === 'reject') onAction('passed');
  if (verdict === 'digDeeper') onAction('saved');
}

function cancelDrag() {
  pointerId = null;
  drag = null;
}

$effect(() => {
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (!query) return;
  reducedMotion = query.matches;
  const change = (event: MediaQueryListEvent) =>
    (reducedMotion = event.matches);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
});
</script>

<!-- The opportunity-card class keeps the public search smoke contract stable. -->
<article
  class="opportunity-card triage-card"
  tabindex="-1"
  aria-label={`Review ${opportunity.title}`}
  class:dragging={drag !== null}
  style={cardStyle}
  onpointerdown={startDrag}
  onpointermove={moveDrag}
  onpointerup={endDrag}
  onpointercancel={cancelDrag}
  onlostpointercapture={cancelDrag}
>
  <span class="swipe-hint pass" aria-hidden="true" style={`opacity: ${Math.max(0, -progress)};`}>Pass</span>
  <span class="swipe-hint save" aria-hidden="true" style={`opacity: ${Math.max(0, progress)};`}>Save</span>
  <div class="card-body">
    <div class="card-grid">
    <section class="description" aria-label="Job description">
      <header>
        <p class="company"><Building2 size={15} strokeWidth={2.2} />{#if opportunity.company}<a href={`/companies/${encodeURIComponent(opportunity.company.slug)}`}>{opportunity.company.name}</a>{:else}Employer not listed{/if}</p>
        <h2><a href={`/opportunities/${encodeURIComponent(opportunity.id)}`}>{opportunity.title}</a></h2>
        <div class="meta" aria-label="Posting facts">
          {#if location}<span><MapPin size={15} strokeWidth={2.2} />{location}</span>{/if}
          {#if pay}<span><Banknote size={15} strokeWidth={2.2} />{pay}</span>{/if}
          {#if posted}<span><CalendarDays size={15} strokeWidth={2.2} /><time datetime={opportunity.posted_at ?? undefined}>{posted}</time></span>{/if}
        </div>
      </header>
      {#if detailState === 'loading'}
        <p class="detail-status" role="status">Loading the full posting…</p>
      {:else if detailState === 'error'}
        <div class="detail-status error" role="alert"><p>The full posting could not load. You can still make a choice from this summary.</p>{#if onRetry}<button type="button" onclick={onRetry}>Retry details</button>{/if}</div>
      {:else if detail?.description_text}
        <div class="copy"><h3>Description</h3><p>{detail.description_text}</p></div>
      {:else}
        <p class="detail-status">No full description is available for this posting.</p>
      {/if}
    </section>

    <aside class="facts" aria-label="Opportunity details">
      <section>
        <h3>Facts</h3>
        <dl>
          {#if opportunityLabel(opportunity.work_mode)}<div><dt>Work arrangement</dt><dd>{opportunityLabel(opportunity.work_mode)}</dd></div>{/if}
          {#if opportunityLabel(opportunity.employment_type)}<div><dt>Employment</dt><dd>{opportunityLabel(opportunity.employment_type)}</dd></div>{/if}
          {#if opportunityLabel(opportunity.seniority)}<div><dt>Level</dt><dd>{opportunityLabel(opportunity.seniority)}</dd></div>{/if}
          {#if detail?.eligibility.remote !== null && detail?.eligibility.remote !== undefined}<div><dt>Remote</dt><dd>{detail.eligibility.remote ? 'Available' : 'Not remote'}</dd></div>{/if}
        </dl>
      </section>
      {#if allSkills.length}<section><h3>Listed skills</h3>{#if hasSearchSkill}<p class="match-label">Matches your search</p>{/if}<div class="skills">{#each visibleSkills as skill}<a class:matched={skillMatchesSearch(skill)} href={`/skills/${encodeURIComponent(skill.slug)}`}>{skill.label}</a>{/each}</div>{#if extraSkills.length}<details><summary>{extraSkills.length} more skills</summary><div class="skills extra">{#each extraSkills as skill}<a class:matched={skillMatchesSearch(skill)} href={`/skills/${encodeURIComponent(skill.slug)}`}>{skill.label}</a>{/each}</div></details>{/if}</section>{/if}
      {#if qualifications.length}<section aria-label="Qualifications"><h3>Qualifications</h3>{#if qualifications.length > 1}<ul class="qualifications">{#each qualifications as qualification}<li>{qualification.replace(/^[•*–-]\s+/, '')}</li>{/each}</ul>{:else}<p class="plain-text">{qualifications[0]}</p>{/if}</section>{/if}
      {#if detail?.requirements.length}<section><h3>Requirements</h3><ul>{#each detail.requirements as requirement}<li>{requirement.text}</li>{/each}</ul></section>{/if}
      {#if original}<a class="original" href={original.href} target="_blank" rel="noopener noreferrer" onclick={onOriginalOpen}>View original posting <ExternalLink size={14} strokeWidth={2.2} /><span class="sr-only"> (opens in a new tab)</span></a>{/if}
    </aside>
    </div>
  </div>

</article>

<style>
  .triage-card { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; overflow:clip; background:var(--bg); transition:transform .18s ease; touch-action:pan-y; }

  .triage-card.dragging { transition:none; }
  .card-body { position:relative; flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:clamp(1rem, 3vw, 2.5rem); }
  .card-grid { display:grid; grid-template-columns:minmax(0, 1.5fr) minmax(16rem, .8fr); gap:clamp(1.25rem, 4vw, 2.5rem); align-items:start; }
  .description, .facts, .facts section { min-width:0; }
  .description { display:grid; gap:1.2rem; }
  header { display:grid; gap:.65rem; }
  .company, h2, h3, p { margin:0; }
  .company, .meta { display:flex; flex-wrap:wrap; gap:.45rem 1rem; align-items:center; color:var(--ink-3); font-size:.9rem; }
  .company { gap:.4rem; }
  h2 { font-size:clamp(1.45rem, 3vw, 2.25rem); line-height:1.12; }
  h3 { font-size:.82rem; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); }
  .meta span { display:inline-flex; align-items:center; gap:.35rem; }
  .copy { display:grid; gap:.6rem; }
  .copy p, .plain-text { white-space:pre-wrap; line-height:1.65; }
  .facts { display:grid; align-content:start; gap:1rem; padding:1rem; border:1px solid var(--border-strong); border-radius:.85rem; background:color-mix(in srgb, var(--bg) 62%, transparent); }
  .facts section { display:grid; gap:.55rem; }
  dl { display:grid; grid-template-columns:repeat(auto-fit, minmax(7rem, 1fr)); gap:.65rem; margin:0; }
  dt { color:var(--ink-3); font-size:.78rem; } dd { margin:.18rem 0 0; font-weight:600; }
  .skills { display:flex; flex-wrap:wrap; gap:.42rem; }
  .match-label { color:var(--ink-3); font-size:.8rem; font-weight:700; }
  .skills a { padding:.32rem .58rem; border:1px solid var(--border-strong); border-radius:999px; color:var(--ink); font-size:.86rem; }
  .skills a.matched { border-color:var(--accent); background:var(--accent); color:var(--bg); font-weight:700; }
  details { color:var(--ink-3); font-size:.86rem; } summary { cursor:pointer; } .extra { margin-top:.55rem; }
  ul { display:grid; gap:.45rem; margin:0; padding-left:1.1rem; line-height:1.45; }
  .qualifications { gap:1rem; line-height:1.65; padding-left:1.25rem; }
  .qualifications li { padding-left:.25rem; }
  .original { display:inline-flex; align-items:center; gap:.35rem; min-height:44px; font-weight:700; }
  .detail-status { padding:.9rem; border-radius:.65rem; background:var(--tag-bg); color:var(--ink-3); }
  .detail-status.error { display:flex; flex-wrap:wrap; align-items:center; gap:.6rem; color:var(--ink); }
  .detail-status button { min-height:38px; }
  .swipe-hint { position:absolute; z-index:1; top:1rem; padding:.45rem .75rem; border:2px solid currentColor; border-radius:.5rem; font-size:1.1rem; font-weight:900; text-transform:uppercase; pointer-events:none; transition:opacity .1s linear; }
  .swipe-hint.pass { left:1rem; color:var(--ink); transform:rotate(-12deg); } .swipe-hint.save { right:1rem; color:var(--accent); transform:rotate(12deg); }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
  @media (max-width: 44rem) { .card-grid { grid-template-columns:1fr; } .facts { order:2; } }
  @media (prefers-reduced-motion: reduce) { .triage-card, .swipe-hint { transition:none; } }
</style>
