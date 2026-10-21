<script lang="ts">
import { untrack } from 'svelte';
import { replaceState } from '$app/navigation';
import type {
  ResumeImportAction,
  ResumeImportApplyEntry,
  ResumeImportEntry,
  ResumeImportView,
} from '$lib/resume-import';
import {
  defaultResumeImportAction,
  editableResumeImportFields,
} from '$lib/resume-import';
import {
  parseResumeImportBulletSections,
  parseResumeImportSkillEvidence,
  type ResumeImportBulletSection,
  type ResumeImportSkillEvidence,
} from '$lib/resume-import-structure';

let { initialImport = null }: { initialImport?: ResumeImportView | null } =
  $props();
let fileInput = $state<HTMLInputElement>();
let selectedFile = $state<File | null>(null);
const initialSnapshot = untrack(() => initialImport);
let resumeImport = $state<ResumeImportView | null>(initialSnapshot);
let busy = $state(false);
let error = $state('');
let pollingError = $state('');
let pollingPaused = $state(false);
const progressLabels: Record<string, string> = {
  queued: 'Waiting for processing to start',
  reading_pdf: 'Reading your PDF',
  reading_scan: 'Reading page layout',
  extracting_details: 'Extracting experience, projects, education and skills',
  matching: 'Preparing your review',
};

const processingImportId = $derived(
  resumeImport?.status === 'processing' && !pollingPaused
    ? resumeImport.id
    : null,
);
$effect(() => {
  const importId = processingImportId;
  if (!importId) return;
  const requestImportId = importId;
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  async function poll() {
    try {
      const value = await readResponse(
        await fetch(
          `/api/admin/resume-import/${encodeURIComponent(requestImportId)}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        ),
      );
      if (stopped) return;
      pollingError = '';
      setImport(value);
    } catch (cause) {
      if (stopped) return;
      if (
        cause instanceof ResumeImportResponseError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status)
      ) {
        stopped = true;
        pollingPaused = true;
        pollingError = '';
        error = cause.message;
        expiredImportRecovery = cause.code === 'expired_import';
        if (expiredImportRecovery) {
          resumeImport = null;
          replaceImportLocation();
        }
      } else {
        pollingError =
          'Connection interrupted. Reconnecting to check progress…';
      }
    } finally {
      if (!stopped) timer = setTimeout(poll, 1500);
    }
  }
  timer = setTimeout(poll, 500);
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  };
});
let requestId = $state('');
let consent = $state(false);
let expiredImportRecovery = $state(false);
let selections = $state<
  Record<
    string,
    {
      action: ResumeImportAction;
      targetId?: string;
      fields: Record<string, string>;
    }
  >
>(
  Object.fromEntries(
    (initialSnapshot?.entries ?? []).map((entry) => [
      entry.id,
      selectionFor(entry),
    ]),
  ),
);
const maxBytes = 10 * 1024 * 1024;
const importIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u;
class ResumeImportResponseError extends Error {
  code?: string;
  status: number;
  constructor(message: string, code?: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function id() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
function replaceImportLocation(importId?: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (importId) url.searchParams.set('id', importId);
  else url.searchParams.delete('id');
  replaceState(`${url.pathname}${url.search}${url.hash}`, {});
}
function setImport(value: ResumeImportView, persist = false) {
  resumeImport = value;
  pollingPaused = false;
  selections = Object.fromEntries(
    value.entries.map((entry) => [entry.id, selectionFor(entry)]),
  );
  if (persist) replaceImportLocation(value.id);
}
function selectionFor(entry: ResumeImportEntry) {
  const action = defaultResumeImportAction(entry);
  return {
    action,
    ...(action === 'merge' && entry.candidateMatches?.length === 1
      ? { targetId: entry.candidateMatches[0].id }
      : {}),
    fields: editableResumeImportFields(entry),
  };
}
function fieldLabel(key: string, kind?: ResumeImportEntry['kind']) {
  return (
    (
      {
        company: 'Company',
        title: kind === 'education' ? 'Degree or qualification' : 'Job title',
        startDate: 'Start date',
        endDate: 'End date',
        summary: 'Summary',
        bullets: 'Bullets',
        institution: 'Institution',
        detail: 'Details',
        name: 'Name',
        url: 'Project URL',
      } as Record<string, string>
    )[key] ?? key
  );
}
function accept(file: File | undefined) {
  error = '';
  if (!file) return;
  if (
    file.type !== 'application/pdf' &&
    !file.name.toLowerCase().endsWith('.pdf')
  ) {
    error = 'Choose a PDF file.';
    return;
  }
  if (file.size > maxBytes) {
    error = 'This PDF exceeds the 10 MiB upload limit.';
    return;
  }
  selectedFile = file;
  requestId = '';
  expiredImportRecovery = false;
}
async function readResponse(response: Response): Promise<ResumeImportView> {
  const payload = await response.json().catch(() => null);
  if (
    !response.ok ||
    !payload ||
    typeof payload.id !== 'string' ||
    !importIdPattern.test(payload.id)
  ) {
    throw new ResumeImportResponseError(
      typeof payload?.error === 'string'
        ? payload.error
        : 'The resume import returned an unexpected response.',
      typeof payload?.code === 'string' ? payload.code : undefined,
      response.status,
    );
  }
  return payload as ResumeImportView;
}
async function upload(newImport = false) {
  if (!selectedFile || !consent || busy) return;
  busy = true;
  error = '';
  requestId ||= id();
  try {
    const form = new FormData();
    form.set('file', selectedFile);
    form.set('requestId', requestId);
    form.set('consent', 'true');
    if (newImport) form.set('newImport', 'true');
    setImport(
      await readResponse(
        await fetch('/api/admin/resume-import', { method: 'POST', body: form }),
      ),
      true,
    );
    expiredImportRecovery = false;
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : 'Unable to upload this resume.';
    expiredImportRecovery =
      cause instanceof ResumeImportResponseError &&
      cause.code === 'expired_import';
  } finally {
    busy = false;
  }
}
function startNewImport() {
  if (!selectedFile || busy) return;
  requestId = id();
  expiredImportRecovery = false;
  void upload(true);
}
async function refresh() {
  if (!resumeImport || busy) return;
  busy = true;
  error = '';
  try {
    setImport(
      await readResponse(
        await fetch(
          `/api/admin/resume-import/${encodeURIComponent(resumeImport.id)}`,
        ),
      ),
      true,
    );
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : 'Unable to refresh this import.';
  } finally {
    busy = false;
  }
}
async function retry() {
  if (!resumeImport || busy) return;
  busy = true;
  error = '';
  try {
    setImport(
      await readResponse(
        await fetch(
          `/api/admin/resume-import/${encodeURIComponent(resumeImport.id)}/retry`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: id(),
            }),
          },
        ),
      ),
      true,
    );
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : 'Unable to retry this import.';
  } finally {
    busy = false;
  }
}
async function apply() {
  if (!resumeImport || busy) return;
  error = '';
  if (!validateBulletSections()) return;
  busy = true;
  const entries: ResumeImportApplyEntry[] = resumeImport.entries.map(
    (entry) => ({ id: entry.id, ...selections[entry.id] }),
  );
  try {
    setImport(
      await readResponse(
        await fetch(
          `/api/admin/resume-import/${encodeURIComponent(resumeImport.id)}/apply`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision: resumeImport.revision, entries }),
          },
        ),
      ),
      true,
    );
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'Unable to apply your selections.';
  } finally {
    busy = false;
  }
}
async function remove() {
  if (!resumeImport || busy) return;
  busy = true;
  error = '';
  try {
    const response = await fetch(
      `/api/admin/resume-import/${encodeURIComponent(resumeImport.id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok)
      throw new Error(
        (await response.json())?.error || 'Unable to remove this upload.',
      );
    resumeImport = null;
    selectedFile = null;
    requestId = '';
    selections = {};
    replaceImportLocation();
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : 'Unable to remove this upload.';
  } finally {
    busy = false;
  }
}
function bulletValues(entry: ResumeImportEntry): string[] {
  const value = selections[entry.id].fields.bullets;
  return value ? value.split('\n') : [];
}
function updateBullet(entry: ResumeImportEntry, index: number, value: string) {
  const bullets = bulletValues(entry);
  bullets[index] = value.replace(/\r?\n/g, ' ') || ' ';
  update(entry, 'bullets', bullets.join('\n'));
}
function addBullet(entry: ResumeImportEntry) {
  const bullets = bulletValues(entry);
  bullets.push(' ');
  update(entry, 'bullets', bullets.join('\n'));
}
function removeBullet(entry: ResumeImportEntry, index: number) {
  update(
    entry,
    'bullets',
    bulletValues(entry)
      .filter((_, i) => i !== index)
      .join('\n'),
  );
}
function isBulletSectionDraft(
  value: unknown,
): value is ResumeImportBulletSection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const section = value as { title?: unknown; bullets?: unknown };
  return (
    typeof section.title === 'string' &&
    Array.isArray(section.bullets) &&
    section.bullets.length <= 100 &&
    section.bullets.every((bullet) => typeof bullet === 'string')
  );
}
function bulletSections(
  entry: ResumeImportEntry,
): ResumeImportBulletSection[] | null {
  const value = selections[entry.id].fields.bulletSections;
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 100) return null;
    const sections: ResumeImportBulletSection[] = [];
    for (const section of parsed) {
      if (!isBulletSectionDraft(section)) return null;
      sections.push({ title: section.title, bullets: [...section.bullets] });
    }
    return sections;
  } catch {
    return null;
  }
}
function updateBulletSections(
  entry: ResumeImportEntry,
  sections: ResumeImportBulletSection[],
) {
  update(entry, 'bulletSections', JSON.stringify(sections));
}
function updateSectionTitle(
  entry: ResumeImportEntry,
  index: number,
  value: string,
) {
  const sections = bulletSections(entry);
  if (!sections) return;
  const section = sections[index];
  if (!section) return;
  section.title = value;
  updateBulletSections(entry, sections);
}
function updateSectionBullet(
  entry: ResumeImportEntry,
  sectionIndex: number,
  bulletIndex: number,
  value: string,
) {
  const sections = bulletSections(entry);
  if (!sections) return;
  const section = sections[sectionIndex];
  if (!section) return;
  section.bullets[bulletIndex] = value.replace(/\r?\n/g, ' ');
  updateBulletSections(entry, sections);
}
function addSectionBullet(entry: ResumeImportEntry, sectionIndex: number) {
  const sections = bulletSections(entry);
  if (!sections) return;
  const section = sections[sectionIndex];
  if (!section) return;
  section.bullets.push('');
  updateBulletSections(entry, sections);
}
function removeSectionBullet(
  entry: ResumeImportEntry,
  sectionIndex: number,
  bulletIndex: number,
) {
  const sections = bulletSections(entry);
  if (!sections) return;
  const section = sections[sectionIndex];
  if (!section) return;
  if (section.bullets.length === 1) {
    sections.splice(sectionIndex, 1);
  } else {
    section.bullets.splice(bulletIndex, 1);
  }
  updateBulletSections(entry, sections);
}
function addBulletSection(entry: ResumeImportEntry) {
  const sections = bulletSections(entry);
  if (!sections) return;
  sections.push({ title: '', bullets: [''] });
  updateBulletSections(entry, sections);
}
function validateBulletSections() {
  for (const entry of resumeImport?.entries ?? []) {
    const value = selections[entry.id].fields.bulletSections;
    if (!value) continue;
    try {
      parseResumeImportBulletSections(value);
    } catch (cause) {
      error = `Review bullet sections before applying: ${cause instanceof Error ? cause.message : 'Invalid structured sections.'}`;
      return false;
    }
  }
  return true;
}
function skillEvidence(
  entry: ResumeImportEntry,
): ResumeImportSkillEvidence[] | null {
  if (entry.kind !== 'skill') return [];
  const value = entry.fields.skillEvidence;
  if (!value) return [];
  try {
    return parseResumeImportSkillEvidence(value);
  } catch {
    return null;
  }
}
function roleForEvidence(evidence: ResumeImportSkillEvidence) {
  const role = resumeImport?.entries.find(
    (entry) =>
      entry.kind === 'experience' && entry.id === evidence.proposalExperienceId,
  );
  if (role?.kind !== 'experience') return 'Linked role unavailable';
  return [role.fields.title, role.fields.company].filter(Boolean).join(' — ');
}
function update(entry: ResumeImportEntry, key: string, value: string) {
  selections[entry.id].fields[key] = value;
  selections = { ...selections };
}
</script>

{#snippet entryCard(entry: ResumeImportEntry)}
        <article class:project-section={entry.kind === 'project'}><h2>{entry.kind === 'project' ? selections[entry.id].fields.name || 'Project' : entry.kind}</h2>{#if entry.uncertain}<p class="warning">This proposal is uncertain and is excluded by default.</p>{/if}
          <label>Action <select bind:value={selections[entry.id].action}><option value="skip">Skip</option>{#if entry.kind !== 'profile'}<option value="create">Create new</option>{/if}<option value="merge" disabled={!entry.candidateMatches?.length}>Merge with existing</option></select></label>
          {#if selections[entry.id].action === 'merge'}<label>Existing record <select bind:value={selections[entry.id].targetId}><option value={undefined}>Choose a record</option>{#each entry.candidateMatches ?? [] as candidate}<option value={candidate.id}>{candidate.label}{candidate.summary ? ` — ${candidate.summary}` : ''}</option>{/each}</select></label>{/if}
          {#if entry.kind === 'project'}
            {@const parent = resumeImport?.entries.find(item => item.id === entry.fields.proposalExperienceId)}
            {#if parent?.kind === 'experience'}<p class="project-parent">Under {parent.fields.company} — {parent.fields.title}. These bullets appear once in a project section under this experience.</p>{#if selections[parent.id].action === 'skip'}<p class="warning">The parent experience is skipped. A new project will be saved without an experience link; an existing project keeps its current link.</p>{/if}{/if}
          {/if}
          {#each Object.entries(selections[entry.id].fields) as [key, value]}{#if key === 'proposalExperienceId' || key === 'skillEvidence'}{:else if key === 'bullets'}
            <fieldset class="achievement-bullets"><legend>{selections[entry.id].fields.bulletSections ? 'Unsectioned bullets' : 'Achievement bullets'}</legend>
              {#each bulletValues(entry) as bullet, index}<div class="bullet-row"><label>Bullet {index + 1}<textarea value={bullet} rows="2" oninput={(event) => updateBullet(entry, index, event.currentTarget.value)}></textarea></label><button type="button" class="quiet" aria-label={`Remove bullet ${index + 1}`} onclick={() => removeBullet(entry, index)}>Remove</button></div>{/each}
              <button type="button" class="quiet" onclick={() => addBullet(entry)}>Add bullet</button>
            </fieldset>
          {:else if key === 'bulletSections'}
            {@const sections = bulletSections(entry)}
            <fieldset class="bullet-sections"><legend>Bullet sections</legend>
              {#if sections === null}<p class="warning">The structured sections could not be read. Refresh this review before applying it.</p>
              {:else}
                {#each sections as section, sectionIndex}<section class="bullet-section"><label>Section title<input value={section.title} oninput={(event) => updateSectionTitle(entry, sectionIndex, event.currentTarget.value)} /></label>
                    {#each section.bullets as bullet, bulletIndex}<div class="bullet-row"><label>Bullet {bulletIndex + 1}<textarea value={bullet} rows="2" oninput={(event) => updateSectionBullet(entry, sectionIndex, bulletIndex, event.currentTarget.value)}></textarea></label><button type="button" class="quiet" aria-label={`Remove ${section.title} bullet ${bulletIndex + 1}`} onclick={() => removeSectionBullet(entry, sectionIndex, bulletIndex)}>Remove</button></div>{/each}
                    <button type="button" class="quiet" onclick={() => addSectionBullet(entry, sectionIndex)}>Add bullet to {section.title}</button>
                  </section>{:else}<p class="upload-hint">No labeled bullet sections were proposed.</p>{/each}
                <button type="button" class="quiet" onclick={() => addBulletSection(entry)}>Add section</button>
              {/if}
            </fieldset>
          {:else}<label>{fieldLabel(key, entry.kind)}{#if key === 'summary' || key === 'bullets' || key === 'detail'}<textarea value={value} rows="3" oninput={(event) => update(entry, key, event.currentTarget.value)}></textarea>{:else}<input value={value} oninput={(event) => update(entry, key, event.currentTarget.value)} />{/if}</label>{/if}{/each}
          {#if entry.kind === 'skill'}
            {@const observations = skillEvidence(entry)}
            <section class="skill-evidence" aria-label="Skill evidence">
              <h3>Evidence from roles</h3>
              {#if observations === null}<p class="warning">The structured skill evidence could not be read. Refresh this review before applying it.</p>
              {:else if observations.length}{#each observations as observation}<article><strong>{roleForEvidence(observation)}</strong><span>{observation.depth.replace('_', ' ')} · Page {observation.page}</span><p>{observation.usage}</p><blockquote>{observation.quote}</blockquote>{#if observation.startDate || observation.endDate}<p>Explicit usage dates: {[observation.startDate, observation.endDate].filter(Boolean).join(' – ')}</p>{/if}</article>{/each}
              {:else}<p class="upload-hint">No role evidence was proposed for this skill.</p>{/if}
            </section>
          {/if}
          {#if entry.evidence?.length}<details><summary>Source evidence</summary>{#each entry.evidence as evidence}<p><strong>Page {evidence.page}</strong> {evidence.text}</p>{/each}</details>{/if}
        {#if entry.kind === 'experience'}
            {#each resumeImport?.entries.filter(item => item.kind === 'project' && item.fields.proposalExperienceId === entry.id) ?? [] as project (project.id)}
              {@render entryCard(project)}
            {/each}
          {/if}
        </article>
{/snippet}

<section class="resume-import" aria-busy={busy}>
  <header><p class="eyebrow">Private resume import</p><h1>Upload a resume PDF</h1><p>Review each proposed change before it is added to your resume. Uploading never publishes your profile.</p></header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !resumeImport}
    <div class="dropzone" role="button" tabindex="0" aria-label="Choose a resume PDF" ondrop={(event) => { event.preventDefault(); accept(event.dataTransfer?.files[0]); }} ondragover={(event) => event.preventDefault()} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput?.click(); } }} onclick={() => fileInput?.click()}>
      <strong>{selectedFile ? selectedFile.name : 'Drop a PDF here or choose a file'}</strong><span>PDF only, up to 10 MiB.</span><input bind:this={fileInput} type="file" accept="application/pdf,.pdf" onchange={(event) => accept(event.currentTarget.files?.[0])} />
    </div>
    <label class="consent"><input type="checkbox" bind:checked={consent} /> Resume text is sent to our configured AI provider to prepare suggestions. Nothing is added until you review and import.</label>
    <button type="button" onclick={() => upload()} disabled={!selectedFile || !consent || busy}>{busy ? 'Uploading PDF…' : 'Upload and review'}</button>
    {#if selectedFile && !consent && !busy}<p class="upload-hint">Check the consent box above to enable upload.</p>{/if}
    {#if expiredImportRecovery}<button type="button" class="secondary" onclick={startNewImport} disabled={busy || !selectedFile || !consent}>Start a new import</button>{/if}
  {:else}
    <div class="status" role="status"><strong>{resumeImport.filename}</strong><span>{resumeImport.status === 'processing' ? (progressLabels[resumeImport.progress ?? 'queued'] ?? 'Processing your resume') : resumeImport.status === 'review' ? 'Review proposed changes.' : resumeImport.status === 'applied' ? 'Selected changes were applied.' : 'This import needs attention.'}</span></div>
    {#if resumeImport.warnings.length}<ul class="warnings">{#each resumeImport.warnings as warning}<li>{warning}</li>{/each}</ul>{/if}
    {#if resumeImport.error}<p class="error" role="alert">{resumeImport.error}</p>{/if}
    {#if resumeImport.status === 'processing'}
      <p class="upload-hint" role="status">{pollingError || 'This can take a few minutes. Progress updates automatically; you can leave and return to this import.'}</p>
    {/if}
    {#if resumeImport.status === 'processing'}<button type="button" onclick={refresh} disabled={busy}>Refresh status</button>{/if}
    {#if resumeImport.status === 'failed'}<button type="button" onclick={retry} disabled={busy}>Retry processing</button>{/if}
    {#if resumeImport.status === 'review'}
      <div class="entries">{#each resumeImport.entries.filter(item => item.kind !== 'project' || !resumeImport?.entries.some(parent => parent.kind === 'experience' && parent.id === item.fields.proposalExperienceId)) as entry (entry.id)}
        {@render entryCard(entry)}{/each}</div>
      <button type="button" onclick={apply} disabled={busy}>{busy ? 'Applying…' : 'Apply selected changes'}</button>
    {/if}
    {#if resumeImport.status === 'applied'}
      <a class="primary-link" href="/admin/career">Back to Resume</a>
      {#if selectedFile}<button type="button" class="secondary" onclick={startNewImport} disabled={busy || !consent}>Start a new import</button>{/if}
    {/if}
    <button type="button" class="quiet" onclick={remove} disabled={busy}>Remove this private upload</button>
  {/if}
</section>

<style>
  .project-section{margin-top:.75rem;border-inline-start:3px solid var(--smrt-color-outline-variant)}
  .achievement-bullets,.bullet-sections{min-width:0;margin:0;padding:0;border:0;display:grid;gap:.75rem}.achievement-bullets legend,.bullet-sections legend{font-weight:600;margin-bottom:.5rem}.bullet-row{display:flex;align-items:end;gap:.5rem}.bullet-row label{flex:1}.bullet-row button{flex:none}.bullet-section,.skill-evidence article{display:grid;gap:.5rem;padding:.75rem;border:1px solid var(--smrt-color-outline-variant);border-radius:.4rem}.skill-evidence{display:grid;gap:.6rem}.skill-evidence h3,.skill-evidence p,.skill-evidence blockquote{margin:0}.skill-evidence span{color:var(--smrt-color-on-surface-variant);font-size:.9rem}.skill-evidence blockquote{border-inline-start:3px solid var(--smrt-color-outline-variant);padding-inline-start:.75rem}
  .resume-import,.entries,.status,article,label{min-width:0;grid-template-columns:minmax(0,1fr)}
  input,textarea,select{min-width:0;max-width:100%;box-sizing:border-box}
  .status,details{overflow-wrap:anywhere}

  .resume-import{max-width:52rem;margin:0 auto;padding:1.5rem;display:grid;gap:1rem;color:var(--smrt-color-on-surface)} header h1{margin:.1rem 0}.eyebrow{margin:0;color:var(--smrt-color-primary);font-weight:650;text-transform:uppercase;font-size:.8rem;letter-spacing:.06em}.dropzone{border:2px dashed var(--smrt-color-outline-variant);border-radius:.65rem;padding:2rem;display:grid;gap:.5rem;text-align:center;cursor:pointer}.dropzone:focus-visible{outline:2px solid var(--smrt-color-primary);outline-offset:3px}.dropzone input{position:absolute;inline-size:1px;block-size:1px;opacity:0}.status,article{border:1px solid var(--smrt-color-outline-variant);border-radius:.55rem;padding:1rem;display:grid;gap:.6rem}.status span{color:var(--smrt-color-on-surface-variant)}.entries{display:grid;gap:1rem}article h2{text-transform:capitalize;margin:0}label{display:grid;gap:.3rem;font-weight:600}input,textarea,select{font:inherit;padding:.5rem;border:1px solid var(--smrt-color-outline-variant);border-radius:.35rem;background:var(--smrt-color-surface);color:inherit}.error{color:var(--smrt-color-error)}.warning,.warnings{color:var(--smrt-color-on-surface-variant)}button,.primary-link{width:max-content;font:inherit;padding:.55rem .85rem;border:1px solid var(--smrt-color-outline-variant);border-radius:.4rem;background:var(--smrt-color-primary);color:var(--smrt-color-on-primary);cursor:pointer;text-decoration:none}.quiet{background:transparent;color:var(--smrt-color-on-surface)}button:disabled{opacity:.65;cursor:not-allowed}.resume-import[aria-busy="true"] button:disabled{cursor:wait}.upload-hint{margin:0;color:var(--smrt-color-on-surface-variant)}@media(max-width:36rem){.resume-import{padding:1rem}.dropzone{padding:1.25rem}}
</style>
