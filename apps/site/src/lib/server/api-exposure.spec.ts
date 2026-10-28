import { ObjectRegistry } from '@happyvertical/smrt-core';
import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';
import { describe, expect, it } from 'vitest';
import './smrt.js';
import {
  listApiExposedResources,
  listExposureCandidates,
  listMcpExposedResources,
  resolveApiResource,
  resolveMcpToolClass,
} from './api-exposure';

/**
 * Candidate-owned classes that stay off the generic surfaces: audit and
 * provider ledgers, the legacy résumé fallback, and the records that are
 * still behind their scoped workflows (tranches b/c of #260).
 */
const privateEvidenceClasses = [
  'OpportunityIntelligenceRequest',
  'OpportunityIntelligenceResult',
  'ResumeAchievement',
  'ResumeEducation',
  'ResumeLink',
  'ResumeOtherRole',
  'ResumePosition',
  'ResumeSkill',
  'ResumeSkillCategory',
  'ResumeSkillGroup',
];

async function discoverCliResources(): Promise<
  Array<{
    className: string;
    commands: Array<{ commandName: string }>;
    slug: string;
  }>
> {
  const handler = createResourceListHandler({
    commandPolicy: () => true,
    ensureRegistry: async () => {},
    resolveSession: async () => ({
      permissions: [],
      sessionId: 'spec',
      tenantId: null,
      user: { id: 'user-1' } as never,
    }),
  });
  const response = await handler({ locals: {} } as never);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    resources: Array<{
      className: string;
      commands: Array<{ commandName: string }>;
      slug: string;
    }>;
  };
  return body.resources;
}

describe('decorator-driven surface exposure', () => {
  it('uses the same canonical slug as CLI resource discovery for every REST class', async () => {
    const cli = new Map(
      (await discoverCliResources()).map((resource) => [
        resource.className,
        resource,
      ]),
    );
    const rest = listApiExposedResources();
    expect(rest.length).toBeGreaterThan(10);
    for (const resource of rest) {
      const discovered = cli.get(resource.className);
      expect(discovered, resource.className).toBeDefined();
      expect(discovered?.slug, resource.className).toBe(resource.slug);
      expect(resolveApiResource(resource.slug)?.className).toBe(
        resource.className,
      );
      expect(resolveApiResource(resource.tableName)?.className).toBe(
        resource.className,
      );
    }
    // The CLI mirrors the api include, so no app-owned class is CLI-only.
    const candidates = new Set(
      listExposureCandidates().map((resource) => resource.className),
    );
    for (const discovered of cli.values()) {
      if (!candidates.has(discovered.className)) continue;
      expect(resolveApiResource(discovered.slug)?.className).toBe(
        discovered.className,
      );
    }
  });

  it('exposes the owner-scoped career model on REST, CLI and MCP (#259)', async () => {
    const rest = new Map(
      listApiExposedResources().map((r) => [r.className, r]),
    );
    const mcp = new Map(listMcpExposedResources().map((r) => [r.className, r]));
    const cli = new Map(
      (await discoverCliResources()).map((resource) => [
        resource.className,
        resource,
      ]),
    );
    const full = ['list', 'get', 'create', 'update', 'delete'];
    for (const className of [
      'Achievement',
      'AchievementAttachment',
      'AchievementTag',
      'Attachment',
      'CandidateProfileLink',
      'Duty',
      'DutyTag',
      'Education',
      'EducationTag',
      'EmploymentRole',
      'EmploymentRoleTag',
      'Experience',
      'ExperienceCompany',
      'ExperienceRole',
      'ExperienceTag',
      'Project',
      'ProjectAttachment',
      'ProjectTag',
      'SkillCategory',
      'SkillCategoryMember',
      'SkillGroup',
      'SkillGroupMember',
    ]) {
      expect([...(rest.get(className)?.apiActions ?? [])], className).toEqual(
        full,
      );
      expect([...(mcp.get(className)?.mcpActions ?? [])], className).toEqual(
        full,
      );
      expect(
        cli
          .get(className)
          ?.commands.map((c) => c.commandName)
          .sort(),
        className,
      ).toEqual([...full].sort());
    }
    // The owner's profile is never created or deleted through an agent.
    const profileActions = ['list', 'get', 'update'];
    expect([...(rest.get('CandidateProfile')?.apiActions ?? [])]).toEqual(
      profileActions,
    );
    expect([...(mcp.get('CandidateProfile')?.mcpActions ?? [])]).toEqual(
      profileActions,
    );
    expect(
      cli
        .get('CandidateProfile')
        ?.commands.map((c) => c.commandName)
        .sort(),
    ).toEqual([...profileActions].sort());
    expect(resolveMcpToolClass('achievement_delete')?.className).toBe(
      'Achievement',
    );
    expect(resolveMcpToolClass('candidateprofile_update')?.className).toBe(
      'CandidateProfile',
    );
  });

  it('keeps candidate evidence and audit records off generic REST and MCP surfaces', () => {
    const rest = new Set(listApiExposedResources().map((r) => r.className));
    const mcp = new Set(listMcpExposedResources().map((r) => r.className));
    for (const className of privateEvidenceClasses) {
      expect(rest.has(className), className).toBe(false);
      expect(mcp.has(className), className).toBe(false);
    }
    expect(resolveApiResource('resumeprofiles')).toBeUndefined();
    expect(resolveMcpToolClass('resumeposition_list')).toBeUndefined();
  });

  it('marks mixed provider-ledger tables sensitive for native feed suppression', () => {
    for (const className of [
      'OpportunityIntelligenceRequest',
      'OpportunityIntelligenceResult',
    ]) {
      const registered = ObjectRegistry.getClass(className) as unknown as {
        config?: { sensitive?: unknown };
      };
      expect(registered.config?.sensitive, className).toBe(true);
    }
  });

  it('resolves per-action includes from the decorator', () => {
    // Tranche (b): system-authored records are read-only, applications are
    // writable but never deletable through MCP.
    expect([...(resolveApiResource('agentruns')?.actions ?? [])]).toEqual([
      'list',
      'get',
    ]);
    expect([...(resolveApiResource('applications')?.actions ?? [])]).toEqual([
      'list',
      'get',
      'create',
      'update',
      'delete',
    ]);
    expect([
      ...(resolveMcpToolClass('application_delete')?.actions ?? []),
    ]).toEqual(['list', 'get', 'create', 'update']);
    // The reusable answer library stays a privacy surface with no generic
    // CRUD anywhere (candidate-answers.spec.ts).
    expect(resolveApiResource('candidateanswers')).toBeUndefined();
    expect([
      ...(resolveApiResource('opportunity_intelligence_controls')?.actions ??
        []),
    ]).toEqual(['list', 'get']);
  });

  it('keeps classes with an empty api include off every surface', () => {
    const hidden = listExposureCandidates().filter(
      (r) => r.apiActions.size === 0 && r.mcpActions.size === 0,
    );
    expect(hidden.map((r) => r.className)).toEqual(
      expect.arrayContaining([
        'CliAuthRequest',
        // Data-surface action state. A preview token IS the authority it
        // confers and an idempotency record holds another principal's action
        // outcome, so neither may be readable through a generic surface.
        'DataSurfaceIdempotencyRecord',
        'DataSurfacePreviewToken',
        'EmploymentPerson',
        'HostedInvite',
        'AccountDeletionRecord',
        'ResumeImportWriteOperation',
        'ResumeImportQuarantine',
        'ResumeImportRecoveryAudit',
        ...privateEvidenceClasses,
      ]),
    );
    expect(resolveMcpToolClass('resumeposition_list')).toBeUndefined();
    expect(resolveMcpToolClass('candidateprofile_delete')).toBeDefined();
    expect(
      resolveMcpToolClass('candidateprofile_delete')?.actions.has('delete'),
    ).toBe(false);
    expect(resolveMcpToolClass('cliauthrequest_get')).toBeUndefined();
    expect(resolveMcpToolClass('datasurfacepreviewtoken_list')).toBeUndefined();
    expect(
      resolveMcpToolClass('datasurfaceidempotencyrecord_get'),
    ).toBeUndefined();
  });

  it('never exposes collection classes or classes from other packages', () => {
    const names = new Set(listExposureCandidates().map((r) => r.className));
    expect(names.has('FactCollection')).toBe(false);
    expect(names.has('User')).toBe(false);
    expect(names.has('Prompt')).toBe(false);
    for (const [, registered] of ObjectRegistry.getAllClasses()) {
      if (
        registered.packageName === '@willgriffin/iolaus-site' &&
        registered.extends !== 'SmrtCollection'
      ) {
        expect(names.has(registered.name), registered.name).toBe(true);
      }
    }
  });

  it('registers a collection constructor for every MCP-exposed site class', () => {
    // MCPGenerator.getCollection reads `collectionConstructor` directly and
    // never synthesizes one, so a cold `<class>_list` call fails for any model
    // missing from registration in `$lib/server/smrt`.
    const missing = listMcpExposedResources()
      .map((resource) => resource.className)
      .filter(
        (className) =>
          typeof ObjectRegistry.getClass(className)?.collectionConstructor !==
          'function',
      );
    expect(missing).toEqual([]);
  });
});
