import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceOwnershipTableMappings,
  workspaceOwnershipClasses,
  workspaceOwnershipMixedLedgerTables,
  workspaceOwnershipTableName,
} from './workspace-ownership-backfill.js';
import './smrt.js';

describe('workspace ownership native schema contract', () => {
  it('maps every ownership class to its registered physical table', () => {
    expect(assertWorkspaceOwnershipTableMappings).not.toThrow();
  });

  it('makes every candidate-owned tuple native required while preserving the mixed ledger exception', () => {
    for (const className of workspaceOwnershipClasses) {
      const schema = ObjectRegistry.getSchema(className);
      const fields = ObjectRegistry.getClass(className)?.fields;
      expect(schema, className).toBeDefined();
      expect(fields, className).toBeDefined();

      const mixedLedger = workspaceOwnershipMixedLedgerTables.has(
        workspaceOwnershipTableName(className),
      );
      expect(schema?.columns.tenant_id?.notNull, `${className}.tenantId`).toBe(
        !mixedLedger,
      );
      expect(
        schema?.columns.owner_user_id?.notNull,
        `${className}.ownerUserId`,
      ).toBe(!mixedLedger);
      if (!mixedLedger) {
        expect(fields?.get('ownerUserId')?._meta?.required).toBe(true);
      }
      if (className === 'CandidateProfile') continue;
      expect(
        schema?.columns.candidate_profile_id?.notNull,
        `${className}.candidateProfileId`,
      ).toBe(!mixedLedger);
      if (!mixedLedger) {
        expect(fields?.get('candidateProfileId')?._meta?.required).toBe(true);
      }
    }
  });
});
