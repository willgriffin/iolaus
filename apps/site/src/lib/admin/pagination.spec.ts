import { describe, expect, it } from 'vitest';
import { createAdminListPagination, pageHrefForUrl } from './pagination';

describe('admin pagination helpers', () => {
  it('clamps requested pages and reports the page record count', () => {
    expect(createAdminListPagination(339, 99, 250, 89)).toMatchObject({
      end: 339,
      hasNextPage: false,
      hasPreviousPage: true,
      offset: 250,
      page: 2,
      pageSize: 250,
      recordCount: 89,
      start: 251,
      totalPages: 2,
      totalRecords: 339,
    });
  });

  it('builds page hrefs while preserving filters and clearing selections', () => {
    const url = new URL(
      'http://localhost/admin/opportunities?review=apply&skill=SvelteKit&page=3&selected=opp-1#list',
    );

    expect(pageHrefForUrl(url, 1)).toBe(
      '/admin/opportunities?review=apply&skill=SvelteKit#list',
    );
    expect(pageHrefForUrl(url, 2)).toBe(
      '/admin/opportunities?review=apply&skill=SvelteKit&page=2#list',
    );
  });
});
