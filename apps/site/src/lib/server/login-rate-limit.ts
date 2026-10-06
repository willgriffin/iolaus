import { createHash } from 'node:crypto';

/** Sign-in link requests allowed per mailbox per window. */
export const MAGIC_LINK_EMAIL_LIMIT = 5;
/** Sign-in link requests allowed per client address per window. */
export const MAGIC_LINK_IP_LIMIT = 20;
export const MAGIC_LINK_WINDOW_MS = 60 * 60 * 1000;

export const MAX_TRACKED_KEYS = 10_000;

/**
 * A small fixed-window limiter held in process memory. Keys are hashed so the
 * map never retains an address, and the map is bounded: when it is full of
 * live windows new keys are refused instead of evicting existing counters. It is per replica: with N replicas the
 * effective cap is at most N times the limit, which still bounds abuse.
 */
export class WindowRateLimiter {
  private readonly windows = new Map<
    string,
    { count: number; start: number }
  >();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record one attempt; false when the key is over its limit. */
  allow(rawKey: string, now = Date.now()): boolean {
    const key = createHash('sha256').update(rawKey).digest('hex');
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs) {
      // A full map of live windows rejects the new key rather than evicting a
      // live counter: flooding junk keys must never reset a victim's limit.
      if (!this.makeRoom(now)) return false;
      this.windows.set(key, { count: 1, start: now });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  /** Drop expired windows when full; false when every window is still live. */
  private makeRoom(now: number): boolean {
    if (this.windows.size < MAX_TRACKED_KEYS) return true;
    for (const [key, entry] of this.windows) {
      if (now - entry.start >= this.windowMs) this.windows.delete(key);
    }
    return this.windows.size < MAX_TRACKED_KEYS;
  }
}

export interface MagicLinkLimiters {
  email: WindowRateLimiter;
  ip: WindowRateLimiter;
}

export function createMagicLinkLimiters(): MagicLinkLimiters {
  return {
    email: new WindowRateLimiter(MAGIC_LINK_EMAIL_LIMIT, MAGIC_LINK_WINDOW_MS),
    ip: new WindowRateLimiter(MAGIC_LINK_IP_LIMIT, MAGIC_LINK_WINDOW_MS),
  };
}

export const defaultMagicLinkLimiters = createMagicLinkLimiters();
