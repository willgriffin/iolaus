import type { CareerManagementData } from '$lib/server/career-management';

export const data: CareerManagementData = {
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
