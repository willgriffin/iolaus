// The shared catalog has one browsing UI for guests and signed-in members.
// Explicit administrative queries retain the management workflow and its filters.
const browserParameters = new Set([
  'search',
  'q',
  'skills',
  'skills_mode',
  'location',
  'seniority',
  'function',
  'work_mode',
  'employment_type',
  'country',
  'company',
  'source',
  'posted_since',
  'salary_min',
  'salary_currency',
  'salary_period',
  'remote_ok',
  'cursor',
  'limit',
  'start',
  'view',
  'sort',
]);

export function opportunityBrowserDestination(url: URL): string | null {
  if ([...url.searchParams.keys()].some((key) => !browserParameters.has(key)))
    return null;
  const sort = url.searchParams.get('sort');
  if (sort && !['relevance', 'newest'].includes(sort)) return null;
  const view = url.searchParams.get('view');
  if (view && !['triage', 'list'].includes(view)) return null;
  const parameters = new URLSearchParams(url.searchParams);
  parameters.set('start', '1');
  if (!view) parameters.set('view', 'list');
  return `/opportunities/?${parameters}`;
}
