import { describe, expect, it } from 'vitest';
import {
  parseConfirmedCandidateSkills,
  withoutSkillDiscoveryMetadata,
} from './candidate-skill-discovery.js';

const skill = {
  id: 'skill-1',
  label: 'Python',
  classification: 'introductory',
  provenance: 'user_verified',
  discoveryRequestId: 'request-1',
  evidence: [
    {
      id: 'project-1',
      title: 'Prototype',
      text: 'Tried Python for a small prototype.',
    },
  ],
};
const facts = (rows: unknown[]) =>
  JSON.stringify({ version: 1, facts: { confirmedSkills: rows } });

describe('confirmed private skill evidence', () => {
  it('retains exact introductory depth and original evidence without arbitrary fields', () => {
    expect(
      parseConfirmedCandidateSkills(
        facts([{ ...skill, privateMetadata: 'omit' }]),
      ),
    ).toEqual([skill]);
  });
  it('rejects unconfirmed, unknown, missing provenance and malformed evidence', () => {
    expect(
      parseConfirmedCandidateSkills(
        facts([
          { ...skill, provenance: 'model_generated' },
          { ...skill, classification: 'unknown' },
          { ...skill, evidence: [] },
          { ...skill, evidence: [{ id: 'x', title: '', text: 'x' }] },
          { ...skill, discoveryRequestId: '' },
          null,
        ]),
      ),
    ).toEqual([]);
    expect(parseConfirmedCandidateSkills('{broken')).toEqual([]);
    expect(
      parseConfirmedCandidateSkills(
        JSON.stringify({ version: 2, facts: { confirmedSkills: [skill] } }),
      ),
    ).toEqual([]);
  });
  it('deduplicates confirmation identity while retaining separate skills', () => {
    expect(
      parseConfirmedCandidateSkills(
        facts([
          skill,
          skill,
          {
            ...skill,
            id: 'skill-2',
            label: 'Node.js',
            classification: 'direct',
          },
        ]),
      ),
    ).toHaveLength(2);
  });
  it('excludes pending proposals from preference evidence while preserving existing serialized inputs', () => {
    const original = '{ "targetRoles": ["Engineer"] }';
    expect(withoutSkillDiscoveryMetadata(original)).toBe(original);
    expect(
      withoutSkillDiscoveryMetadata(
        JSON.stringify({
          targetRoles: ['Engineer'],
          skillDiscovery: { proposals: [{ label: 'Unconfirmed' }] },
        }),
      ),
    ).toBe('{"targetRoles":["Engineer"]}');
  });
});
