import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { CareerManagementData } from '$lib/server/career-management';
import CareerResume from './CareerResume.svelte';

vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
const data: CareerManagementData = {
  source: {
    profile: {
      name: 'Alex Rivera',
      title: 'Engineer',
      email: '',
      summary: 'Canonical summary',
      links: [],
    },
    skills: { skillGroups: [], groups: [] },
    experience: { positions: [], other: [], education: [] },
  },
  loadedComplete: true,
  skillExclusions: [],
  sections: [
    {
      key: 'profile',
      label: 'Profile and summary',
      href: '/admin/candidate-profiles',
      fields: [{ key: 'summary', label: 'Summary', multiline: true }],
      records: [
        {
          id: 'raw-profile',
          values: { summary: 'Canonical summary' },
          presentation: {
            title: 'Alex Rivera',
            context: 'Engineer',
            preview: 'Canonical summary',
            inResume: true,
            kind: 'Profile',
          },
        },
      ],
    },
    {
      key: 'experiences',
      label: 'Experience',
      href: '/admin/experiences',
      fields: [
        { key: 'summary', label: 'Experience summary', multiline: true },
      ],
      records: [
        {
          id: 'raw-experience',
          values: { summary: 'Canonical experience summary' },
          presentation: {
            title: 'Staff Engineer · Northstar',
            context: '2020 – Present',
            preview: 'Canonical experience summary',
            inResume: true,
            kind: 'Experience',
          },
        },
        {
          id: 'hidden-experience',
          values: { summary: 'Hidden experience body' },
          presentation: {
            title: 'Hidden experience',
            context: '',
            preview: 'Hidden experience body',
            inResume: false,
            hiddenReason: 'Add a company relationship.',
            kind: 'Experience',
          },
        },
      ],
    },
    {
      key: 'achievements',
      label: 'Achievements',
      href: '/admin/achievements',
      fields: [{ key: 'body', label: 'Achievement body', multiline: true }],
      records: [
        {
          id: 'raw-achievement',
          values: { body: 'Full achievement body' },
          presentation: {
            title: 'Achievement',
            context: 'Northstar',
            preview: 'Short achievement preview',
            inResume: true,
            kind: 'Achievement',
            parentExperienceId: 'raw-experience',
          },
        },
      ],
    },
    {
      key: 'education',
      label: 'Education',
      href: '/admin/education',
      fields: [{ key: 'detail', label: 'Education detail', multiline: true }],
      records: [
        {
          id: 'raw-education',
          values: { detail: '' },
          presentation: {
            title: 'Incomplete degree',
            context: '',
            preview: '',
            inResume: false,
            hiddenReason: 'Add education detail.',
            kind: 'Education',
          },
        },
      ],
    },
  ],
};

describe('Resume progressive management', () => {
  it('starts with short canonical preview cards and no forms or full child content', () => {
    const { body } = render(CareerResume, { props: { data } });
    expect(body).toMatch(/<h1[^>]*>Resume<\/h1>/);
    expect(body).toContain('Alex Rivera');
    expect(body).toContain('Staff Engineer · Northstar');
    expect(body).toContain('Canonical experience summary');
    expect(body).not.toContain('<form');
    expect(body).not.toContain('<textarea');
    expect(body).not.toContain('Full achievement body');
    expect(body).not.toContain('Short achievement preview');
    expect(body).not.toContain('Hidden experience body');
    expect(body).toContain('aria-expanded="false"');
    expect(body).toContain('record-trigger');
  });
  it('exposes view-only hidden controls/counts and lightweight child discovery', () => {
    const { body } = render(CareerResume, { props: { data } });
    expect(body).toContain('Show hidden experience');
    expect(body).toContain('Show hidden education');
    expect(body).toContain('aria-pressed="false"');
    expect(body).toContain('hidden');
    expect(body).toContain('children-toggle');
    expect(body).toContain('bullets');
    expect(body).not.toContain('name="useOnResume"');
    expect(body).not.toContain('name="candidateProfileId"');
  });
  it('keeps PDFs and detailed management reachable under distinct labels', () => {
    const { body } = render(CareerResume, { props: { data } });
    expect(body).toContain('Preview &amp; PDFs');
    expect(body).toContain('href="/admin/resume"');
    expect(body).toContain('href="/admin/experiences"');
    expect(body).toContain('href="/admin/achievements"');
    expect(body).toContain('href="/admin/skills"');
    expect(body).not.toContain('Generate resume');
  });
  it('provides stable section focus targets even when a saved record leaves the default view', () => {
    const { body } = render(CareerResume, { props: { data } });
    expect(body).toContain('id="resume-hidden-education"');
    expect(body).toContain('id="resume-hidden-other"');
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
