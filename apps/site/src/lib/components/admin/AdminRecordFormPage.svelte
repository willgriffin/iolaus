<script lang="ts">
import { Form as SmrtForm } from '@happyvertical/smrt-svelte/forms';
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import Pencil from '@lucide/svelte/icons/pencil';
import Plus from '@lucide/svelte/icons/plus';
import Save from '@lucide/svelte/icons/save';
import ResourceFormFields from './ResourceFormFields.svelte';

type AdminRecord = Record<string, unknown> & { id?: string };
type ResourceField = import('$lib/admin/resources').ResourceField;
type RelatedAdminRecordLink = {
  achievements: RelatedProjectBulletLink[];
  href: string;
  id: string;
  label: string;
  record: AdminRecord;
  summary: string;
};
type RelatedProjectBulletLink = {
  body: string;
  href: string;
  id: string;
  label: string;
  metric: string;
  record: AdminRecord;
};
type RelatedProjectEditorData = {
  comboOptions: Record<string, Array<{ label: string; value: string }>>;
  createRecord: AdminRecord;
  referenceOptions: import('$lib/admin/resources').ReferenceOptionsByField;
  resource: import('$lib/admin/resources').AdminResource;
};

let { data, mode } = $props<{
  data: {
    comboOptions: Record<string, Array<{ label: string; value: string }>>;
    referenceOptions: import('$lib/admin/resources').ReferenceOptionsByField;
    record?: AdminRecord;
    relatedProjectBulletEditor?: RelatedProjectEditorData | null;
    relatedProjectEditor?: RelatedProjectEditorData | null;
    relatedProjects?: RelatedAdminRecordLink[];
    resource: import('$lib/admin/resources').AdminResource;
    returnTo?: string;
  };
  mode: 'create' | 'edit';
}>();

let editingProjectId = $state('');
let editingProjectBulletId = $state('');
let creatingProjectBulletForProjectId = $state('');
let showCreateProject = $state(false);

const isEdit = $derived(mode === 'edit');
const title = $derived(
  isEdit
    ? `Edit ${data.resource.singularLabel}`
    : `New ${data.resource.singularLabel}`,
);
const listHref = $derived(`/admin/${data.resource.slug}`);
const viewHref = $derived(
  isEdit && data.record?.id
    ? `/admin/${data.resource.slug}/${data.record.id}`
    : listHref,
);
const currentEditHref = $derived(
  isEdit && data.record?.id
    ? `/admin/${data.resource.slug}/${encodeURIComponent(String(data.record.id))}/edit`
    : '',
);
const returnHref = $derived(data.returnTo ?? '');
const backHref = $derived(returnHref || viewHref);
const backLabel = $derived(
  returnHref ? 'Return' : isEdit ? 'View record' : data.resource.label,
);
const experienceId = $derived(String(data.record?.id ?? ''));
const relatedProjectBulletEditor = $derived(
  data.relatedProjectBulletEditor ?? null,
);
const relatedProjectBulletFields = $derived(
  relatedProjectBulletEditor?.resource.fields.filter(
    (field: ResourceField) =>
      field.key !== 'experienceId' &&
      field.key !== 'projectId' &&
      field.key !== 'title',
  ) ?? [],
);
const relatedProjectEditor = $derived(data.relatedProjectEditor ?? null);
const relatedProjectFields = $derived(
  relatedProjectEditor?.resource.fields.filter(
    (field: ResourceField) => field.key !== 'experienceId',
  ) ?? [],
);
const relatedProjects = $derived(data.relatedProjects ?? []);
const showRelatedProjects = $derived(
  isEdit && data.resource.slug === 'experience',
);

function toggleCreateProjectForm(): void {
  showCreateProject = !showCreateProject;
  editingProjectId = '';
  closeInlineProjectBulletForms();
}

function toggleProjectEditor(projectId: string): void {
  editingProjectId = editingProjectId === projectId ? '' : projectId;
  showCreateProject = false;
}

function closeInlineProjectForms(): void {
  editingProjectId = '';
  showCreateProject = false;
}

function toggleCreateProjectBulletForm(projectId: string): void {
  creatingProjectBulletForProjectId =
    creatingProjectBulletForProjectId === projectId ? '' : projectId;
  editingProjectBulletId = '';
}

function toggleProjectBulletEditor(bulletId: string): void {
  editingProjectBulletId = editingProjectBulletId === bulletId ? '' : bulletId;
  creatingProjectBulletForProjectId = '';
}

function closeInlineProjectBulletForms(): void {
  creatingProjectBulletForProjectId = '';
  editingProjectBulletId = '';
}

function projectBulletCreateRecord(
  project: RelatedAdminRecordLink,
): AdminRecord {
  return {
    ...(relatedProjectBulletEditor?.createRecord ?? {}),
    experienceId,
    projectId: project.id,
    sortOrder: project.achievements.length,
  };
}
</script>

<section class="record-form-page">
  <header class="record-page-header">
    <div>
      <a class="back-link" href={backHref}>
        <ArrowLeft size={15} strokeWidth={2.2} />
        <span>{backLabel}</span>
      </a>
      <h1>{title}</h1>
      <p>{data.resource.description}</p>
    </div>
  </header>

  <SmrtForm method="POST" action={isEdit ? '?/update' : '?/create'}>
    {#if isEdit && data.record?.id}
      <input type="hidden" name="id" value={data.record.id} />
    {/if}
    {#if returnHref}
      <input type="hidden" name="returnTo" value={returnHref} />
    {/if}
    <ResourceFormFields
      comboOptions={data.comboOptions}
      fields={data.resource.fields}
      referenceOptions={data.referenceOptions}
      record={data.record ?? {}}
    />
    <div class="form-actions">
      <button class="primary-action" type="submit">
        <Save size={16} strokeWidth={2.2} />
        <span>{isEdit ? 'Save' : 'Create'}</span>
      </button>
      <a class="secondary-action" href={backHref}>Cancel</a>
    </div>
  </SmrtForm>

  {#if showRelatedProjects}
    <section class="related-records" aria-labelledby="related-projects-title">
      <div class="related-records-header">
        <div>
          <h2 id="related-projects-title">Associated projects</h2>
          <p>{relatedProjects.length} linked to this experience item.</p>
        </div>
        {#if relatedProjectEditor}
          <button
            class="add-project-action"
            type="button"
            aria-expanded={showCreateProject}
            onclick={toggleCreateProjectForm}
          >
            <Plus size={16} strokeWidth={2.2} />
            <span>Add</span>
          </button>
        {/if}
      </div>
      {#if showCreateProject && relatedProjectEditor}
        <div class="inline-project-panel">
          <div class="inline-project-header">
            <h3>New project</h3>
            <button
              class="secondary-button"
              type="button"
              onclick={closeInlineProjectForms}
            >
              Cancel
            </button>
          </div>
          <div class="inline-project-form">
            <SmrtForm method="POST" action="?/createRelatedProject">
              <input type="hidden" name="experienceId" value={experienceId} />
              <ResourceFormFields
                comboOptions={relatedProjectEditor.comboOptions}
                fields={relatedProjectFields}
                referenceOptions={relatedProjectEditor.referenceOptions}
                record={relatedProjectEditor.createRecord}
              />
              <div class="inline-project-actions">
                <button class="primary-action" type="submit">
                  <Save size={16} strokeWidth={2.2} />
                  <span>Create project</span>
                </button>
              </div>
            </SmrtForm>
          </div>
        </div>
      {/if}
      {#if relatedProjects.length > 0}
        <ul class="related-project-list">
          {#each relatedProjects as project (project.id)}
            <li
              class="related-project-item"
              class:editing={editingProjectId === project.id}
            >
              {#if editingProjectId === project.id && relatedProjectEditor}
                <div class="inline-project-header">
                  <h3>Edit {project.label}</h3>
                  <button
                    class="secondary-button"
                    type="button"
                    onclick={closeInlineProjectForms}
                  >
                    Close
                  </button>
                </div>
                <div class="inline-project-form">
                  <SmrtForm method="POST" action="?/updateRelatedProject">
                    <input type="hidden" name="id" value={project.id} />
                    <input type="hidden" name="experienceId" value={experienceId} />
                    <ResourceFormFields
                      comboOptions={relatedProjectEditor.comboOptions}
                      fields={relatedProjectFields}
                      referenceOptions={relatedProjectEditor.referenceOptions}
                      record={project.record}
                    />
                    <div class="inline-project-actions">
                      <button class="primary-action" type="submit">
                        <Save size={16} strokeWidth={2.2} />
                        <span>Save project</span>
                      </button>
                    </div>
                  </SmrtForm>
                </div>
              {:else}
                <div class="related-record-summary">
                  <div>
                    <strong class="project-title">{project.label}</strong>
                    {#if project.summary}
                      <p>{project.summary}</p>
                    {/if}
                  </div>
                  {#if relatedProjectEditor}
                    <button
                      class="edit-project-action"
                      type="button"
                      aria-expanded={editingProjectId === project.id}
                      onclick={() => toggleProjectEditor(project.id)}
                    >
                      <Pencil size={15} strokeWidth={2.2} />
                      <span>Edit</span>
                    </button>
                  {/if}
                </div>
              {/if}

              {#if relatedProjectBulletEditor}
                <div class="project-bullets">
                  <div class="project-bullets-header">
                    <div>
                      <h4>Project bullets</h4>
                      <p>{project.achievements.length} on this project.</p>
                    </div>
                    <button
                      class="add-bullet-action"
                      type="button"
                      aria-expanded={creatingProjectBulletForProjectId === project.id}
                      onclick={() => toggleCreateProjectBulletForm(project.id)}
                    >
                      <Plus size={15} strokeWidth={2.2} />
                      <span>Add bullet</span>
                    </button>
                  </div>

                  {#if creatingProjectBulletForProjectId === project.id}
                    <div class="inline-bullet-panel">
                      <div class="inline-project-header">
                        <h5>New bullet</h5>
                        <button
                          class="secondary-button"
                          type="button"
                          onclick={closeInlineProjectBulletForms}
                        >
                          Cancel
                        </button>
                      </div>
                      <div class="inline-project-form">
                        <SmrtForm method="POST" action="?/createRelatedProjectBullet">
                          <input type="hidden" name="experienceId" value={experienceId} />
                          <input type="hidden" name="projectId" value={project.id} />
                          <ResourceFormFields
                            comboOptions={relatedProjectBulletEditor.comboOptions}
                            fields={relatedProjectBulletFields}
                            referenceOptions={relatedProjectBulletEditor.referenceOptions}
                            record={projectBulletCreateRecord(project)}
                          />
                          <div class="inline-project-actions">
                            <button class="primary-action" type="submit">
                              <Save size={16} strokeWidth={2.2} />
                              <span>Create bullet</span>
                            </button>
                          </div>
                        </SmrtForm>
                      </div>
                    </div>
                  {/if}

                  {#if project.achievements.length > 0}
                    <ul class="project-bullet-list">
                      {#each project.achievements as bullet (bullet.id)}
                        <li
                          class="project-bullet-item"
                          class:editing={editingProjectBulletId === bullet.id}
                        >
                          {#if editingProjectBulletId === bullet.id}
                            <div class="inline-project-header">
                              <h5>Edit {bullet.label}</h5>
                              <button
                                class="secondary-button"
                                type="button"
                                onclick={closeInlineProjectBulletForms}
                              >
                                Close
                              </button>
                            </div>
                            <div class="inline-project-form">
                              <SmrtForm method="POST" action="?/updateRelatedProjectBullet">
                                <input type="hidden" name="id" value={bullet.id} />
                                <input type="hidden" name="experienceId" value={experienceId} />
                                <input type="hidden" name="projectId" value={project.id} />
                                <ResourceFormFields
                                  comboOptions={relatedProjectBulletEditor.comboOptions}
                                  fields={relatedProjectBulletFields}
                                  referenceOptions={relatedProjectBulletEditor.referenceOptions}
                                  record={bullet.record}
                                />
                                <div class="inline-project-actions">
                                  <button class="primary-action" type="submit">
                                    <Save size={16} strokeWidth={2.2} />
                                    <span>Save bullet</span>
                                  </button>
                                </div>
                              </SmrtForm>
                            </div>
                          {:else}
                            <div class="project-bullet-summary">
                              <div>
                                {#if bullet.body}
                                  <p>{bullet.body}</p>
                                {:else}
                                  <p>{bullet.label}</p>
                                {/if}
                                {#if bullet.metric}
                                  <span>{bullet.metric}</span>
                                {/if}
                              </div>
                              <button
                                class="edit-bullet-action"
                                type="button"
                                aria-expanded={editingProjectBulletId === bullet.id}
                                onclick={() => toggleProjectBulletEditor(bullet.id)}
                              >
                                <Pencil size={15} strokeWidth={2.2} />
                                <span>Edit</span>
                              </button>
                            </div>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="empty-project-bullets">No bullets yet.</p>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty-related-records">No projects are linked yet.</p>
      {/if}
    </section>
  {/if}
</section>

<style>
  .record-form-page {
    display: grid;
    gap: 20px;
    color: var(--smrt-color-on-surface);
  }

  .record-page-header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }

  .record-page-header h1 {
    margin: 8px 0 4px;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-medium-font);
  }

  .record-page-header p {
    max-width: 760px;
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.45;
  }

  .back-link,
  .secondary-action {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--smrt-color-primary);
    font-weight: 800;
    text-decoration: none;
  }

  .back-link:hover,
  .back-link:focus-visible,
  .secondary-action:hover,
  .secondary-action:focus-visible {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  :global(.record-form-page form) {
    display: grid;
    gap: 18px;
    max-width: 980px;
  }

  .form-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .primary-action {
    display: inline-flex;
    min-height: 38px;
    align-items: center;
    gap: 8px;
    justify-self: start;
    padding: 0 13px;
    border: 1px solid var(--smrt-color-primary);
    border-radius: 6px;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-weight: 800;
  }

  .related-records {
    display: grid;
    max-width: 980px;
    gap: 14px;
    padding-top: 8px;
  }

  .related-records-header,
  .related-record-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .related-records h2 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-large-font);
  }

  .inline-project-panel h3,
  .inline-bullet-panel h5 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .project-bullets h4,
  .project-bullet-item h5 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-small-font);
  }

  .related-records p {
    margin: 4px 0 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.45;
  }

  .related-project-list,
  .project-bullet-list {
    display: grid;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .related-project-list {
    gap: 10px;
  }

  .project-bullet-list {
    gap: 8px;
  }

  .related-project-item {
    display: grid;
    min-height: 64px;
    gap: 14px;
    padding: 12px 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-low);
  }

  .related-project-item.editing,
  .inline-project-panel {
    border: 1px solid var(--smrt-color-primary);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-lowest);
  }

  .related-project-item.editing {
    padding: 14px;
  }

  .inline-project-panel {
    padding: 14px;
  }

  .inline-project-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .inline-project-form :global(form) {
    max-width: none;
  }

  .project-title {
    color: var(--smrt-color-on-surface);
    font-weight: 850;
  }

  .project-bullets {
    display: grid;
    gap: 10px;
    padding-top: 2px;
  }

  .project-bullets-header,
  .project-bullet-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .project-bullet-item,
  .inline-bullet-panel {
    display: grid;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-lowest);
  }

  .project-bullet-item.editing,
  .inline-bullet-panel {
    border-color: var(--smrt-color-primary);
  }

  .project-bullet-summary p {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 14px;
    line-height: 1.45;
  }

  .project-bullet-summary span {
    display: inline-block;
    margin-top: 6px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 800;
  }

  .add-project-action,
  .add-bullet-action,
  .edit-bullet-action,
  .edit-project-action,
  .secondary-button {
    display: inline-flex;
    min-height: 34px;
    flex: 0 0 auto;
    align-items: center;
    gap: 7px;
    padding: 0 11px;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-lowest);
    color: var(--smrt-color-primary);
    cursor: pointer;
    font-weight: 800;
    text-decoration: none;
  }

  .add-project-action {
    min-height: 38px;
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .add-bullet-action {
    min-height: 32px;
  }

  .inline-project-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .add-project-action:hover,
  .add-project-action:focus-visible,
  .add-bullet-action:hover,
  .add-bullet-action:focus-visible,
  .edit-bullet-action:hover,
  .edit-bullet-action:focus-visible,
  .edit-project-action:hover,
  .edit-project-action:focus-visible,
  .secondary-button:hover,
  .secondary-button:focus-visible {
    border-color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  .empty-related-records {
    padding: 12px 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-low);
  }

  .empty-project-bullets {
    padding: 10px 12px;
    border: 1px dashed var(--smrt-color-outline-variant);
    border-radius: 6px;
  }

  @media (max-width: 680px) {
    .related-records-header,
    .related-record-summary,
    .project-bullets-header,
    .project-bullet-summary,
    .inline-project-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .add-project-action,
    .add-bullet-action,
    .edit-bullet-action,
    .edit-project-action {
      justify-content: center;
    }
  }
</style>
