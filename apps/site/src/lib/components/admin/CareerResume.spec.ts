import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import CareerResume from './CareerResume.svelte';
import { data } from './career-resume-fixture';

vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));

describe('Resume progressive management', () => {
  it('starts with short canonical preview cards and no forms or full child content', () => {
    const { body } = render(CareerResume, { props: { data } });
    expect(body).not.toContain('<h1');
    expect(body).toContain('role="tablist"');
    expect(body).toMatch(/id="resume-tab-details"[^>]*aria-selected="true"/);
    expect(body).toContain('id="resume-panel-details"');
    expect(body).toContain('Alex Rivera');
    expect(body).not.toContain('Staff Engineer · Northstar');
    expect(body).toContain('Canonical summary');
    expect(body).not.toContain('<form');
    expect(body).not.toContain('<textarea');
    expect(body).not.toContain('Full achievement body');
    expect(body).not.toContain('Short achievement preview');
    expect(body).not.toContain('Hidden experience body');
    expect(body).toContain('aria-expanded="false"');
    expect(body).toContain('record-trigger');
  });
  it('exposes view-only hidden controls and counts for Details', () => {
    const { body } = render(CareerResume, { props: { data } });
    expect(body).toContain('Show hidden education');
    expect(body).toContain('aria-pressed="false"');
    expect(body).toContain('hidden');
    expect(body.replace(/<!--.*?-->/g, '')).toMatch(
      /0 in resume · 1 loaded\s*· 1 hidden/,
    );
    expect(body).not.toContain('name="useOnResume"');
    expect(body).not.toContain('name="candidateProfileId"');
  });
  it('keeps Details management links and replaces the heading and PDF link with tabs', () => {
    const { body } = render(CareerResume, { props: { data } });
    expect(body).not.toContain('Preview &amp; PDFs');
    expect(body).not.toContain('href="/admin/resume"');
    expect(body).toContain('href="/admin/candidate-profiles"');
    expect(body).toContain('href="/admin/education"');
    expect(body).toContain('id="resume-tab-skills"');
    expect(body).not.toContain('Generate resume');
  });
  it('provides stable section focus targets even when a saved record leaves the default view', () => {
    const { body } = render(CareerResume, { props: { data } });
    expect(body).toContain('id="resume-hidden-education"');
    expect(body).toContain('id="resume-hidden-summary"');
    expect(body).toContain('role="status"');
    expect(body).not.toContain('Incomplete degree');
  });
  it('distinguishes bounded incomplete data from hidden entries or empty data', () => {
    const { body } = render(CareerResume, {
      props: { data: { ...data, loadedComplete: false } },
    });
    expect(body).toContain('Only part of the available data is loaded');
    expect(body).toContain('unavailable entries are not classified as hidden');
    expect(body).toContain('No entries on your resume.');
    expect(body).toContain('Show hidden to review excluded entries.');
  });
  it('escapes stored preview text without clickable stored URL injection', () => {
    const unsafe = {
      ...data,
      sections: data.sections.map((section) => ({
        ...section,
        records: section.records.map((record) => ({
          ...record,
          presentation: record.presentation
            ? {
                ...record.presentation,
                preview: '<script>alert(1)</script> javascript:alert(2)',
              }
            : undefined,
        })),
      })),
    };
    const { body } = render(CareerResume, { props: { data: unsafe } });
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script');
    expect(body).not.toContain('href="javascript:');
  });
});
