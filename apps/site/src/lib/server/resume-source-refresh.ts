import {
  type PublishedCanonicalRefreshResult,
  refreshPublishedCanonicalResumeAsset,
} from './resume-admin.js';

export const DEFAULT_CANONICAL_REFRESH_DEBOUNCE_MS = 1500;

export type ResumeSourceActionResult = {
  canonicalRefresh?: {
    assetId: string;
    updatedApplications: number;
  };
  error?: string;
  message?: string;
  ok: boolean;
  warning?: string;
};

let queuedCanonicalRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let canonicalRefreshInFlight = false;
let canonicalRefreshRequestedDuringFlight = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refreshSummary(refresh: PublishedCanonicalRefreshResult) {
  return {
    assetId: String(refresh.asset.id ?? ''),
    updatedApplications: refresh.updatedApplications,
  };
}

export async function withPublishedCanonicalRefresh<
  T extends ResumeSourceActionResult,
>(result: T): Promise<T> {
  if (!result.ok) return result;

  try {
    const refresh = await refreshPublishedCanonicalResumeAsset();
    return {
      ...result,
      canonicalRefresh: refreshSummary(refresh),
      message: 'Saved and refreshed the canonical resume PDF.',
    };
  } catch (error) {
    return {
      ...result,
      message: 'Saved resume data.',
      warning: `Canonical resume PDF refresh failed; the existing published PDF is still live. ${errorMessage(error)}`,
    };
  }
}

function runQueuedCanonicalRefresh(): void {
  queuedCanonicalRefreshTimer = null;

  if (canonicalRefreshInFlight) {
    canonicalRefreshRequestedDuringFlight = true;
    return;
  }

  canonicalRefreshInFlight = true;
  void refreshPublishedCanonicalResumeAsset()
    .catch((error) => {
      console.warn(
        'Queued canonical resume PDF refresh failed; the existing published PDF is still live.',
        error,
      );
    })
    .finally(() => {
      canonicalRefreshInFlight = false;
      if (canonicalRefreshRequestedDuringFlight) {
        canonicalRefreshRequestedDuringFlight = false;
        queuePublishedCanonicalRefresh();
      }
    });
}

export function queuePublishedCanonicalRefresh(
  debounceMs = DEFAULT_CANONICAL_REFRESH_DEBOUNCE_MS,
): { debounceMs: number; queued: true } {
  if (queuedCanonicalRefreshTimer) {
    clearTimeout(queuedCanonicalRefreshTimer);
  }

  queuedCanonicalRefreshTimer = setTimeout(
    runQueuedCanonicalRefresh,
    debounceMs,
  );

  return { debounceMs, queued: true };
}

export function resetPublishedCanonicalRefreshQueueForTests(): void {
  if (queuedCanonicalRefreshTimer) {
    clearTimeout(queuedCanonicalRefreshTimer);
  }
  queuedCanonicalRefreshTimer = null;
  canonicalRefreshInFlight = false;
  canonicalRefreshRequestedDuringFlight = false;
}
