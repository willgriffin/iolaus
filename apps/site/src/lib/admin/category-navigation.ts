import type { ShellNavItem } from '@happyvertical/smrt-svelte/workspace';
import type { AdminResource } from './resources';

export type AdminCategoryKey = 'career' | 'research' | 'memory' | 'system';
type VisibleResource = Pick<AdminResource, 'slug' | 'label' | 'description'>;

const resourceIcons: Record<string, string> = {
  'agent-runs': 'bot',
  applications: 'send',
  companies: 'building',
  'company-research': 'building',
  decisions: 'gavel',
  education: 'file-text',
  'evaluation-scores': 'bar-chart',
  experience: 'briefcase',
  'fact-candidates': 'bot',
  'fact-intakes': 'file-text',
  facts: 'database',
  opportunities: 'briefcase',
  preferences: 'sliders',
  roles: 'briefcase',
  'resume-assets': 'file-text',
  'resume-tailoring-configs': 'sliders',
  skills: 'tag',
  sources: 'rss',
  tasks: 'check-square',
};

export const adminCategories = [
  {
    key: 'career',
    label: 'Career',
    icon: 'file-text',
    description:
      'Build the profile, experience, and resume behind your next opportunity.',
    resources: [
      'candidate-profiles',
      'candidate-profile-links',
      'experience',
      'education',
      'companies',
      'roles',
      'skills',
      'resume-assets',
      'resume-tailoring-configs',
      'fact-intakes',
    ],
  },
  {
    key: 'research',
    label: 'Research',
    icon: 'rss',
    description:
      'Explore opportunity sources and the companies you are researching.',
    resources: ['sources', 'company-research'],
  },
  {
    key: 'memory',
    label: 'Memory',
    icon: 'database',
    description:
      'Keep your evidence, review queue, and decisions close at hand.',
    resources: ['facts', 'fact-candidates', 'decisions'],
  },
  {
    key: 'system',
    label: 'System',
    icon: 'sliders',
    description:
      'Review your preferences, agent activity, and evaluation results.',
    resources: ['preferences', 'agent-runs', 'evaluation-scores'],
  },
] as const;
const labels: Record<string, string> = {
  'candidate-profiles': 'Profiles',
  'resume-tailoring-configs': 'Tailoring configs',
  'fact-intakes': 'Notes',
  'company-research': 'Companies',
  'fact-candidates': 'Review queue',
};

function resourceItem(
  slug: string,
  resources: readonly VisibleResource[],
): ShellNavItem | null {
  const resource = resources.find((item) => item.slug === slug);
  if (!resource) return null;
  return {
    href: `/admin/${resource.slug}`,
    icon: resourceIcons[slug] ?? 'database',
    label: labels[slug] ?? resource.label,
    description: resource.description,
  };
}

/** Both menus and hubs use the same visible resource set supplied by the shell. */
export function adminCategoryNavigation(
  key: AdminCategoryKey,
  resources: readonly VisibleResource[],
): ShellNavItem {
  const category = adminCategories.find((item) => item.key === key)!;
  const children = category.resources
    .map((slug) => resourceItem(slug, resources))
    .filter((item): item is ShellNavItem => Boolean(item));
  if (key === 'career')
    children.unshift({
      href: '/admin/resume',
      icon: 'file-text',
      label: 'Resume',
      description: 'Review and tailor your resume for the next application.',
    });
  return {
    href: `/admin/${key}`,
    label: category.label,
    icon: category.icon,
    description: category.description,
    children,
  };
}

export function buildAdminNavigation(
  resources: readonly VisibleResource[],
): ShellNavItem[] {
  return [
    { href: '/admin', label: 'Overview', icon: 'home' },
    ...['tasks', 'opportunities', 'applications']
      .map((slug) => resourceItem(slug, resources))
      .filter((item): item is ShellNavItem => Boolean(item)),
    ...adminCategories
      .map(({ key }) => adminCategoryNavigation(key, resources))
      .filter((item) => item.children?.length),
  ];
}

export function adminNavigationIsActive(
  href: string,
  currentHref: string,
): boolean {
  const normalized = href.replace(/\/+$/, '');
  const current = currentHref.replace(/\/+$/, '');
  return (
    current === normalized ||
    (normalized !== '/admin' && current.startsWith(`${normalized}/`))
  );
}
