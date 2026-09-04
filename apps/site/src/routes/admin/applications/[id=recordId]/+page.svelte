<script lang="ts">
import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
import CheckCircle2 from '@lucide/svelte/icons/check-circle-2';
import ExternalLink from '@lucide/svelte/icons/external-link';
import MessageSquareText from '@lucide/svelte/icons/message-square-text';
import Package from '@lucide/svelte/icons/package';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import Save from '@lucide/svelte/icons/save';
import Send from '@lucide/svelte/icons/send';
import { renderSafeMarkdown } from '$lib/markdown-preview';

type RecordLike = Record<string, unknown> & { id?: string };
type ReviewMaterial = {
  body: string;
  href: string;
  label: string;
  materialRecordId: string;
  materialRecordType: string;
  materialType: string;
  materialVersion: string;
  path: string;
  pdfHref: string;
  pdfPath: string;
  reviewStatus: 'not_reviewed' | 'reviewed';
  title: string;
};
type WorkflowOption = { label: string; value: string };
type AnswersEditorQuestion = {
  id: string;
  label: string;
  labelKey: string;
  required: boolean;
  answered: boolean;
  value: string;
  source: 'application' | 'library' | 'profile' | 'missing';
  inLibrary: boolean;
  libraryValue: string;
  savedForReuse: boolean;
};
type AnswersEditorState = {
  ats: string;
  hasSchema: boolean;
  questions: AnswersEditorQuestion[];
  reusableAnswerCount: number;
};
type AutoSubmitReviewSummary = {
  ats: string;
  hasSchema: boolean;
  requiredQuestions: { id: string; label: string; answered: boolean }[];
  missingRequiredAnswers: {
    id: string;
    label: string;
    required: boolean;
    type: string;
  }[];
};

let { data } = $props<{
  data: {
    application: RecordLike;
    answersEditor: AnswersEditorState;
    autoSubmit: AutoSubmitReviewSummary;
    comments: RecordLike[];
    company: RecordLike | null;
    finalApprovalMaterialsCurrent: boolean;
    materials: ReviewMaterial[];
    opportunity: RecordLike | null;
    preflight: {
      requiresOverride: boolean;
    };
    submissionOptions: {
      methods: WorkflowOption[];
      roles: WorkflowOption[];
    };
    submissionTaskId: string;
  };
}>();

let savedReusableAnswers = $derived(
  data.answersEditor.questions.filter(
    (question: AnswersEditorQuestion) => question.inLibrary,
  ),
);

function value(record: RecordLike | null | undefined, key: string): string {
  const raw = record?.[key];
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return JSON.stringify(raw);
}

function dateValue(record: RecordLike, key: string): string {
  const text = value(record, key);
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

function commentsFor(materialType: string): RecordLike[] {
  return data.comments.filter(
    (comment: RecordLike) => value(comment, 'materialType') === materialType,
  );
}

function renderedMaterialBody(material: ReviewMaterial): string {
  return renderSafeMarkdown(material.body);
}

function answerSourceLabel(source: AnswersEditorQuestion['source']): string {
  if (source === 'profile') return 'From saved profile';
  if (source === 'library') return 'Saved reusable answer';
  if (source === 'application') return 'Application answer';
  return 'Missing';
}

function normalizedLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

function stripMaterialTitlePrefix(title: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title
    .replace(new RegExp(`^${escapedLabel}\\s*[-:]\\s*`, 'i'), '')
    .trim();
}

function materialDataTitle(material: ReviewMaterial): string {
  const label = material.label.trim();
  const title = material.title.trim();
  if (!title) return '';

  const dataTitle = stripMaterialTitlePrefix(title, label);
  const normalizedTitle = normalizedLabel(dataTitle);
  const redundantTitles = new Set([
    normalizedLabel(label),
    normalizedLabel(`Application ${label}`),
    normalizedLabel(`${label} asset`),
  ]);
  if (material.materialType === 'answers') {
    redundantTitles.add(normalizedLabel('Application answers'));
  }

  return redundantTitles.has(normalizedTitle) ? '' : dataTitle;
}

function pdfPreviewHref(href: string): string {
  if (!href) return '';
  const separator = href.includes('#') ? '&' : '#';
  return `${href}${separator}navpanes=0&pagemode=none`;
}

function submissionMethodFromApplyMethod(value: string): string {
  if (value === 'platform') return 'job_board';
  return value;
}

let activeMaterialType = $state('');
const resumeMaterial = $derived(
  data.materials.find(
    (material: ReviewMaterial) => material.materialType === 'resume',
  ) ?? null,
);
const applicationStatus = $derived(
  value(data.application, 'status') || 'draft',
);
// Mirrors applicationMaterialsAreLocked: packets stay editable up to the
// moment a submission is recorded.
const canGeneratePacket = $derived(
  [
    'draft',
    'application_drafting',
    'awaiting_user',
    'approved',
    'submitting',
    'manual_submission',
  ].includes(applicationStatus),
);
const canRecordSubmission = $derived(
  ['approved', 'submitting', 'manual_submission'].includes(applicationStatus) &&
    value(data.application, 'finalApprovalKind') === 'final_submission' &&
    Boolean(value(data.application, 'finalApprovedByUserId')) &&
    data.finalApprovalMaterialsCurrent,
);
const defaultSubmissionMethod = $derived.by(() => {
  const mapped = submissionMethodFromApplyMethod(
    value(data.application, 'applyMethod'),
  );
  if (
    data.submissionOptions.methods.some((option: WorkflowOption) => {
      return option.value === mapped;
    })
  ) {
    return mapped;
  }
  return data.submissionOptions.methods[0]?.value ?? 'company_site';
});
const defaultSubmittedByRole = 'owner';
const applicationTitle = $derived(
  value(data.opportunity, 'title') ||
    value(data.company, 'name') ||
    'Review packet',
);

$effect(() => {
  if (
    data.materials.some(
      (material: ReviewMaterial) =>
        material.materialType === activeMaterialType,
    )
  ) {
    return;
  }
  activeMaterialType = data.materials[0]?.materialType ?? '';
});
</script>

<section class="application-review-page is-split">
  <header class="review-header">
    <div>
      <h1>{applicationTitle}</h1>
    </div>
    <div class="header-actions">
      {#if canGeneratePacket && !data.preflight.requiresOverride}
        <form method="POST" action="?/generatePacket">
          <button class="secondary-action" type="submit">
            <Package size={16} strokeWidth={2.2} />
            <span>{value(data.application, 'packetAssetId') ? 'Regenerate packet' : 'Generate packet'}</span>
          </button>
        </form>
      {/if}
      <a class="secondary-action" href={`/admin/applications/${data.application.id}/edit`}>
        <ExternalLink size={16} strokeWidth={2.2} />
        <span>Edit application</span>
      </a>
    </div>
  </header>

  <div class="review-main">
    <nav class="material-tabs" aria-label="Application materials">
      {#each data.materials as material}
        <button
          type="button"
          class:active={activeMaterialType === material.materialType}
          aria-current={activeMaterialType === material.materialType ? 'page' : undefined}
          onclick={() => {
            activeMaterialType = material.materialType;
          }}
        >
          {material.label}
        </button>
      {/each}
    </nav>

    <section class="materials-list" aria-label="Application materials">
      {#each data.materials as material}
        {@const dataTitle = materialDataTitle(material)}
        <article
          class="material-section"
          hidden={activeMaterialType !== material.materialType}
        >
          <header>
            {#if dataTitle || material.path || material.reviewStatus}
              <div class="material-meta">
                {#if dataTitle}
                  <p class="material-data-title">{dataTitle}</p>
                {/if}
                <p
                  class:current-review={material.reviewStatus === 'reviewed'}
                  class:needs-attention={material.availability === 'needs_attention'}
                  class="material-review-status"
                >
                  {material.availability === 'not_required'
                    ? 'Not required'
                    : material.availability === 'needs_attention'
                      ? 'Needs attention'
                      : material.reviewStatus === 'reviewed'
                        ? 'Current version reviewed'
                        : 'Current version not reviewed'}
                </p>
                {#if material.path}
                  <span>{material.path}</span>
                {/if}
              </div>
            {/if}
            <div class="material-links">
              {#if material.pdfHref}
                <a href={material.pdfHref} target="_blank" rel="noreferrer noopener">
                  <ExternalLink size={15} strokeWidth={2.2} />
                  <span>PDF</span>
                </a>
              {/if}
              <a href={material.href}>
                <ExternalLink size={15} strokeWidth={2.2} />
                <span>Record</span>
              </a>
            </div>
          </header>

          {#if material.pdfHref}
            <div class="pdf-preview">
              <iframe
                src={pdfPreviewHref(material.pdfHref)}
                title={`${material.label} PDF`}
              ></iframe>
            </div>
            {#if material.body}
              <details class="material-source">
                <summary>Text source</summary>
                <div class="markdown-preview compact">
                  {@html renderedMaterialBody(material)}
                </div>
                <pre>{material.body}</pre>
              </details>
            {/if}
          {:else if material.materialType === 'answers' && data.answersEditor.hasSchema}
            <form
              method="POST"
              action="?/provideAnswers"
              class="answers-editor"
              aria-label="Application answers editor"
            >
              <p class="answers-editor-hint">
                Fields copied from your saved candidate profile are marked.
                Role-specific questions stay empty until you answer them — never
                invent values. Saving here updates this application only; tick
                “save for reuse” to also keep an answer for future applications.
                Clearing a field and saving removes that answer from this
                application.
              </p>
              <ul class="answers-editor-fields">
                {#each data.answersEditor.questions as question (question.id)}
                  <li
                    class:missing={question.source === 'missing'}
                    class:unrequired={!question.required}
                  >
                    <div class="answers-field-head">
                      <label for={`answers-editor-${question.id}`}>
                        <span class="answer-marker" aria-hidden="true"
                          >{question.answered ? '✓' : '•'}</span
                        >
                        <span class="answer-label"
                          >{question.label || question.id}</span
                        >
                        {#if question.required}
                          <span class="answer-required">Required</span>
                        {/if}
                      </label>
                      <span
                        class={`answer-source is-${question.source}`}
                      >{answerSourceLabel(question.source)}</span>
                    </div>
                    <textarea
                      id={`answers-editor-${question.id}`}
                      name={`answer:${question.id}`}
                      rows={question.value.length > 90 ? 3 : 2}
                      placeholder={question.answered
                        ? ''
                        : 'Enter answer'}
                    >{question.value}</textarea>
                    {#if question.savedForReuse}
                      <p class="answer-reuse-state">
                        A reusable copy of this answer is in your saved
                        library.
                      </p>
                    {:else if question.inLibrary}
                      <p class="answer-reuse-state">
                        Your saved library holds a different reusable answer
                        for this question.
                      </p>
                    {/if}
                    <label class="answer-reuse">
                      <input type="checkbox" name={`reuse:${question.id}`} />
                      <span
                        >{question.inLibrary && !question.savedForReuse
                          ? 'Replace the saved reusable copy with what you save here'
                          : 'Save for reuse on future applications'}</span
                      >
                    </label>
                  </li>
                {/each}
              </ul>
              <div class="answers-editor-actions">
                <button class="primary-button" type="submit">
                  <Save size={16} strokeWidth={2.2} />
                  <span>Save answers</span>
                </button>
              </div>
            </form>
            {#if savedReusableAnswers.length}
              <section class="answers-library" aria-label="Saved reusable answers">
                <h4>Saved reusable answers</h4>
                <p class="answers-editor-hint">
                  Removing a copy stops it from being offered on future
                  applications. This works even after an application has been
                  submitted.
                </p>
                {#each savedReusableAnswers as question (question.id)}
                  <form
                    method="POST"
                    action="?/revokeReusableAnswer"
                    class="answers-library-row"
                  >
                    <input
                      type="hidden"
                      name="labelKey"
                      value={question.labelKey}
                    />
                    <span class="answers-library-label"
                      >{question.label} — {question.libraryValue}</span
                    >
                    <button class="secondary-button" type="submit">
                      Remove
                    </button>
                  </form>
                {/each}
              </section>
            {/if}
            <details class="material-source">
              <summary>Diagnostic: raw ATS schema and answers</summary>
              <pre>{value(data.application, 'requiredQuestionsJson') || 'No ATS schema stored.'}</pre>
              <pre>{value(data.application, 'requiredAnswersJson') || '{}'}</pre>
            </details>
          {:else if material.body}
            <div class="markdown-preview">
              {@html renderedMaterialBody(material)}
            </div>
            <details class="material-source">
              <summary>Source</summary>
              <pre>{material.body}</pre>
            </details>
          {:else}
            <p class="empty-material">{material.notice || 'No generated text is available for this material yet.'}</p>
          {/if}

          <section class="comment-history" aria-label={`${material.label} comments`}>
            <h3>Comments</h3>
            {#each commentsFor(material.materialType) as comment}
              <article>
                {#if value(comment, 'body')}
                  <p>{value(comment, 'body')}</p>
                {/if}
                <span>{value(comment, 'status') || 'open'} · {dateValue(comment, 'updated_at')}</span>
              </article>
            {:else}
              <p>No comments yet.</p>
            {/each}
          </section>

          <label class="material-comment">
            <span>New comment</span>
            <textarea
              name={`comment:${material.materialType}`}
              form="application-review-form"
              rows="3"
              placeholder={`Comment on ${material.label.toLowerCase()}`}
            ></textarea>
          </label>
        </article>
      {/each}
    </section>
  </div>

	  <aside class="review-sidebar" aria-label="Review">
	    <form
	      id="application-review-form"
	      method="POST"
	      action="?/addComments"
	      class="review-decision"
	      aria-label="Review decision"
	    >
	      <h2>Decision</h2>
	      <div class="decision-actions">
	        <button
	          class="primary-button"
	          type="submit"
	          formaction="?/approveFinal"
	          name="finalSubmissionIntent"
	          value="final_submission"
	        >
	          <CheckCircle2 size={16} strokeWidth={2.2} />
	          <span>Approve final submission</span>
	        </button>
	        <input name="materialType" type="hidden" value={activeMaterialType} />
	        <button class="secondary-button" type="submit" formaction="?/reviewMaterial">
	          <CheckCircle2 size={16} strokeWidth={2.2} />
	          <span>Mark material reviewed</span>
	        </button>
	        <button class="secondary-button warning" type="submit" formaction="?/requestTweaks">
	          <RefreshCw size={16} strokeWidth={2.2} />
	          <span>Request tweaks</span>
	        </button>
	        <button class="secondary-button" type="submit" formaction="?/addComments">
	          <Save size={16} strokeWidth={2.2} />
	          <span>Save comments</span>
	        </button>
	      </div>
	      <label>
	        <span>Final approval notes</span>
	        <textarea name="approvalNotes" rows="2" placeholder="Notes to keep with this approval"></textarea>
	      </label>
	      <p class="decision-note">
	        <MessageSquareText size={14} strokeWidth={2.2} />
	        <span>Material review and comments stay scoped to the selected artifact. Only final submission approval authorizes submission.</span>
	      </p>
	    </form>

      {#if canGeneratePacket && data.preflight.requiresOverride}
        <section class="preflight-review" aria-label="Posting check review">
          <h2>Posting needs your confirmation</h2>
          <p>
            We could not confirm that this posting is still open. Check it
            yourself, then explain what you verified before generating the
            packet.
          </p>
          <form method="POST" action="?/generatePacket">
            <label for="preflight-override-reason">
              <span>Reason to override the posting check</span>
              <textarea
                id="preflight-override-reason"
                name="preflightOverrideReason"
                rows="3"
                required
                placeholder="I verified the employer posting is still open."
              ></textarea>
            </label>
            <button class="secondary-button" type="submit">
              <Package size={16} strokeWidth={2.2} />
              <span>{value(data.application, 'packetAssetId') ? 'Regenerate packet' : 'Generate packet'}</span>
            </button>
          </form>
        </section>
      {/if}

	    <div class="review-summary">
	      <dl class="review-facts">
        <div>
          <dt>Status</dt>
          <dd>{value(data.application, 'status') || 'draft'}</dd>
        </div>
        <div>
          <dt>Company</dt>
          <dd>{value(data.company, 'name') || 'Unknown'}</dd>
        </div>
        <div>
          <dt>Apply method</dt>
          <dd>{value(data.application, 'applyMethod') || 'company_site'}</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>{dateValue(data.application, 'dueAt') || 'None'}</dd>
        </div>
        <div>
          <dt>Resume</dt>
          <dd>{resumeMaterial?.title || 'None selected'}</dd>
        </div>
      </dl>

          {#if data.autoSubmit.hasSchema}
        <section class="auto-submit-summary" aria-label="Auto-submit readiness">
          <h3>Auto-submit ({data.autoSubmit.ats})</h3>
          {#if data.autoSubmit.missingRequiredAnswers.length > 0}
            <p class="auto-submit-state is-missing">
              {data.autoSubmit.missingRequiredAnswers.length} required answer(s)
              missing — submission pauses to collect them before sending.
            </p>
          {:else}
            <p class="auto-submit-state is-ready">
              All required answers present.
            </p>
          {/if}
          {#if data.autoSubmit.requiredQuestions.length > 0}
            <div class="auto-submit-actions">
              <button
                class="secondary-button"
                type="button"
                onclick={() => (activeMaterialType = 'answers')}
              >
                <MessageSquareText size={15} strokeWidth={2.2} />
                <span>Open answer editor</span>
              </button>
            </div>
          {/if}
        </section>
      {/if}

      <details class="detail-disclosure">
        <summary>Details</summary>
        <dl class="review-facts">
          {#if value(data.application, 'accountStatus')}
            <div><dt>Account</dt><dd>{value(data.application, 'accountStatus')}</dd></div>
          {/if}
          {#if value(data.application, 'accountLoginIdentity')}
            <div><dt>Login</dt><dd>{value(data.application, 'accountLoginIdentity')}</dd></div>
          {/if}
          {#if value(data.application, 'wardenReference')}
            <div><dt>Warden</dt><dd>{value(data.application, 'wardenReference')}</dd></div>
          {/if}
          {#if value(data.application, 'approvedAt')}
            <div><dt>Approved</dt><dd>{dateValue(data.application, 'approvedAt')}</dd></div>
          {/if}
          {#if value(data.application, 'submittedAt')}
            <div><dt>Submitted</dt><dd>{dateValue(data.application, 'submittedAt')}</dd></div>
          {/if}
          {#if value(data.application, 'submissionEvidenceUrl')}
            <div>
              <dt>Evidence</dt>
              <dd><a href={value(data.application, 'submissionEvidenceUrl')} target="_blank" rel="noreferrer noopener">link</a></dd>
            </div>
          {/if}
          {#if value(data.application, 'packetAssetId')}
            <div><dt>Packet asset</dt><dd class="mono">{value(data.application, 'packetAssetId')}</dd></div>
          {/if}
          {#if value(data.application, 'resumeAssetId')}
            <div><dt>Resume asset</dt><dd class="mono">{value(data.application, 'resumeAssetId')}</dd></div>
          {/if}
          {#if value(data.application, 'coverLetterAssetId')}
            <div><dt>Cover asset</dt><dd class="mono">{value(data.application, 'coverLetterAssetId')}</dd></div>
          {/if}
        </dl>
        <a class="detail-edit-link" href={`/admin/applications/${data.application.id}/edit`}>
          Edit all fields
        </a>
      </details>

	    </div>

  {#if canRecordSubmission}
    <section class="submission-row" aria-label="Submission">
      <form method="POST" action="?/recordSubmission" class="submission-panel">
        <h2>
          <Send size={16} strokeWidth={2.2} />
          <span>Record submission</span>
        </h2>
        <p>
          Submit on the employer portal yourself, then record the outcome here.
          Submission is never sent for you.
        </p>
        {#if value(data.application, 'applicationUrl')}
          <p>
            Authorized destination:
            <a
              href={value(data.application, 'applicationUrl')}
              target="_blank"
              rel="noreferrer noopener"
            >
              {value(data.application, 'applicationUrl')}
            </a>
          </p>
        {/if}
        <input type="hidden" name="taskId" value={data.submissionTaskId} />
        <div class="submission-fields">
          <label>
            <span>Method</span>
            <select name="submissionMethod">
              {#each data.submissionOptions.methods as option}
                <option value={option.value} selected={option.value === defaultSubmissionMethod}>
                  {option.label}
                </option>
              {/each}
            </select>
          </label>
          <label>
            <span>Submitted by</span>
            <select name="submittedByRole">
              {#each data.submissionOptions.roles as option}
                <option value={option.value} selected={option.value === defaultSubmittedByRole}>
                  {option.label}
                </option>
              {/each}
            </select>
          </label>
          <label class="wide">
            <span>Evidence URL (confirmation page, email, screenshot)</span>
            <input
              type="url"
              name="submissionEvidenceUrl"
              required
              placeholder="https://…"
            />
          </label>
          <label class="wide">
            <span>Notes</span>
            <textarea name="submissionNotes" rows="2" placeholder="Anything worth remembering about this submission"></textarea>
          </label>
        </div>
        <button class="primary-button" type="submit">
          <Send size={16} strokeWidth={2.2} />
          <span>Mark submitted</span>
        </button>
      </form>

      <form method="POST" action="?/reportBlocker" class="submission-panel blocker">
        <h2>
          <AlertTriangle size={16} strokeWidth={2.2} />
          <span>Report blocker</span>
        </h2>
        <p>
          Hit a CAPTCHA, 2FA, or credential wall? Record it — the application
          returns to awaiting review instead of bypassing the gate.
        </p>
        <input type="hidden" name="taskId" value={data.submissionTaskId} />
        <div class="submission-fields">
          <label class="wide">
            <span>Blocker reason</span>
            <textarea name="blockerReason" rows="2" required placeholder="What stopped the submission?"></textarea>
          </label>
          <label>
            <span>Blocker type</span>
            <input type="text" name="blockerType" placeholder="captcha, 2fa, credentials…" />
          </label>
          <label>
            <span>Owner</span>
            <input type="text" name="blockerOwnerRole" placeholder="owner" />
          </label>
          <label class="wide">
            <span>Notes</span>
            <textarea name="blockerNotes" rows="2" placeholder="Extra context for whoever picks this up"></textarea>
          </label>
        </div>
        <button class="secondary-button warning" type="submit">
          <AlertTriangle size={16} strokeWidth={2.2} />
          <span>Report blocker</span>
        </button>
      </form>
    </section>
  {/if}

  {#if applicationStatus === 'submitted'}
    <section class="submission-summary" aria-label="Submission record">
      <h2>
        <CheckCircle2 size={16} strokeWidth={2.2} />
        <span>Submitted</span>
      </h2>
      <dl>
        <div>
          <dt>When</dt>
          <dd>{dateValue(data.application, 'submittedAt') || 'Unknown'}</dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>{value(data.application, 'submissionMethod') || 'Unknown'}</dd>
        </div>
        <div>
          <dt>By</dt>
          <dd>{value(data.application, 'submittedByRole') || 'Unknown'}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>
            {#if value(data.application, 'submissionEvidenceUrl')}
              <a href={value(data.application, 'submissionEvidenceUrl')} rel="noreferrer" target="_blank">
                {value(data.application, 'submissionEvidenceUrl')}
              </a>
            {:else}
              None recorded
            {/if}
          </dd>
        </div>
        {#if value(data.application, 'submissionNotes')}
          <div class="wide">
            <dt>Notes</dt>
            <dd>{value(data.application, 'submissionNotes')}</dd>
          </div>
        {/if}
      </dl>
    </section>
  {/if}
  </aside>
</section>

<style>
  .application-review-page {
    display: grid;
    gap: 18px;
    color: var(--smrt-color-on-surface);
  }

  .application-review-page.is-split {
    grid-template-columns: minmax(0, 1fr) clamp(300px, 30vw, 380px);
    column-gap: 22px;
    align-items: start;
  }

  .application-review-page.is-split > .review-header {
    grid-column: 1 / -1;
  }

  .application-review-page.is-split > .review-main {
    grid-column: 1;
    min-width: 0;
  }

  .application-review-page.is-split > .review-sidebar {
    grid-column: 2;
  }

  .review-main {
    display: grid;
    gap: 14px;
    align-content: start;
  }

  .review-sidebar {
    position: sticky;
    top: 16px;
    align-self: start;
    display: grid;
    gap: 14px;
  }

  .review-summary {
    display: grid;
    gap: 14px;
    padding: 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 10px;
    background: var(--smrt-color-surface-container-low);
  }

  .preflight-review {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--smrt-color-warning);
    border-radius: 10px;
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }

  .preflight-review h2,
  .preflight-review p {
    margin: 0;
  }

  .preflight-review h2 {
    font: var(--smrt-typography-title-medium-font);
  }

  .preflight-review p {
    font: var(--smrt-typography-body-small-font);
  }

  .preflight-review form,
  .preflight-review label {
    display: grid;
    gap: 7px;
  }

  .preflight-review textarea {
    width: 100%;
    resize: vertical;
  }

  .review-facts {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .review-facts > div {
    display: grid;
    grid-template-columns: minmax(92px, max-content) minmax(0, 1fr);
    gap: 4px 14px;
    align-items: baseline;
  }

  .review-facts dt {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.4 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .review-facts dd {
    min-width: 0;
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
    overflow-wrap: anywhere;
  }

  .auto-submit-summary {
    margin-top: 8px;
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 8px;
  }

  .auto-submit-summary h3 {
    margin: 0 0 4px;
    font: 800 11px/1.4 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
    color: var(--smrt-color-on-surface-variant);
  }

  .auto-submit-state {
    margin: 0 0 6px;
    font: var(--smrt-typography-body-small-font);
  }

  .auto-submit-state.is-missing {
    color: var(--smrt-color-error);
  }

  .auto-submit-state.is-ready {
    color: var(--smrt-color-on-surface-variant);
  }

  .auto-submit-hint {
    margin: 0 0 8px;
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }

  .answers-editor {
    display: grid;
    gap: 10px;
  }

  .answers-editor-hint {
    margin: 0;
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }

  .answers-editor-fields {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 12px;
  }

  .answers-editor-fields li {
    display: grid;
    gap: 6px;
    font: var(--smrt-typography-body-small-font);
  }

  .answers-editor-fields li.unrequired {
    opacity: 0.85;
  }

  .answers-field-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  .answers-field-head label {
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--smrt-color-error);
  }

  .answers-editor-fields li.unrequired .answers-field-head label {
    color: var(--smrt-color-on-surface);
  }

  .answer-label {
    flex: 1;
  }

  .answer-required {
    font: 700 10px/1.4 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
    color: var(--smrt-color-error);
  }

  .answer-source {
    font: 700 10px/1.4 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    padding: 2px 8px;
    color: var(--smrt-color-on-surface-variant);
    white-space: nowrap;
  }

  .answer-source.is-profile,
  .answer-source.is-library {
    color: var(--smrt-color-primary, #1d76db);
    border-color: currentColor;
  }

  .answer-source.is-missing {
    color: var(--smrt-color-error);
    border-color: currentColor;
  }

  .answers-editor textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 6px 8px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-small-font);
  }

  .answer-reuse-state {
    margin: 0;
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }

  .answer-reuse {
    display: flex;
    align-items: center;
    gap: 6px;
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }

  .answers-editor-actions {
    display: flex;
    justify-content: flex-end;
  }

  .auto-submit-actions {
    margin-top: 8px;
    display: flex;
    justify-content: flex-end;
  }

  .detail-disclosure {
    margin-top: 8px;
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 8px;
  }

  .detail-disclosure summary {
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--smrt-color-on-surface-variant);
  }

  .detail-disclosure .review-facts {
    margin-top: 8px;
  }

  .detail-disclosure .mono {
    font-family: ui-monospace, monospace;
    font-size: 0.74rem;
  }

  .detail-edit-link {
    display: inline-block;
    margin-top: 8px;
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--smrt-color-primary);
    text-decoration: none;
  }

  .review-header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 18px;
  }

  .review-header h1 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-medium-font);
    line-height: 1.05;
  }

  .secondary-action,
  .material-section header a {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--smrt-color-primary);
    font-weight: 800;
    text-decoration: none;
  }

  .secondary-action {
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
  }

  h3 {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .materials-list {
    display: grid;
    gap: 16px;
  }

  .review-decision {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
  }

  .review-decision h2 {
    margin: 0;
    font: var(--smrt-typography-title-medium-font);
  }

  .review-decision label {
    display: grid;
    gap: 5px;
    min-width: 0;
    color: var(--smrt-color-on-surface);
    font-weight: 800;
  }

  .review-decision label span {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .decision-actions {
    display: grid;
    gap: 8px;
  }

  .review-decision .decision-note {
    display: flex;
    gap: 6px;
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    line-height: 1.35;
  }

  .material-tabs button {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .material-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .material-tabs button {
    min-height: 36px;
    margin-bottom: -1px;
    padding: 0 10px;
    border: 0;
    border-bottom: 3px solid transparent;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
  }

  .material-tabs button.active {
    border-bottom-color: var(--smrt-color-primary);
    color: var(--smrt-color-on-surface);
  }

  .material-section {
    display: grid;
    gap: 12px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .material-section[hidden] {
    display: none;
  }

  .material-section header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 12px;
  }

  .material-meta {
    display: grid;
    min-width: 0;
    gap: 4px;
  }

  .material-review-status {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-small-font);
  }

  .material-review-status.current-review {
    color: var(--smrt-color-primary);
  }

  .material-review-status.needs-attention {
    color: var(--smrt-color-error);
  }

  .material-data-title {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
    font-weight: 800;
    overflow-wrap: anywhere;
  }

  .material-section header span {
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
  }

  .material-links {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
  }

  .pdf-preview {
    height: min(78vh, 860px);
    min-height: 620px;
    overflow: hidden;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
  }

  .pdf-preview iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: var(--smrt-color-surface);
  }

  .markdown-preview {
    max-height: 460px;
    margin: 0;
    overflow: auto;
    padding: 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
    line-height: 1.58;
  }

  .markdown-preview :global(*) {
    max-width: 100%;
  }

  .markdown-preview :global(:first-child) {
    margin-top: 0;
  }

  .markdown-preview :global(:last-child) {
    margin-bottom: 0;
  }

  .markdown-preview.compact {
    max-height: 260px;
  }

  .markdown-preview :global(h1),
  .markdown-preview :global(h2),
  .markdown-preview :global(h3),
  .markdown-preview :global(h4),
  .markdown-preview :global(h5),
  .markdown-preview :global(h6) {
    margin: 18px 0 8px;
    color: var(--smrt-color-on-surface);
    font-weight: 800;
    line-height: 1.2;
  }

  .markdown-preview :global(h1) {
    font: var(--smrt-typography-headline-medium-font);
  }

  .markdown-preview :global(h2) {
    font: var(--smrt-typography-title-large-font);
  }

  .markdown-preview :global(h3),
  .markdown-preview :global(h4),
  .markdown-preview :global(h5),
  .markdown-preview :global(h6) {
    font: var(--smrt-typography-title-medium-font);
  }

  .markdown-preview :global(p),
  .markdown-preview :global(ul),
  .markdown-preview :global(ol),
  .markdown-preview :global(blockquote),
  .markdown-preview :global(pre) {
    margin: 0 0 12px;
  }

  .markdown-preview :global(ul),
  .markdown-preview :global(ol) {
    padding-left: 22px;
  }

  .markdown-preview :global(li + li) {
    margin-top: 5px;
  }

  .markdown-preview :global(a) {
    color: var(--smrt-color-primary);
    font-weight: 750;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .markdown-preview :global(code) {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--smrt-color-surface-container-high);
    font-family: var(--smrt-font-family-mono, monospace);
    font-size: 0.92em;
  }

  .markdown-preview :global(pre) {
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-low);
  }

  .markdown-preview :global(pre code) {
    padding: 0;
    background: transparent;
    white-space: pre;
  }

  .markdown-preview :global(blockquote) {
    padding-left: 12px;
    border-left: 3px solid var(--smrt-color-outline-variant);
    color: var(--smrt-color-on-surface-variant);
  }

  .markdown-preview :global(hr) {
    margin: 16px 0;
    border: 0;
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .material-source {
    display: grid;
    gap: 8px;
  }

  .material-source summary {
    cursor: pointer;
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .material-source pre {
    max-height: 320px;
    margin: 0;
    overflow: auto;
    padding: 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: 13px/1.5 var(--smrt-font-family-mono, monospace);
    white-space: pre-wrap;
  }

  .empty-material,
  .comment-history p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.45;
  }

  .comment-history {
    display: grid;
    gap: 8px;
  }

  .comment-history article {
    display: grid;
    gap: 4px;
    padding: 10px;
    border-left: 3px solid var(--smrt-color-primary);
    background: var(--smrt-color-surface);
  }

  .comment-history article span {
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
  }

  .material-comment,
  .review-decision label {
    display: grid;
    gap: 6px;
    color: var(--smrt-color-on-surface);
    font-weight: 800;
  }

  .material-comment span {
    font-size: 12px;
  }

  textarea {
    width: 100%;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    padding: 9px 10px;
    resize: vertical;
  }

  .primary-button,
  .secondary-button {
    display: inline-flex;
    min-height: 38px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 6px;
    font-weight: 800;
  }

  .primary-button {
    border: 1px solid var(--smrt-color-primary);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .secondary-button {
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  .secondary-button.warning {
    border-color: var(--smrt-color-warning);
    color: var(--smrt-color-on-warning-container);
  }

  .header-actions {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 8px;
  }

  .header-actions .secondary-action {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    min-height: 36px;
    padding: 0 12px;
    font: inherit;
    font-weight: 800;
  }

  .submission-row {
    display: grid;
    gap: 14px;
  }

  .submission-panel {
    display: grid;
    gap: 10px;
    align-content: start;
    padding: 14px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
  }

  .submission-panel.blocker {
    border-color: var(--smrt-color-warning);
  }

  .submission-panel h2,
  .submission-summary h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font: var(--smrt-typography-title-medium-font);
  }

  .submission-panel > p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    line-height: 1.4;
  }

  .submission-fields {
    display: grid;
    gap: 10px;
  }

  .submission-fields label {
    display: grid;
    gap: 5px;
    min-width: 0;
    color: var(--smrt-color-on-surface);
    font-weight: 800;
  }

  .submission-fields label.wide {
    grid-column: 1 / -1;
  }

  .submission-fields span {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .submission-fields select,
  .submission-fields input {
    width: 100%;
    min-height: 36px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    padding: 0 10px;
  }

  .submission-panel .primary-button,
  .submission-panel .secondary-button {
    justify-self: start;
    padding: 0 14px;
  }

  .submission-summary {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--smrt-color-success);
    border-radius: 8px;
    background: var(--smrt-color-success-container);
  }

  .submission-summary dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin: 0;
  }

  .submission-summary dl div {
    display: grid;
    gap: 3px;
  }

  .submission-summary dl div.wide {
    grid-column: 1 / -1;
  }

  .submission-summary dt {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .submission-summary dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  @media (max-width: 1024px) {
    .application-review-page.is-split {
      grid-template-columns: 1fr;
    }

    .application-review-page.is-split > .review-main,
    .application-review-page.is-split > .review-sidebar {
      grid-column: 1;
    }

    .review-sidebar {
      position: static;
    }

    .pdf-preview {
      min-height: 520px;
    }
  }
</style>
