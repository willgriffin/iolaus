export const OPPORTUNITY_LIST_REFRESH_STORAGE_KEY =
  'iolaus.admin.opportunities.changed';

export function notifyOpportunityListChanged(opportunityId = ''): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      OPPORTUNITY_LIST_REFRESH_STORAGE_KEY,
      JSON.stringify({
        at: Date.now(),
        opportunityId,
      }),
    );
  } catch {
    // Keep review actions working when localStorage is unavailable.
  }
}
