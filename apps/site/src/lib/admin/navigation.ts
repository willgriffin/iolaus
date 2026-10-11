import { adminCategories } from './category-navigation';

export type AdminBackLink = {
  href: string;
  label: string;
  title: string;
};

const ADMIN_PARENT_PATHS = [
  {
    match: /^\/admin\/career\/public-profile\/preview(?:\/|$)/,
    href: '/admin/career/public-profile',
    label: 'Public profile settings',
  },
  {
    match: /^\/admin\/resume\/skill-discovery(?:\/|$)/,
    href: '/admin/career',
    label: 'Resume',
  },
  {
    match: /^\/admin\/preferences\/screening-questions(?:\/|$)/,
    href: '/admin/opportunities',
    label: 'Opportunities',
  },
  {
    match: /^\/admin\/sources\/new\/?$/,
    href: '/admin/sources',
    label: 'Sources',
  },
] as const;

const PRIMARY_RESOURCE_SLUGS = new Set([
  'applications',
  'opportunities',
  'sources',
  'tasks',
]);

const RESOURCE_PARENT_OVERRIDES: Record<
  string,
  { href: string; label: string }
> = {
  'application-material-comments': {
    href: '/admin/applications',
    label: 'Applications',
  },
  projects: { href: '/admin/career', label: 'Resume' },
  duties: { href: '/admin/career', label: 'Resume' },
  achievements: { href: '/admin/career', label: 'Resume' },
  attachments: { href: '/admin/career', label: 'Resume' },
  'achievement-attachments': { href: '/admin/career', label: 'Resume' },
  'achievement-tags': { href: '/admin/career', label: 'Resume' },
  'company-attachments': { href: '/admin/career', label: 'Resume' },
  'company-tags': { href: '/admin/career', label: 'Resume' },
  'decision-tags': { href: '/admin/memory', label: 'Memory' },
  'duty-tags': { href: '/admin/career', label: 'Resume' },
  'education-tags': { href: '/admin/career', label: 'Resume' },
  'experience-companies': { href: '/admin/career', label: 'Resume' },
  'experience-roles': { href: '/admin/career', label: 'Resume' },
  'experience-tags': { href: '/admin/career', label: 'Resume' },
  'opportunity-companies': {
    href: '/admin/opportunities',
    label: 'Opportunities',
  },
  'opportunity-places': {
    href: '/admin/opportunities',
    label: 'Opportunities',
  },
  'opportunity-roles': { href: '/admin/opportunities', label: 'Opportunities' },
  'opportunity-tags': { href: '/admin/opportunities', label: 'Opportunities' },
  'project-attachments': { href: '/admin/career', label: 'Resume' },
  'project-tags': { href: '/admin/career', label: 'Resume' },
  'resume-variants': { href: '/admin/career', label: 'Resume' },
  'role-tags': { href: '/admin/career', label: 'Resume' },
  'skill-categories': { href: '/admin/career', label: 'Resume' },
  'skill-group-members': { href: '/admin/career', label: 'Resume' },
  'skill-groups': { href: '/admin/career', label: 'Resume' },
  'source-crawls': { href: '/admin/research', label: 'Research' },
  'source-crawl-items': { href: '/admin/research', label: 'Research' },
  'source-tags': { href: '/admin/research', label: 'Research' },
};

export function adminParentForPath(pathname: string): {
  href: string;
  label: string;
} | null {
  for (const parent of ADMIN_PARENT_PATHS) {
    if (parent.match.test(pathname)) {
      return { href: parent.href, label: parent.label };
    }
  }

  const resourceMatch = /^\/admin\/([^/]+)\/?$/.exec(pathname);
  const resourceSlug = resourceMatch?.[1];
  if (!resourceSlug || PRIMARY_RESOURCE_SLUGS.has(resourceSlug)) return null;

  const override = RESOURCE_PARENT_OVERRIDES[resourceSlug];
  if (override) return override;

  const category = adminCategories.find(({ resources }) =>
    resources.includes(resourceSlug as never),
  );
  return category
    ? { href: `/admin/${category.key}`, label: category.label }
    : null;
}

/**
 * Accept only a local admin URL for a rendered return link. Route loads also
 * validate returnTo on the server; this is a defensive rendering boundary for
 * components that can receive their data from more than one route.
 */
export function safeAdminNavigationHref(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(value, 'http://localhost');
  } catch {
    return fallback;
  }

  if (
    parsed.origin !== 'http://localhost' ||
    (parsed.pathname !== '/admin' && !parsed.pathname.startsWith('/admin/'))
  ) {
    return fallback;
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function adminBackLink(
  parentLabel: string,
  fallbackHref: string,
  returnHref?: string | null,
): AdminBackLink {
  const label = `Back to ${parentLabel}`;
  return {
    href: safeAdminNavigationHref(returnHref, fallbackHref),
    label,
    title: label,
  };
}
