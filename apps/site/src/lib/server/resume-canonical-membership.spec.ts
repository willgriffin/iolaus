import { describe, expect, it } from 'vitest';
import {
  isCanonicalEducationEntry,
  isCanonicalOtherRoleEntry,
} from './resume-canonical-membership';

describe('shared canonical membership predicates', () => {
  it('preserves the normalized and legacy assembler predicates byte for byte on string entries', () => {
    const other = [
      {
        role: 'Engineer',
        company: 'Example',
        period: '2020',
        body: 'Original',
      },
      { role: '', company: 'Example', period: '2020' },
      { role: ' ', company: ' ', period: ' ' },
      { role: 'Engineer', company: '', period: '2020' },
    ];
    const education = [
      { title: 'Degree', detail: 'Original', institution: 'Example' },
      { title: '', detail: 'Original' },
      { title: ' ', detail: ' ' },
      { title: 'Degree', detail: '' },
    ];
    for (const sourceKind of ['normalized', 'legacy']) {
      const previous = {
        sourceKind,
        other: other.filter((role) => role.role && role.company && role.period),
        education: education.filter((item) => item.title && item.detail),
      };
      const extracted = {
        sourceKind,
        other: other.filter(isCanonicalOtherRoleEntry),
        education: education.filter(isCanonicalEducationEntry),
      };
      expect(JSON.stringify(extracted)).toBe(JSON.stringify(previous));
    }
  });
  it('does not classify a missing or non-string field as canonical content', () => {
    expect(isCanonicalEducationEntry({ title: 'Degree' })).toBe(false);
    expect(isCanonicalEducationEntry({ title: 'Degree', detail: 5 })).toBe(
      false,
    );
    expect(
      isCanonicalOtherRoleEntry({ role: 'Engineer', period: '2020' }),
    ).toBe(false);
    expect(
      isCanonicalOtherRoleEntry({
        role: 'Engineer',
        company: 'Example',
        period: '2020',
      }),
    ).toBe(true);
  });
});
