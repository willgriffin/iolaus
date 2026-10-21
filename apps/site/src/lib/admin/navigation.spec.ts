import { describe, expect, it } from 'vitest';
import {
  adminBackLink,
  adminParentForPath,
  safeAdminNavigationHref,
} from './navigation';
import { adminResources } from './resources';

describe('admin navigation links', () => {
  it('gives every nested resource index a non-self parent', () => {
    const primary = new Set([
      'opportunities',
      'tasks',
      'sources',
      'applications',
    ]);
    for (const resource of adminResources) {
      if (primary.has(resource.slug)) continue;
      const path = `/admin/${resource.slug}`;
      const parent = adminParentForPath(path);
      expect(parent, resource.slug).not.toBeNull();
      expect(parent?.href, resource.slug).not.toBe(path);
    }
  });
  it('keeps an explicit local admin return target with its query and hash', () => {
    expect(
      safeAdminNavigationHref(
        '/admin/opportunities?status=active&page=2#results',
        '/admin/opportunities',
      ),
    ).toBe('/admin/opportunities?status=active&page=2#results');
  });

  it.each([
    'https://example.test/admin/opportunities',
    '//example.test/admin/opportunities',
    '/account',
    'javascript:alert(1)',
  ])('falls back to the supplied parent for an unsafe return target: %s', (value) => {
    expect(safeAdminNavigationHref(value, '/admin/opportunities')).toBe(
      '/admin/opportunities',
    );
  });

  it('creates an accessible named back link', () => {
    expect(adminBackLink('Opportunities', '/admin/opportunities')).toEqual({
      href: '/admin/opportunities',
      label: 'Back to Opportunities',
      title: 'Back to Opportunities',
    });
  });

  it.each([
    [
      '/admin/career/public-profile/preview/profile-1',
      {
        href: '/admin/career/public-profile',
        label: 'Public profile settings',
      },
    ],
    [
      '/admin/resume/skill-discovery',
      { href: '/admin/career', label: 'Resume' },
    ],
    [
      '/admin/preferences/screening-questions/role-1',
      { href: '/admin/opportunities', label: 'Opportunities' },
    ],
    ['/admin/sources/new', { href: '/admin/sources', label: 'Sources' }],
    ['/admin/skills', { href: '/admin/career', label: 'Resume' }],
    ['/admin/source-crawls', { href: '/admin/research', label: 'Research' }],
    ['/admin/facts', { href: '/admin/memory', label: 'Memory' }],
    ['/admin/company-research', { href: '/admin/research', label: 'Research' }],
    [
      '/admin/opportunity-tags',
      { href: '/admin/opportunities', label: 'Opportunities' },
    ],
    ['/admin/decision-tags', { href: '/admin/memory', label: 'Memory' }],
    ['/admin/agent-runs', { href: '/admin/system', label: 'System' }],
  ])('maps subpage %s to its explicit parent', (pathname, expected) => {
    expect(adminParentForPath(pathname)).toEqual(expected);
  });

  it.each([
    '/admin/opportunities',
    '/admin/tasks',
    '/admin/sources',
  ])('does not invent a parent for a primary admin page: %s', (pathname) => {
    expect(adminParentForPath(pathname)).toBeNull();
  });
});
