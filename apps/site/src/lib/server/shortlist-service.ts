import { resolveDatabase } from '@happyvertical/smrt-core';
import { withPrincipalPermissionContext } from '@happyvertical/smrt-users';
import type {
  ShortlistEntry,
  ShortlistMutation,
} from '$lib/shortlist-contract.js';
import { getDbConfig } from './db.js';
import { type OwnerPrincipalLocals, runAsOwner } from './owner-principal.js';
import {
  getPublicOpportunities,
  getPublicOpportunity,
} from './public-search/index.js';
import { createShortlistStore } from './shortlist-store.js';
import { workspaceSubjectFromLocals } from './workspace-subject.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

async function store(locals?: OwnerPrincipalLocals) {
  return createShortlistStore(
    await resolveDatabase(getDbConfig()),
    locals
      ? async (subject, transaction) =>
          await withPrincipalPermissionContext(
            {
              db: transaction,
              userId: subject.userId,
              tenantId: subject.tenantId,
              postgresRls: false,
            },
            async () =>
              await runAsOwner(
                locals,
                async (run) => {
                  const current = workspaceSubjectFromLocals(locals);
                  if (
                    current.tenantId !== subject.tenantId ||
                    current.userId !== subject.userId
                  )
                    throw new Error('Workspace changed.');
                  const operation =
                    workspaceWorkflowOperation('shortlist.manage');
                  await run.assertOperation(
                    operation.collection,
                    operation.action,
                  );
                },
                { action: 'shortlist.write' },
              ),
          )
      : undefined,
  );
}

/** Revalidate public snapshots on one bounded catalog read. */
export async function listShortlist(
  locals: OwnerPrincipalLocals,
): Promise<ShortlistEntry[]> {
  return await runAsOwner(
    locals,
    async (run) => {
      await run.assertOperation(
        workspaceWorkflowOperation('shortlist.manage').collection,
        workspaceWorkflowOperation('shortlist.manage').action,
      );
      const subject = workspaceSubjectFromLocals(locals);
      const entries = await (await store()).list(subject);
      try {
        const current = new Map(
          (
            await getPublicOpportunities(
              entries.map((entry) => entry.opportunity.id),
            )
          ).map((opportunity) => [opportunity.id, opportunity]),
        );
        return entries.map((entry) => {
          const opportunity = current.get(entry.opportunity.id);
          return opportunity
            ? { ...entry, opportunity, available: true }
            : { ...entry, available: false };
        });
      } catch {
        // A catalog outage is unknown, not proof the historical item vanished.
        return entries;
      }
    },
    { action: 'shortlist.list' },
  );
}

export async function mutateShortlist(
  locals: OwnerPrincipalLocals,
  mutation: ShortlistMutation,
): Promise<ShortlistEntry> {
  return await runAsOwner(
    locals,
    async (run) => {
      const operation = workspaceWorkflowOperation('shortlist.manage');
      await run.assertOperation(operation.collection, operation.action);
      const subject = workspaceSubjectFromLocals(locals);
      const current =
        mutation.expectedRevision === 0
          ? await getPublicOpportunity(mutation.opportunityId)
          : null;
      return await (await store(locals)).mutate(subject, mutation, current);
    },
    { action: 'shortlist.mutate' },
  );
}

export async function importShortlist(
  locals: OwnerPrincipalLocals,
  entries: ShortlistEntry[],
) {
  return await runAsOwner(
    locals,
    async (run) => {
      const operation = workspaceWorkflowOperation('shortlist.manage');
      await run.assertOperation(operation.collection, operation.action);
      const subject = workspaceSubjectFromLocals(locals);
      // Browser storage is untrusted. Only a fresh public catalog projection may
      // cross into the account store; unavailable guest entries remain local so
      // their arbitrary snapshot URLs can never become account history.
      let current: Awaited<ReturnType<typeof getPublicOpportunities>>;
      try {
        current = await getPublicOpportunities(
          entries.map((entry) => entry.opportunity.id),
        );
      } catch {
        current = [];
      }
      const publicById = new Map(
        current.map((opportunity) => [opportunity.id, opportunity]),
      );
      const accepted = new Map<string, ShortlistEntry>();
      const now = Date.now();
      const timestamp = (value: string | null) => {
        if (!value) return null;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed <= now
          ? new Date(parsed).toISOString()
          : null;
      };
      for (const entry of entries) {
        const opportunity = publicById.get(entry.opportunity.id);
        if (opportunity && !accepted.has(opportunity.id)) {
          const firstSeenAt =
            timestamp(entry.firstSeenAt) ?? new Date(now).toISOString();
          accepted.set(opportunity.id, {
            ...entry,
            opportunity,
            firstSeenAt,
            updatedAt: new Date(now).toISOString(),
            openedAt: timestamp(entry.openedAt),
            appliedAt: timestamp(entry.appliedAt),
            revision: 1,
          });
        }
      }
      const acceptedEntries = [...accepted.values()];
      const result = await (await store(locals)).merge(
        subject,
        acceptedEntries,
      );
      return {
        ...result,
        acknowledgedIds: acceptedEntries.map((entry) => entry.opportunity.id),
      };
    },
    { action: 'shortlist.import' },
  );
}
