import { describe, expect, it } from 'vitest';
import {
  adminCategoryNavigation,
  adminNavigationIsActive,
  buildAdminNavigation,
} from './category-navigation';
import { adminResources } from './resources';

describe('admin categories and primary navigation', () => {
  it('keeps Overview and the three daily workflows before category hubs', () => {
    expect(
      buildAdminNavigation(adminResources).map(({ href }) => href),
    ).toEqual([
      '/admin',
      '/admin/tasks',
      '/admin/opportunities',
      '/admin/applications',
      '/admin/career',
      '/admin/research',
      '/admin/memory',
      '/admin/system',
    ]);
  });
  it('reuses the resource visibility supplied by the shell for menus and hubs', () => {
    const resources = adminResources.filter(({ slug }) => slug === 'sources');
    const research = adminCategoryNavigation('research', resources);
    expect(research.children?.map(({ href }) => href)).toEqual([
      '/admin/sources',
    ]);
    expect(
      buildAdminNavigation(resources).some(
        ({ href }) => href === '/admin/system',
      ),
    ).toBe(false);
    expect(
      research.children?.some(({ href }) => href === '/admin/company-research'),
    ).toBe(false);
  });
  it('keeps the resume route and existing subsection deep links', () => {
    const career = adminCategoryNavigation('career', adminResources);
    expect(career.children?.map(({ href }) => href)).toContain('/admin/resume');
    expect(career.children?.map(({ href }) => href)).toContain(
      '/admin/candidate-profiles',
    );
    expect(
      adminCategoryNavigation('memory', adminResources).children?.map(
        ({ href }) => href,
      ),
    ).toEqual(['/admin/facts', '/admin/fact-candidates', '/admin/decisions']);
  });
  it('only marks Overview active at the admin root', () => {
    expect(adminNavigationIsActive('/admin', '/admin/')).toBe(true);
    expect(adminNavigationIsActive('/admin', '/admin/tasks')).toBe(false);
    expect(
      adminNavigationIsActive(
        '/admin/opportunities',
        '/admin/opportunities/123',
      ),
    ).toBe(true);
    expect(
      adminNavigationIsActive(
        '/admin/opportunities',
        '/admin/opportunities-other',
      ),
    ).toBe(false);
  });
});
