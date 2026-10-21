import { describe, expect, it } from 'vitest';
import { opportunitySearchRequest } from './opportunity-search-request.js';

describe('opportunity search UI request', () => {
  it('distinguishes the blank entry from an explicit search', () => {
    expect(
      opportunitySearchRequest(new URL('https://example.test/opportunities'))
        .submitted,
    ).toBe(false);
    const result = opportunitySearchRequest(
      new URL(
        'https://example.test/opportunities?search=remote%20welding%20jobs',
      ),
    );
    expect(result.submitted).toBe(true);
    expect(result.interpretation?.originalQuery).toBe('remote welding jobs');
    expect(result.input.skills).toContain('welding');
    expect(result.input.work_mode).toEqual(['remote']);
  });
  it('preserves basic search links and explicit filter overrides', () => {
    const result = opportunitySearchRequest(
      new URL(
        'https://example.test/opportunities?q=Engineer&skills=postgresql&skills=typescript&work_mode=remote',
      ),
    );
    expect(result.interpretation).toBeNull();
    expect(result.input.q).toBe('Engineer');
    expect(result.input.skills).toEqual(['postgresql', 'typescript']);
    const edited = opportunitySearchRequest(
      new URL(
        'https://example.test/opportunities?search=remote%20welding&skills=&work_mode=hybrid',
      ),
    );
    expect(edited.input.skills).toEqual([]);
    expect(edited.input.work_mode).toEqual(['hybrid']);
  });
  it('combines requested catalog skills with skills interpreted from the initial sentence', () => {
    const result = opportunitySearchRequest(
      new URL(
        'https://example.test/opportunities?search=remote%20welding&skills=first-aid',
      ),
    );
    expect(result.input.skills).toEqual(['welding', 'first-aid']);
  });
  it('accepts untouched optional salary fields from the refine form', () => {
    const result = opportunitySearchRequest(
      new URL(
        'https://example.test/opportunities?q=Engineer&salary_min=&salary_currency=&salary_period=&work_mode=&country=',
      ),
    );
    expect(result.input.q).toBe('Engineer');
    expect(result.input.salary_min).toBeUndefined();
    expect(result.input.country).toEqual([]);
  });
  it('accepts explicit browsing and separates view flags from API input', () => {
    const result = opportunitySearchRequest(
      new URL('https://example.test/opportunities?start=1&view=list'),
    );
    expect(result.submitted).toBe(true);
    expect(result.view).toBe('list');
    expect(result.input).not.toHaveProperty('view');
    expect(result.input).not.toHaveProperty('start');
  });
  it('honors toggled-off interpreted skills while retaining work preferences', () => {
    const result = opportunitySearchRequest(
      new URL(
        'https://example.test/opportunities?search=remote%20welding&skills_mode=replace&skills=first-aid',
      ),
    );
    expect(result.input.skills).toEqual(['first-aid']);
    expect(result.input.work_mode).toEqual(['remote']);
    expect(result.interpretation?.chips.map((chip) => chip.value)).toEqual([
      'remote',
    ]);
    expect(
      opportunitySearchRequest(
        new URL(
          'https://example.test/opportunities?search=welding&skills_mode=replace',
        ),
      ).input.skills,
    ).toEqual([]);
  });
  it('accepts an editable location and ignores an empty location', () => {
    const result = opportunitySearchRequest(
      new URL('https://example.test/opportunities?location=Edmonton'),
    );
    expect(result.input.location).toBe('Edmonton');
    expect(result.submitted).toBe(true);
    expect(
      opportunitySearchRequest(
        new URL('https://example.test/opportunities?location='),
      ).input.location,
    ).toBeUndefined();
  });
  it('rejects duplicate, malformed and unknown parameters', () => {
    for (const query of [
      'view=modal',
      'view=list&view=triage',
      'start=0',
      'skills_mode=append',
      'location=a&location=b',
      'search=a&search=b',
      'q=a&q=b',
      'remote_ok=maybe',
      'private_owner=other',
      'limit=999',
      'salary_min=120000',
    ])
      expect(() =>
        opportunitySearchRequest(
          new URL(`https://example.test/opportunities?${query}`),
        ),
      ).toThrow();
  });
});
