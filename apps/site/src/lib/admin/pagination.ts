export interface AdminListPagination {
  end: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  offset: number;
  page: number;
  pageSize: number;
  recordCount: number;
  start: number;
  totalPages: number;
  totalRecords: number;
}

export function createAdminListPagination(
  totalRecords: number,
  requestedPage: number,
  pageSize: number,
  recordCount?: number,
): AdminListPagination {
  const safeTotalRecords = Math.max(0, totalRecords);
  const safePageSize = Math.max(1, pageSize);
  const safeRequestedPage = Number.isInteger(requestedPage)
    ? Math.max(1, requestedPage)
    : 1;
  const totalPages = Math.max(1, Math.ceil(safeTotalRecords / safePageSize));
  const page = Math.min(safeRequestedPage, totalPages);
  const offset = (page - 1) * safePageSize;
  const start = safeTotalRecords === 0 ? 0 : offset + 1;
  const end =
    safeTotalRecords === 0
      ? 0
      : Math.min(offset + safePageSize, safeTotalRecords);

  return {
    end,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    offset,
    page,
    pageSize: safePageSize,
    recordCount: recordCount ?? (safeTotalRecords === 0 ? 0 : end - start + 1),
    start,
    totalPages,
    totalRecords: safeTotalRecords,
  };
}

export function positiveIntegerSearchParam(
  url: URL,
  name: string,
  fallback: number,
): number {
  const value = Number(url.searchParams.get(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function pageHrefForUrl(url: URL, targetPage: number): string {
  const next = new URL(url);
  next.searchParams.delete('selected');
  if (targetPage <= 1) {
    next.searchParams.delete('page');
  } else {
    next.searchParams.set('page', String(targetPage));
  }
  return `${next.pathname}${next.search}${next.hash}`;
}
