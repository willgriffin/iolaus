import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  DeploymentPhaseTracker,
  type DeploymentReconciliation,
  type DeploymentReconciledContext,
  type DeploymentStepRecord,
  type DeploymentStepTransaction,
} from '@happyvertical/smrt-core/migrations';

type BaseStep = {
  id: string;
  specification: string;
  implementation?: readonly URL[];
};
export type ReleaseStep = BaseStep &
  (
    | {
        mode: 'transactional';
        apply: (tx: DeploymentStepTransaction) => Promise<void>;
      }
    | {
        mode: 'reconciled';
        inspect: (
          context: DeploymentReconciledContext,
        ) => Promise<DeploymentReconciliation>;
        apply: (context: DeploymentReconciledContext) => Promise<void>;
      }
  );

export function releaseStepChecksum(step: BaseStep): string {
  const hash = createHash('sha256').update(`${step.id}\n${step.specification}`);
  for (const file of step.implementation ?? [])
    hash.update('\n').update(readFileSync(file));
  return hash.digest('hex');
}

/**
 * Tracker owns atomic marker writes and session affinity. Pooled helpers may
 * only appear as reconciled operations with independently inspected effects.
 * Safety runs on step entry (also replay), and again immediately before work.
 * Failure/checkpoint marker writes remain possible after safety is lost.
 */
export async function executeReleaseCatalog(options: {
  database: DatabaseInterface;
  application: string;
  environment: string;
  checkSafety: (connection: DeploymentStepTransaction) => Promise<void>;
  steps: readonly ReleaseStep[];
}): Promise<DeploymentStepRecord[]> {
  if (
    new Set(options.steps.map((step) => step.id)).size !== options.steps.length
  )
    throw new Error('Release step IDs must be unique.');
  const tracker = new DeploymentPhaseTracker(options.database);
  const records: DeploymentStepRecord[] = [];
  for (const step of options.steps) {
    const key = {
      application: options.application,
      environment: options.environment,
      stepId: step.id,
      checksum: releaseStepChecksum(step),
      checkSafety: options.checkSafety,
      lockTimeoutMs: 30_000,
    };
    try {
      records.push(
        step.mode === 'transactional'
          ? await tracker.runTransactionalStep(key, async (tx) => {
              await options.checkSafety(tx);
              await step.apply(tx);
            })
          : await tracker.runReconciledStep({
              ...key,
              inspect: step.inspect,
              apply: async (context) => {
                await options.checkSafety(context);
                await context.assertActive();
                await step.apply(context);
              },
            }),
      );
    } catch (error) {
      if (error instanceof Error)
        error.message = `${step.id}: ${error.message}`;
      throw error;
    }
  }
  return records;
}
