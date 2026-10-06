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
 * live windows a new key is allowed untracked, never evicting a live counter. It is per replica: with N replicas the
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
      // A full map of live windows admits the new key untracked rather than
      // evicting a live counter or refusing it: flooding junk keys must
      // neither reset a victim's limit nor lock everyone else out.
      if (this.makeRoom(now)) this.windows.set(key, { count: 1, start: now });
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

/**
 * Limiter key for a client address. IPv6 hosts routinely control a whole /64,
 * so they are keyed by that prefix; one host cannot mint unlimited keys.
 */
export function clientAddressKey(address: string): string {
  const value = address.trim().toLowerCase();
  if (!value.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/u.test(value)) {
    return value.replace(/^::ffff:/u, '');
  }
  const [head, tail = ''] = value.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = value.includes('::') && tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = value.includes('::')
    ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
    : headGroups;
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0'))
    .join(':')}::/64`;
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
