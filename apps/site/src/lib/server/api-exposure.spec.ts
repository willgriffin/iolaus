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

const privateEvidenceClasses = [
  'Achievement',
  'AchievementAttachment',
  'AchievementTag',
  'AgentRun',
  'OpportunityIntelligenceRequest',
  'OpportunityIntelligenceResult',
  'Attachment',
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
  'ResumeAchievement',
  'ResumeEducation',
  'ResumeLink',
  'ResumeOtherRole',
  'ResumePosition',
  'ResumeSkill',
  'ResumeSkillCategory',
  'ResumeSkillGroup',
  'ResumeTailoringConfig',
  'SkillCategory',
  'SkillCategoryMember',
  'SkillGroup',
  'SkillGroupMember',
  'Task',
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

  it('keeps candidate evidence and audit records off generic REST and MCP surfaces', () => {
    const rest = new Set(listApiExposedResources().map((r) => r.className));
    const mcp = new Set(listMcpExposedResources().map((r) => r.className));
    for (const className of privateEvidenceClasses) {
      expect(rest.has(className), className).toBe(false);
      expect(mcp.has(className), className).toBe(false);
    }
    expect(resolveApiResource('experiences')).toBeUndefined();
    expect(resolveMcpToolClass('achievement_list')).toBeUndefined();
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
    expect(resolveApiResource('agentruns')).toBeUndefined();
    expect(resolveApiResource('applications')).toBeUndefined();
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
        'CandidateAnswer',
        'CandidateProfile',
        'CandidateProfileLink',
        'CliAuthRequest',
        // Data-surface action state. A preview token IS the authority it
        // confers and an idempotency record holds another principal's action
        // outcome, so neither may be readable through a generic surface.
        'DataSurfaceIdempotencyRecord',
        'DataSurfacePreviewToken',
        'EmploymentPerson',
        'HostedInvite',
        'AccountDeletionRecord',
        ...privateEvidenceClasses,
      ]),
    );
    expect(resolveMcpToolClass('candidateanswer_list')).toBeUndefined();
    expect(resolveMcpToolClass('candidateprofile_get')).toBeUndefined();
    expect(resolveMcpToolClass('candidateprofilelink_get')).toBeUndefined();
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
