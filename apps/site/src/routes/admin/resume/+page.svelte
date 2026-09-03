<script lang="ts">
import Rocket from '@lucide/svelte/icons/rocket';
import Upload from '@lucide/svelte/icons/upload';
import type { ResumeSource, Skill } from '@willgriffin/iolaus-resume';
import { enhance } from '$app/forms';
import { invalidateAll } from '$app/navigation';

type AdminRecord = Record<string, unknown> & { id?: string };
type ResumePageTab = 'data' | 'pdf' | 'markdown' | 'text';
type ResumeAssetPreview = AdminRecord & {
  markdownBody?: string;
  markdownStatus?: 'available' | 'missing';
  pdfHref?: string;
  textBody?: string;
  textStatus?: 'available' | 'missing';
};
type ActionFeedback = {
  canonicalRefresh?: {
    assetId: string;
    updatedApplications: number;
  };
  error?: string;
  message?: string;
  ok?: boolean;
  warning?: string;
};

let { data, form } = $props<{
  data: {
    activeResumeTab: ResumePageTab;
    assets: ResumeAssetPreview[];
    educationRecords: AdminRecord[];
    experiences: AdminRecord[];
    profiles: AdminRecord[];
    source: ResumeSource;
    tailoringConfigs: AdminRecord[];
  };
  form?: ActionFeedback;
}>();

const activeProfile = $derived(
  data.profiles.find((profile: AdminRecord) => profile.isDefault) ??
    data.profiles.find((profile: AdminRecord) => profile.active) ??
    data.profiles[0],
);
let activeResumeTab = $derived<ResumePageTab>(data.activeResumeTab);
let regeneratingAssetIds = $state<string[]>([]);
let regenerationTransportError = $state('');
const resumeTabs: Array<{ id: ResumePageTab; label: string }> = [
  { id: 'data', label: 'Data (current)' },
  { id: 'pdf', label: 'PDF' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'text', label: 'Text' },
];
const activeResumeTabLabel = $derived(
  resumeTabs.find((tab) => tab.id === activeResumeTab)?.label ?? '',
);

function value(record: AdminRecord | undefined, key: string): string {
  const item = record?.[key];
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean')
    return String(item);
  return JSON.stringify(item);
}

function boolValue(record: AdminRecord | undefined, key: string): boolean {
  const item = record?.[key];
  return item === true || item === 'true';
}

function dateValue(record: AdminRecord | undefined, key: string): string {
  return value(record, key).slice(0, 10);
}

function shortPath(path: string): string {
  return path.length > 54 ? `...${path.slice(-51)}` : path;
}

function assetId(asset: ResumeAssetPreview): string {
  return value(asset, 'id');
}

function artifactStatus(status: string | undefined): string {
  return status === 'available' ? 'available' : 'missing';
}

function pdfPreviewHref(href: string): string {
  if (!href) return '';
  const separator = href.includes('#') ? '&' : '#';
  return `${href}${separator}navpanes=0&pagemode=none`;
}

function tabHref(tab: ResumePageTab): string {
  return tab === 'data' ? '?' : `?tab=${tab}`;
}

function actionUrl(action: string): string {
  return activeResumeTab === 'data'
    ? `?/${action}`
    : `?tab=${activeResumeTab}&/${action}`;
}

function enhanceRegeneration(assetId: string) {
  return () => {
    return async ({
      result,
      update,
    }: {
      result: { data?: ActionFeedback; type: string };
      update: (options?: {
        invalidateAll?: boolean;
        reset?: boolean;
      }) => Promise<void>;
    }) => {
      regeneratingAssetIds = regeneratingAssetIds.filter(
        (id) => id !== assetId,
      );

      if (result.type === 'success') {
        regenerationTransportError = '';
        await update({ reset: false });
      } else if (result.type === 'failure') {
        // A failed generation is recorded as an asset. Reload the list so that
        // history entry is visible alongside SvelteKit's current failure result.
        regenerationTransportError = '';
        await update({ invalidateAll: false, reset: false });
        await invalidateAll();
      } else if (result.type === 'redirect') {
        regenerationTransportError = '';
        await update({ reset: false });
      } else {
        regenerationTransportError =
          'Resume regeneration could not be completed. Check your connection and retry.';
      }
    };
  };
}

function experienceRecord(experienceId: string): AdminRecord | undefined {
  return data.experiences.find(
    (record: AdminRecord) => value(record, 'experienceKey') === experienceId,
  );
}

function educationRecord(title: string): AdminRecord | undefined {
  return data.educationRecords.find(
    (record: AdminRecord) => value(record, 'title') === title,
  );
}
</script>

<section class="resume-admin">
  {#if form?.message || form?.warning || form?.error}
    <div
      class:error={form.error}
      class:warning={form.warning}
      class="action-feedback"
      role="status"
    >
      {#if form.error}
        <strong>{form.error}</strong>
      {:else}
        <strong>{form.warning ?? form.message}</strong>
      {/if}
      {#if form.canonicalRefresh?.assetId}
        <span>
          Canonical asset {form.canonicalRefresh.assetId}; updated
          {form.canonicalRefresh.updatedApplications} application{form.canonicalRefresh.updatedApplications === 1 ? '' : 's'}.
        </span>
      {/if}
    </div>
  {/if}

  {#if regenerationTransportError}
    <div class:error={true} class="action-feedback" role="status">
      <strong>{regenerationTransportError}</strong>
    </div>
  {/if}

  <nav class="resume-tabs" aria-label="Resume admin views">
    {#each resumeTabs as tab}
      <a
        href={tabHref(tab.id)}
        class:active={activeResumeTab === tab.id}
        aria-current={activeResumeTab === tab.id ? 'page' : undefined}
      >
        {tab.label}
      </a>
    {/each}
  </nav>

  {#if activeResumeTab === 'data'}
  <section class="resume-preview" aria-labelledby="profile-heading">
    <header class="resume-head">
      <h1 id="profile-heading">{data.source.profile.name}</h1>
      <p>{data.source.profile.title}</p>
      <div class="contact-row">
        <a href={`mailto:${data.source.profile.email}`}>{data.source.profile.email}</a>
        {#each data.source.profile.links as link}
          <a href={link.href} target="_blank" rel="noreferrer noopener">{link.label}</a>
        {/each}
      </div>
    </header>

    {#if activeProfile}
      <form class="edit-panel" method="POST" action="?/updateProfile">
        <input type="hidden" name="id" value={activeProfile.id} />
        <div class="form-heading">
          <strong>Active profile</strong>
          <a href="/admin/candidate-profiles">Manage profiles</a>
        </div>
        <label>Profile key <input name="profileKey" value={value(activeProfile, 'profileKey')} /></label>
        <label>Name <input name="name" value={value(activeProfile, 'name')} /></label>
        <label>First name <input name="firstName" value={value(activeProfile, 'firstName')} /></label>
        <label>Last name <input name="lastName" value={value(activeProfile, 'lastName')} /></label>
        <label>Title <input name="title" value={value(activeProfile, 'title')} /></label>
        <label>Email <input name="email" value={value(activeProfile, 'email')} /></label>
        <label>Phone (private) <input name="phone" value={value(activeProfile, 'phone')} /></label>
        <label>Location <input name="location" value={value(activeProfile, 'location')} /></label>
        <label>LinkedIn URL <input name="linkedinUrl" value={value(activeProfile, 'linkedinUrl')} /></label>
        <label>GitHub URL <input name="githubUrl" value={value(activeProfile, 'githubUrl')} /></label>
        <label class="wide">Work authorization preference <textarea name="workAuthorization" rows="2">{value(activeProfile, 'workAuthorization')}</textarea></label>
        <label class="wide">Summary <textarea name="summary" rows="4">{value(activeProfile, 'summary')}</textarea></label>
        <label class="check"><input type="checkbox" name="active" checked={boolValue(activeProfile, 'active')} /> Active</label>
        <label class="check"><input type="checkbox" name="isDefault" checked={boolValue(activeProfile, 'isDefault')} /> Default</label>
        <button type="submit">Save profile</button>
      </form>
    {/if}

    {#if data.profiles.length > 1}
      <form class="inline-form" method="POST" action="?/setDefaultProfile">
        <select name="profileId" aria-label="Default profile">
          {#each data.profiles as profile}
            <option value={profile.id} selected={profile.id === activeProfile?.id}>
              {value(profile, 'profileKey')} · {value(profile, 'name')}
            </option>
          {/each}
        </select>
        <button type="submit">Use profile</button>
      </form>
    {/if}

    <section class="section">
      <h3>Summary</h3>
      <p>{data.source.profile.summary}</p>
    </section>

    <section class="section">
      <div class="section-title-row">
        <h3>Technical Skills</h3>
        <a href="/admin/skills">Manage skills</a>
      </div>
      <div class="skills-block">
        {#each data.source.skills.groups as group}
          <div class="skill-row">
            <strong>{group.label}</strong>
            <span>{group.skills.map((skill: Skill) => skill.label).join(', ')}</span>
          </div>
        {/each}
      </div>
      <div class="skill-groups">
        {#each data.source.skills.skillGroups as group}
          <article>
            <strong>{group.label}</strong>
            <p>{group.blurb}</p>
          </article>
        {/each}
      </div>
    </section>

    <section class="section">
      <div class="section-title-row">
        <h3>Experience</h3>
        <a href="/admin/experience">Manage experience</a>
      </div>
      {#each data.source.experience.positions as position}
        {@const record = experienceRecord(position.id)}
        <article class="experience-card">
          <header>
            <div>
              <h4>
                {#if position.url}
                  <a href={position.url} target="_blank" rel="noreferrer noopener">{position.role}</a>
                {:else}
                  {position.role}
                {/if}
                <span>@ {position.company}</span>
              </h4>
              <p>{position.start} - {position.end}</p>
            </div>
            <a href="/admin/experience">Edit joins/details</a>
          </header>
          {#if position.blurb}
            <p>{position.blurb}</p>
          {/if}
          {#if record}
            <form class="edit-panel compact" method="POST" action="?/updateExperience">
              <input type="hidden" name="id" value={record.id} />
              <label>Key <input name="experienceKey" value={value(record, 'experienceKey')} /></label>
              <label>URL <input name="url" value={value(record, 'url')} /></label>
              <label>Start <input name="startDate" type="date" value={dateValue(record, 'startDate')} /></label>
              <label>End <input name="endDate" type="date" value={dateValue(record, 'endDate')} /></label>
              <label>Start precision <select name="startPrecision" value={value(record, 'startPrecision')}>
                <option>day</option><option>month</option><option>year</option>
              </select></label>
              <label>End precision <select name="endPrecision" value={value(record, 'endPrecision')}>
                <option>day</option><option>month</option><option>year</option><option>present</option>
              </select></label>
              <label>Weight <input name="weight" type="number" step="0.01" value={value(record, 'weight')} /></label>
              <label>Sort <input name="sortOrder" type="number" step="0.01" value={value(record, 'sortOrder')} /></label>
              <label class="wide">Summary <textarea name="summary" rows="3">{value(record, 'summary')}</textarea></label>
              <button type="submit">Save experience</button>
            </form>
          {/if}
          {#if position.duties?.length}
            <ul>
              {#each position.duties as duty}
                <li>{duty.title ? `${duty.title}: ` : ''}{duty.body}</li>
              {/each}
            </ul>
          {/if}
          {#if position.projects?.length}
            <div class="projects">
              {#each position.projects as project}
                <section>
                  <h5>
                    {#if project.url}
                      <a href={project.url} target="_blank" rel="noreferrer noopener">{project.name}</a>
                    {:else}
                      {project.name}
                    {/if}
                  </h5>
                  {#if project.summary}<p>{project.summary}</p>{/if}
                  {#each project.achievements as achievement}
                    <p>{achievement.body}</p>
                  {/each}
                </section>
              {/each}
            </div>
          {/if}
          <div class="achievements">
            {#each position.achievements as achievement}
              <article>
                <strong>{achievement.title}</strong>
                {#if achievement.metric}<span>{achievement.metric}</span>{/if}
                <p>{achievement.body}</p>
              </article>
            {/each}
          </div>
        </article>
      {/each}
    </section>

    <section class="section">
      <div class="section-title-row">
        <h3>Education & Certifications</h3>
        <a href="/admin/education">Manage education</a>
      </div>
      {#each data.source.experience.education as item}
        {@const record = educationRecord(item.title)}
        <article class="education-item">
          <strong>{item.title}</strong>
          {#if item.institution}<span>{item.institution}</span>{/if}
          <p>{item.detail}</p>
          {#if record}
            <form class="edit-panel compact" method="POST" action="?/updateEducation">
              <input type="hidden" name="id" value={record.id} />
              <input type="hidden" name="profileKey" value={value(record, 'profileKey') || 'default'} />
              <label>Title <input name="title" value={value(record, 'title')} /></label>
              <label>Institution <input name="institution" value={value(record, 'institution')} /></label>
              <label>Start <input name="startDate" type="date" value={dateValue(record, 'startDate')} /></label>
              <label>End <input name="endDate" type="date" value={dateValue(record, 'endDate')} /></label>
              <label>Sort <input name="sortOrder" type="number" step="0.01" value={value(record, 'sortOrder')} /></label>
              <label class="wide">Detail <textarea name="detail" rows="3">{value(record, 'detail')}</textarea></label>
              <button type="submit">Save education</button>
            </form>
          {/if}
        </article>
      {/each}
    </section>
  </section>
  {:else}
  <section class="artifact-workspace panel" aria-labelledby="artifacts-heading">
    <div class="section-heading">
      <h2 id="artifacts-heading">{activeResumeTabLabel}</h2>
    </div>
    <div class="action-row">
      <form method="POST" action={actionUrl('generate')}>
        <button class="primary-button" type="submit">
          <Rocket size={16} strokeWidth={2.2} />
          <span>Canonical resume</span>
        </button>
      </form>

      <form method="POST" action={actionUrl('generate')} class="variant-form">
        <select name="tailoringId" aria-label="Tailoring config">
          {#each data.tailoringConfigs as config}
            <option value={config.id}>{value(config, 'name') || value(config, 'configSlug')}</option>
          {/each}
        </select>
        <button class="secondary-button" type="submit" disabled={data.tailoringConfigs.length === 0}>
          <Rocket size={16} strokeWidth={2.2} />
          <span>Variant</span>
        </button>
      </form>
    </div>
    <div class="asset-list">
      {#each data.assets as asset}
        {@const id = assetId(asset)}
        <article class="asset-card">
          <header class="asset-head">
            <div>
              <h3>{value(asset, 'title')}</h3>
              <div class="asset-meta">
                <span class:published={boolValue(asset, 'isPublished')} class="status">
                  {boolValue(asset, 'isPublished') ? 'published' : value(asset, 'status')}
                </span>
                {#if value(asset, 'outputSlug')}
                  <span>{value(asset, 'outputSlug')}</span>
                {/if}
                <span>{value(asset, 'generatedAt') || value(asset, 'updated_at')}</span>
              </div>
            </div>
            <div class="asset-actions">
              <form
                method="POST"
                action={actionUrl('regenerate')}
                use:enhance={enhanceRegeneration(id)}
                onsubmit={() => {
                  regeneratingAssetIds = Array.from(
                    new Set([...regeneratingAssetIds, id]),
                  );
                  regenerationTransportError = '';
                }}
              >
                <input type="hidden" name="assetId" value={id} />
                <button
                  class="secondary-button"
                  type="submit"
                  disabled={!id || regeneratingAssetIds.includes(id)}
                >
                  <Rocket size={16} strokeWidth={2.2} />
                  <span>{regeneratingAssetIds.includes(id) ? 'Regenerating…' : 'Regenerate'}</span>
                </button>
              </form>
              <form method="POST" action={actionUrl('publish')}>
                <input type="hidden" name="assetId" value={id} />
                <button class="icon-button" type="submit" disabled={boolValue(asset, 'isPublished') || !value(asset, 'pdfPath')}>
                  <Upload size={16} strokeWidth={2.2} />
                  <span>Publish</span>
                </button>
              </form>
            </div>
          </header>

          <section class="asset-tab-panel">
            {#if activeResumeTab === 'pdf'}
              {#if asset.pdfHref}
                <div class="pdf-preview">
                  <iframe
                    src={pdfPreviewHref(asset.pdfHref)}
                    title={`${value(asset, 'title') || 'Resume asset'} PDF`}
                  ></iframe>
                </div>
                <a class="artifact-link" href={asset.pdfHref} target="_blank" rel="noreferrer noopener">
                  Open PDF
                </a>
              {:else}
                <p class="empty">No PDF path for this asset.</p>
              {/if}
            {:else if activeResumeTab === 'markdown'}
              <div class="artifact-heading">
                <span class="mono">{shortPath(value(asset, 'markdownPath'))}</span>
                <span>{artifactStatus(asset.markdownStatus)}</span>
              </div>
              {#if asset.markdownBody}
                <pre class="artifact-source">{asset.markdownBody}</pre>
              {:else}
                <p class="empty">No markdown artifact found.</p>
              {/if}
            {:else}
              <div class="artifact-heading">
                <span class="mono">{shortPath(value(asset, 'textPath'))}</span>
                <span>{artifactStatus(asset.textStatus)}</span>
              </div>
              {#if asset.textBody}
                <pre class="artifact-source">{asset.textBody}</pre>
              {:else}
                <p class="empty">No text artifact found.</p>
              {/if}
            {/if}
          </section>
        </article>
      {:else}
        <p class="empty">No generated assets.</p>
      {/each}
    </div>
  </section>
  {/if}
</section>

<style>
  .resume-admin {
    display: grid;
    gap: 22px;
  }

  .action-feedback {
    border: 1px solid rgba(62, 92, 64, 0.28);
    border-radius: 8px;
    background: #edf7ef;
    color: #1f4d2a;
    display: grid;
    gap: 4px;
    padding: 12px 14px;
  }

  .action-feedback.warning {
    border-color: rgba(167, 116, 39, 0.36);
    background: #fff8e8;
    color: #77501a;
  }

  .action-feedback.error {
    border-color: rgba(178, 63, 45, 0.34);
    background: #fff0ec;
    color: #8a2f21;
  }

  .section-heading,
  .action-row,
  .variant-form,
  .section-title-row {
    display: flex;
    align-items: end;
    gap: 14px;
  }

  .section-heading,
  .section-title-row {
    justify-content: space-between;
  }

  h1,
  h2,
  h3,
  h4,
  h5,
  p {
    margin: 0;
  }

  .resume-head p,
  .experience-card header p {
    color: var(--smrt-color-on-surface-variant);
  }

  h1 { font: var(--smrt-typography-headline-medium-font); }
  h2, h3 { font: var(--smrt-typography-title-medium-font); }

  .panel,
  .resume-preview {
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
  }

  .resume-preview,
  .panel {
    display: grid;
    gap: 18px;
    padding: 16px;
  }

  .resume-head {
    display: grid;
    gap: 4px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .resume-head h1 {
    font-size: 32px;
    font-family: Georgia, serif;
  }

  .contact-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    font-family: var(--smrt-font-family-mono, monospace);
    font-size: 13px;
  }

  a {
    color: var(--smrt-color-primary);
    font-weight: 800;
    text-decoration: none;
  }

  .section {
    display: grid;
    gap: 12px;
    padding-top: 4px;
  }

  .section > h3,
  .section-title-row {
    padding-bottom: 6px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .skills-block,
  .skill-groups,
  .projects,
  .achievements {
    display: grid;
    gap: 8px;
  }

  .skill-row {
    display: grid;
    grid-template-columns: minmax(140px, 0.25fr) 1fr;
    gap: 12px;
  }

  .skill-groups {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .skill-groups article,
  .experience-card,
  .education-item {
    border-top: 1px dashed var(--smrt-color-outline-variant);
    padding-top: 14px;
  }

  .experience-card,
  .education-item {
    display: grid;
    gap: 12px;
  }

  .experience-card header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 14px;
  }

  .experience-card h4 {
    font: 600 20px/1.25 Georgia, serif;
  }

  .experience-card h4 span {
    color: var(--smrt-color-on-surface-variant);
    font-weight: 400;
  }

  .achievements article,
  .projects section {
    border-left: 3px solid var(--smrt-color-outline-variant);
    padding-left: 10px;
  }

  .achievements span {
    margin-left: 8px;
    color: var(--smrt-color-primary);
    font: 700 12px/1.2 var(--smrt-font-family-mono, monospace);
  }

  .edit-panel {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container-low);
  }

  .edit-panel.compact {
    margin-top: 2px;
  }

  .form-heading,
  .wide {
    grid-column: 1 / -1;
  }

  label {
    display: grid;
    gap: 5px;
    color: var(--smrt-color-on-surface);
    font-weight: 800;
    font-size: 13px;
  }

  label.check {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  input,
  textarea,
  select {
    width: 100%;
    min-height: 36px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    padding: 8px 10px;
  }

  button,
  .primary-button,
  .secondary-button,
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 6px;
    font-weight: 800;
    text-decoration: none;
  }

  button,
  .primary-button {
    border: 1px solid var(--smrt-color-primary);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .secondary-button,
  .icon-button {
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-primary);
  }

  button:disabled,
  select:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .inline-form {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .asset-list {
    display: grid;
    gap: 14px;
  }

  .asset-card {
    display: grid;
    gap: 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container-lowest);
    padding: 14px;
  }

  .asset-head,
  .asset-actions,
  .asset-meta,
  .artifact-heading {
    display: flex;
    gap: 10px;
  }

  .asset-head {
    align-items: start;
    justify-content: space-between;
  }

  .asset-actions,
  .asset-meta,
  .artifact-heading {
    align-items: center;
    flex-wrap: wrap;
  }

  .asset-meta,
  .artifact-heading {
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
  }

  .resume-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .resume-tabs a {
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    margin-bottom: -1px;
    padding: 0 10px;
    border: 0;
    border-bottom: 3px solid transparent;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .resume-tabs a.active {
    border-bottom-color: var(--smrt-color-primary);
    color: var(--smrt-color-on-surface);
  }

  .asset-tab-panel {
    display: grid;
    gap: 10px;
  }

  .pdf-preview {
    min-height: 520px;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
  }

  .pdf-preview iframe {
    display: block;
    width: 100%;
    height: 520px;
    border: 0;
  }

  .artifact-link {
    justify-self: start;
  }

  .artifact-source {
    max-height: 520px;
    overflow: auto;
    margin: 0;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: 12px/1.45 var(--smrt-font-family-mono, monospace);
    padding: 12px;
    white-space: pre-wrap;
  }

  .mono {
    font-family: var(--smrt-font-family-mono, monospace);
    font-size: 12px;
  }

  .status {
    color: var(--smrt-color-on-surface-variant);
    font-weight: 800;
  }

  .status.published {
    color: var(--smrt-color-on-success-container);
  }

  .empty {
    color: var(--smrt-color-on-surface-variant);
    text-align: center;
  }

  @media (max-width: 760px) {
    .skill-row,
    .edit-panel {
      grid-template-columns: 1fr;
    }

    .experience-card header,
    .asset-head,
    .inline-form {
      display: grid;
    }

    .asset-actions {
      align-items: stretch;
      display: grid;
    }
  }
</style>
