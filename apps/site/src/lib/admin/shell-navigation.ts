export const ADMIN_NAVIGATION_MEDIA_QUERY = '(min-width: 80rem)';

export type NavigationPanelState = 'collapsed' | 'expanded';

/**
 * Start with compact navigation at every size. A persisted explicit panel
 * preference still wins after the user opens or closes the menu.
 */
export function navigationStateForViewport(
  _isXlOrWider: boolean,
): NavigationPanelState {
  return 'collapsed';
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
