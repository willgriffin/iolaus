export const ADMIN_NAVIGATION_MEDIA_QUERY = '(min-width: 80rem)';

export type NavigationPanelState = 'collapsed' | 'expanded';

/**
 * Choose the navigation default for the Tailwind `xl` breakpoint. This is a
 * default only; a persisted panel setting always wins after the user toggles
 * the sidebar.
 */
export function navigationStateForViewport(
  isXlOrWider: boolean,
): NavigationPanelState {
  return isXlOrWider ? 'expanded' : 'collapsed';
}

/**
 * Read only the panel preference from the shell's persisted settings. Invalid
 * or unrelated storage must not affect the navigation default.
 */
export function readStoredNavigationState(
  raw: string | null,
): NavigationPanelState | null {
  if (!raw) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;

    const panels = (value as { panels?: unknown }).panels;
    if (!panels || typeof panels !== 'object') return null;

    const left = (panels as { left?: unknown }).left;
    return left === 'collapsed' || left === 'expanded' ? left : null;
  } catch {
    return null;
  }
}
