import { describe, expect, it } from 'vitest';
import {
  AgentFieldContractError,
  normalizeAgentWritablePayload,
  parseAgentListField,
  serializeAgentJsonField,
  serializeAgentListField,
} from './agent-field-contract';

describe('agent field contract', () => {
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
