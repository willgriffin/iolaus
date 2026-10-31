import { describe, expect, it } from 'vitest';
import {
  AgentFieldContractError,
  ASSISTANT_AVOID_TOPICS_MAX_CHARS,
  ASSISTANT_NOTES_MAX_CHARS,
  normalizeAgentWritablePayload,
  parseAgentListField,
  serializeAgentJsonField,
  serializeAgentListField,
} from './agent-field-contract';

describe('agent field contract', () => {
  it('restricts CandidateProfile agent writes to the career editor fields', () => {
    const payload = {
      id: 'profile-1',
      ownerUserId: 'someone-else',
      resumeAssetId: 'asset-9',
      summary: 'Updated summary',
    };
    expect(() =>
      normalizeAgentWritablePayload('CandidateProfile', payload),
    ).toThrow(AgentFieldContractError);
    expect(() =>
      normalizeAgentWritablePayload('CandidateProfile', {
        id: 'profile-1',
        summary: 'Updated summary',
        useOnResume: true,
      }),
    ).not.toThrow();
  });

  it('accepts and validates the assistant notes and contact email', () => {
    const payload: Record<string, unknown> = {
      id: 'profile-1',
      assistantNotes: 'I live in Calgary.\nOpen to relocation.',
      assistantContactEmail: ' hello@contact.example ',
    };
    normalizeAgentWritablePayload('CandidateProfile', payload);
    expect(payload.assistantContactEmail).toBe('hello@contact.example');
    expect(() =>
      normalizeAgentWritablePayload('CandidateProfile', {
        assistantContactEmail: 'not an email',
      }),
    ).toThrow(AgentFieldContractError);
    expect(() =>
      normalizeAgentWritablePayload('CandidateProfile', {
        assistantNotes: 'x'.repeat(ASSISTANT_NOTES_MAX_CHARS + 1),
      }),
    ).toThrow(AgentFieldContractError);
    const cleared: Record<string, unknown> = {
      assistantNotes: null,
      assistantContactEmail: '',
    };
    normalizeAgentWritablePayload('CandidateProfile', cleared);
    expect(cleared).toEqual({ assistantNotes: '', assistantContactEmail: '' });
  });

  it('accepts and bounds the assistant avoid-topics list', () => {
    const payload: Record<string, unknown> = {
      assistantAvoidTopics: 'CELTA\nJapanese course',
    };
    normalizeAgentWritablePayload('CandidateProfile', payload);
    expect(payload.assistantAvoidTopics).toBe('CELTA\nJapanese course');
    expect(() =>
      normalizeAgentWritablePayload('CandidateProfile', {
        assistantAvoidTopics: 'x'.repeat(ASSISTANT_AVOID_TOPICS_MAX_CHARS + 1),
      }),
    ).toThrow(AgentFieldContractError);
    expect(() =>
      normalizeAgentWritablePayload('CandidateProfile', {
        assistantAvoidTopics: 42,
      }),
    ).toThrow(AgentFieldContractError);
    const cleared: Record<string, unknown> = { assistantAvoidTopics: null };
    normalizeAgentWritablePayload('CandidateProfile', cleared);
    expect(cleared).toEqual({ assistantAvoidTopics: '' });
  });

  it('normalizes SkillGroup evidence as a JSON array field', () => {
    const payload: Record<string, unknown> = {
      evidenceJson: [{ source: 'project', ref: 'p-1' }],
    };
    normalizeAgentWritablePayload('SkillGroup', payload);
    expect(payload.evidenceJson).toBe('[{"ref":"p-1","source":"project"}]');
  });

  it('serializes list fields as newline-delimited unique items', () => {
    expect(parseAgentListField(' TypeScript \n\nSvelte\nTypeScript ')).toEqual([
      'TypeScript',
      'Svelte',
    ]);
    expect(serializeAgentListField([' Remote ', 'Canada', 'Remote'])).toBe(
      'Remote\nCanada',
    );
  });

  it('serializes JSON fields as stable JSON text', () => {
    expect(serializeAgentJsonField({ z: 1, a: { b: true } })).toBe(
      '{"a":{"b":true},"z":1}',
    );
    expect(serializeAgentJsonField('', '[]')).toBe('[]');
  });

  it('rejects invalid JSON text for JSON string fields', () => {
    expect(() => serializeAgentJsonField('{bad json')).toThrow(
      AgentFieldContractError,
    );
  });

  it('rejects non-scalar list items', () => {
    expect(() => serializeAgentListField([{ label: 'TypeScript' }])).toThrow(
      AgentFieldContractError,
    );
    expect(() => serializeAgentListField({ label: 'TypeScript' })).toThrow(
      AgentFieldContractError,
    );
    expect(() => serializeAgentListField([Number.NaN])).toThrow(
      'List fields must contain finite number values.',
    );
  });

  it('rejects unsupported JSON values instead of coercing them', () => {
    expect(() => serializeAgentJsonField({ generatedAt: new Date() })).toThrow(
      AgentFieldContractError,
    );
    expect(() => serializeAgentJsonField({ matcher: () => true })).toThrow(
      AgentFieldContractError,
    );
    expect(() =>
      serializeAgentJsonField({ score: Number.POSITIVE_INFINITY }),
    ).toThrow(AgentFieldContractError);
  });

  it('normalizes app-owned agent fields by class name', () => {
    const opportunity = normalizeAgentWritablePayload('Opportunity', {
      domainTags: ['platform', 'developer tooling'],
      requiredSkills: 'TypeScript\nSvelte',
      title: 'Platform Engineer',
    });
    expect(opportunity).toMatchObject({
      domainTags: 'platform\ndeveloper tooling',
      requiredSkills: 'TypeScript\nSvelte',
    });

    const rule = normalizeAgentWritablePayload('PreferenceRule', {
      ruleJson: { annualConsiderMin: 130000, currency: 'USD' },
    });
    expect(rule.ruleJson).toBe('{"annualConsiderMin":130000,"currency":"USD"}');

    const variant = normalizeAgentWritablePayload('ResumeVariant', {
      emphasizeTags: ['agentic', 'platform', 'agentic'],
      excludeTags: ' VBA \n old-web ',
      includePositionIds: ['anytown', 'happy-vertical'],
    });
    expect(variant).toMatchObject({
      emphasizeTags: 'agentic\nplatform',
      excludeTags: 'VBA\nold-web',
      includePositionIds: 'anytown\nhappy-vertical',
    });
  });
});
