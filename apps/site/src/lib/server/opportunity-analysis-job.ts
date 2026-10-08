import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  getActiveJobExecutionContext,
  SmrtJobCollection,
} from '@happyvertical/smrt-jobs';
import { OPPORTUNITY_ANALYSIS_VERSION } from '$lib/opportunity-analysis-contract.js';
import { getDbConfig, getSmrtOptions } from './db.js';
import { ensureOpportunityAnalysis } from './opportunity-analysis.js';
import { OPPORTUNITY_ANALYSIS_QUEUE } from './opportunity-analysis-job-schema.js';
import { claimAnalysisWindowSlot } from './opportunity-analysis-maintenance.js';

export { OPPORTUNITY_ANALYSIS_QUEUE } from './opportunity-analysis-job-schema.js';

const objectType = '@willgriffin/iolaus-site:Opportunity';
const method = 'analyzeSourcePosting';
interface AnalysisJobInput {
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  analysisVersion: typeof OPPORTUNITY_ANALYSIS_VERSION;
  enrich: boolean;
  budgetMicros: number;
}
/** Server-side caller captures source identity. No user/workspace selector is
 * accepted; this queue exclusively processes shared source posting content. */
export async function enqueueOpportunityAnalysis(
  opportunityId: string,
  options: { enrich?: boolean; budgetMicros?: number } = {},
) {
  if (
    options.enrich &&
    (!Number.isSafeInteger(options.budgetMicros) ||
      (options.budgetMicros ?? 0) <= 0)
  )
    throw new Error('Analysis job enrichment requires a budget.');
  const db = await resolveDatabase(getDbConfig());
  const row = (
    await db.query(
      'SELECT source_content_fingerprint, source_content_version FROM opportunities WHERE id = ?',
      [opportunityId],
    )
  ).rows[0];
  if (!row?.source_content_fingerprint)
    throw new Error('Analysis job source is unavailable.');
  const args: AnalysisJobInput = {
    sourceContentFingerprint: String(row.source_content_fingerprint),
    sourceContentVersion: Number(row.source_content_version),
    analysisVersion: OPPORTUNITY_ANALYSIS_VERSION,
    enrich: options.enrich === true,
    budgetMicros: options.budgetMicros ?? 0,
  };
  return (await SmrtJobCollection.create(getSmrtOptions())).enqueueJob({
    objectId: opportunityId,
    objectType,
    method,
    queue: OPPORTUNITY_ANALYSIS_QUEUE,
    tenantId: '',
    maxAttempts: 3,
    timeout: 180_000,
    priority: 20,
    args: { analysis: args },
  });
}
/** Only a native runner invocation can execute this otherwise unexposed method. */
export async function executeOpportunityAnalysisJob(
  opportunityId: string,
  args: Record<string, unknown>,
) {
  const context = getActiveJobExecutionContext();
  if (
    !context ||
    context.job.objectType !== objectType ||
    context.job.method !== method ||
    context.job.queue !== OPPORTUNITY_ANALYSIS_QUEUE ||
    context.job.tenantId
  )
    throw new Error('Analysis requires an active global native job.');
  const persisted = await (
    await SmrtJobCollection.create(getSmrtOptions())
  ).get(context.job.jobId);
  if (
    !persisted ||
    persisted.objectId !== opportunityId ||
    persisted.status !== 'running'
  )
    throw new Error('Analysis job target is not current.');
  if (JSON.stringify(persisted.args) !== JSON.stringify(args))
    throw new Error('Analysis job intent differs from durable arguments.');
  const value = args.analysis as AnalysisJobInput | undefined;
  if (
    !value ||
    value.analysisVersion !== OPPORTUNITY_ANALYSIS_VERSION ||
    typeof value.enrich !== 'boolean' ||
    !Number.isSafeInteger(value.budgetMicros) ||
    value.budgetMicros < 0 ||
    !Number.isSafeInteger(value.sourceContentVersion) ||
    !value.sourceContentFingerprint
  )
    throw new Error('Malformed native analysis intent.');
  const db = await resolveDatabase(getDbConfig());
  const row = (
    await db.query(
      'SELECT source_content_fingerprint, source_content_version FROM opportunities WHERE id = ?',
      [opportunityId],
    )
  ).rows[0];
  if (
    !row ||
    row.source_content_fingerprint !== value.sourceContentFingerprint ||
    Number(row.source_content_version) !== value.sourceContentVersion
  )
    return { status: 'obsolete' };
  if (!(await claimAnalysisWindowSlot(db)))
    throw new Error('Hourly analysis admission exhausted.');
  const analysis = await ensureOpportunityAnalysis(opportunityId, {
    enrich: value.enrich,
    budgetMicros: value.budgetMicros,
  });
  return { status: analysis.status, analysisId: analysis.id };
}
