// Auto-submit feature flags.
//
// This feature submits real applications to real employers, so it ships dark:
// `AUTO_SUBMIT_ENABLED` is false by default (no live POST) and
// `AUTO_SUBMIT_DRY_RUN` defaults to false (feature dormant unless explicitly
// enabled; when set true, build and persist the exact payload for inspection
// but never send). See docs/auto-submit-design.md.

function envValue(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = envValue(name).toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export interface AutoSubmitConfig {
  /** When true the worker may perform the live ATS POST. Off by default. */
  enabled: boolean;
  /**
   * When true the worker builds and persists the exact payload but never POSTs.
   * Off by default; only meaningful while `enabled` is also true (or while an
   * operator explicitly opts into dry-run and manually enqueues a job).
   */
  dryRun: boolean;
}

export function resolveAutoSubmitConfig(
  overrides: Partial<AutoSubmitConfig> = {},
): AutoSubmitConfig {
  return {
    enabled: overrides.enabled ?? booleanEnv('AUTO_SUBMIT_ENABLED', false),
    dryRun: overrides.dryRun ?? booleanEnv('AUTO_SUBMIT_DRY_RUN', false),
  };
}

/**
 * The feature is "active" (eligibility may pass) when either a live submission
 * is enabled or a dry-run is configured. With both off, auto-submit is fully
 * dormant and the lifecycle behaves exactly as before this feature shipped.
 */
export function autoSubmitFeatureActive(config: AutoSubmitConfig): boolean {
  return config.enabled || config.dryRun;
}
