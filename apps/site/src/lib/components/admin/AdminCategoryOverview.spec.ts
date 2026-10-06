import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { adminCategories } from '$lib/admin/category-navigation';
import { adminResources } from '$lib/admin/resources';
import AdminCategoryOverview from './AdminCategoryOverview.svelte';

describe('admin category overview pages', () => {
  it.each(
    adminCategories,
  )('renders $label with accessible subsection links and its parent return', ({
    key,
    label,
  }) => {
    const { body } = render(AdminCategoryOverview, {
      props: { category: key, resources: adminResources },
    });
    expect(body).toContain(`>${label}</h1>`);
    expect(body).toContain(`aria-label="${label} sections"`);
    expect(body).toContain(
      key === 'memory' ? 'href="/admin/system"' : 'href="/admin"',
    );
    expect(body).toContain(
      key === 'memory' ? 'Back to System' : 'Back to Overview',
    );
  });
  it('offers Memory from System without changing its existing section URLs', () => {
    const system = render(AdminCategoryOverview, {
      props: { category: 'system', resources: adminResources },
    }).body;
    expect(system).toContain('href="/admin/memory"');
    const memory = render(AdminCategoryOverview, {
      props: { category: 'memory', resources: adminResources },
    }).body;
    expect(memory).toContain('href="/admin/facts"');
    expect(memory).toContain('href="/admin/fact-candidates"');
    expect(memory).toContain('href="/admin/decisions"');
  });
  it('does not expose resource links absent from the supplied workspace resource set', () => {
    const { body } = render(AdminCategoryOverview, {
      props: {
        category: 'research',
        resources: adminResources.filter(({ slug }) => slug === 'sources'),
      },
    });
    expect(body).toContain('href="/admin/sources"');
    expect(body).not.toContain('href="/admin/company-research"');
  });
});
