import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { buildAdminNavigation } from '$lib/admin/category-navigation';
import { adminResources } from '$lib/admin/resources';
import AdminTenantNav from './AdminTenantNav.svelte';

const items = buildAdminNavigation(adminResources);
describe('compact admin navigation', () => {
  it('shows category hubs with separate accessible section toggles, initially closed', () => {
    const { body } = render(AdminTenantNav, {
      props: { items, currentHref: '/admin' },
    });
    expect(body).toContain('href="/admin/career"');
    expect(body).toContain('href="/admin/research"');
    expect(body).toContain('aria-label="Resume sections"');
    expect(body).toContain('aria-expanded="false"');
    expect(body).not.toContain('href="/admin/resume"');
    expect(body).not.toContain('href="/admin/sources"');
  });
  it('does not mark Overview active on a child page', () => {
    const { body } = render(AdminTenantNav, {
      props: { items, currentHref: '/admin/tasks' },
    });
    expect(body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(body).toMatch(/href="\/admin\/tasks"[^>]*aria-current="page"/);
    expect(body).not.toMatch(/href="\/admin"[^>]*aria-current="page"/);
  });
  it('keeps collapsed category navigation available through accessible hub links', () => {
    const { body } = render(AdminTenantNav, {
      props: { items, collapsed: true, currentHref: '/admin/sources' },
    });
    expect(body).toContain('href="/admin/research"');
    expect(body).toContain('title="Research"');
    expect(body).not.toContain('aria-expanded');
  });
  it('keeps System active for a Memory subsection', () => {
    const { body } = render(AdminTenantNav, {
      props: { items, collapsed: true, currentHref: '/admin/facts' },
    });
    expect(body).toMatch(/href="\/admin\/system"[^>]*class="[^"]*active/);
    expect(body).not.toMatch(/href="\/admin\/memory"/);
  });
});
