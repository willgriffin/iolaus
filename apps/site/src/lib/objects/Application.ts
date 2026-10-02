import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AutoSubmitApplicationJobArgs } from '../server/auto-submit-application-job.js';

@smrt({
  tableName: 'applications',
  // Applications include personal answers and approval records. They travel
  // only through owner-scoped workflows, never generic generated resources.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class Application extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  evaluationScoreId = '';
  @field({ type: 'text' })
  decisionId = '';
  @field({ type: 'text' })
  status = 'draft';
  @field({ type: 'text' })
  applyMethod = 'company_site';
  @field({ type: 'text' })
  resumeMode = 'default';
  @field({ type: 'text' })
  coverLetterMode = 'none';
  @field({ type: 'text' })
  applicationInstructions = '';
  @field({ type: 'text' })
  requiredAnswers = '';
  // Persisted ATS form schema (JSON-encoded AtsFormSchema) fetched during
  // packet generation, so missing required answers surface during review.
  @field({ type: 'text' })
  requiredQuestionsJson = '{}';
  // Structured answers keyed by ATS question id (JSON object). The free-text
  // `requiredAnswers` above remains the human-facing summary.
  @field({ type: 'text' })
  requiredAnswersJson = '{}';
  @field({ type: 'datetime', nullable: true })
  dueAt: Date | null = null;
  @field({ type: 'text' })
  approvedByUserId = '';
  @field({ type: 'text' })
  approvedByProfileId = '';
  @field({ type: 'datetime', nullable: true })
  approvedAt: Date | null = null;
  @field({ type: 'text' })
  approvalNotes = '';
  @field({ type: 'text' })
  approvalScope = '';
  // Final submission approval is deliberately modeled separately from the
  // human-readable approval notes/scope. External submission paths must check
  // this exact marker, never infer authority from text entered during review.
  @field({ type: 'text' })
  finalApprovalKind = '';
  @field({ type: 'datetime', nullable: true })
  finalApprovalAt: Date | null = null;
  @field({ type: 'text' })
  finalApprovedByUserId = '';
  // Canonical fingerprint list for the exact packet, resume, cover letter,
  // and answer artifacts present at final approval. Auto-submit fails closed
  // if a current artifact no longer matches this snapshot.
  @field({ type: 'text' })
  finalApprovalMaterialsJson = '[]';
  @field({ type: 'datetime', nullable: true })
  submittedAt: Date | null = null;
  @field({ type: 'text' })
  submissionMethod = '';
  @field({ type: 'text' })
  submittedByRole = '';
  @field({ type: 'text' })
  submittedByUserId = '';
  @field({ type: 'text' })
  submittedByProfileId = '';
  @field({ type: 'text' })
  submissionEvidenceUrl = '';
  @field({ type: 'text' })
  submissionNotes = '';
  @field({ type: 'text' })
  applicationUrl = '';
  // The canonical ATS apply URL resolved from `applicationUrl` when that points
  // at an aggregator (e.g. an Indeed posting that redirects to a Greenhouse
  // form). Set best-effort during packet generation; empty when no resolution
  // applies. Auto-submit consumers prefer this over the raw URL, so a change
  // invalidates final approval even though it is derived rather than typed.
  @field({ type: 'text' })
  resolvedApplyUrl = '';
  @field({ type: 'text' })
  accountStatus = 'unknown';
  @field({ type: 'text' })
  accountLoginIdentity = '';
  @field({ type: 'text' })
  accountNotes = '';
  @field({ type: 'text' })
  wardenReference = '';
  @field({ type: 'text' })
  resumeAssetId = '';
  @field({ type: 'text' })
  resumeVariantId = '';
  @field({ type: 'text' })
  coverLetterAssetId = '';
  @field({ type: 'text' })
  packetAssetId = '';
  // System-owned lease used only while a selected resume variant is changing.
  // Generic APIs must never set or clear it; approval and material writers fail
  // closed until the variant write releases the lease.
  @field({ type: 'text' })
  materialWriteLock = '';
  @field({ type: 'text' })
  notes = '';

  async autoSubmit(
    args: AutoSubmitApplicationJobArgs = {},
    context?: JobExecutionContext,
  ) {
    const {
      assertJobTenantMatchesRuntimeWorkspaceSubject,
      getJobPrivateResource,
      requireActiveRunnerExecutionContext,
      runAsResolvedJobWorkspaceSubject,
    } = await import('../server/job-workspace-subject.js');
    const runnerContext = requireActiveRunnerExecutionContext(context);
    return await runAsResolvedJobWorkspaceSubject(
      args,
      async (subject, run) => {
        assertJobTenantMatchesRuntimeWorkspaceSubject(
          runnerContext.job,
          subject,
        );
        const { workspaceWorkflowOperation } = await import(
          '../server/workspace-workflow-capabilities.js'
        );
        const operation = workspaceWorkflowOperation(
          'application-auto-submit.execute',
        );
        await run.assertOperation(operation.collection, operation.action);
        const application = await getJobPrivateResource(
          'Application',
          String(this.id ?? ''),
          subject,
        );
        const { runAutoSubmitApplicationJob } = await import(
          '../server/auto-submit-application-job.js'
        );
        return await runAutoSubmitApplicationJob(
          application,
          args,
          runnerContext,
        );
      },
    );
  }
}
