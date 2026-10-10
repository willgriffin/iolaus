import {
  type PublicOpportunity,
  publicOpportunitySchema,
} from './public-opportunity-contract.js';
import {
  SHORTLIST_LIMIT,
  SHORTLIST_STORAGE_KEY,
  type ShortlistChange,
  type ShortlistEntry,
  type ShortlistMutation,
  shortlistEntrySchema,
  shortlistImportResultSchema,
  shortlistListSchema,
  shortlistMutationSchema,
  shortlistStorageSchema,
} from './shortlist-contract.js';

export type ShortlistClient = {
  load(): Promise<ShortlistEntry[]>;
  mutate(
    opportunity: PublicOpportunity,
    change: ShortlistChange,
  ): Promise<ShortlistEntry>;
  mergeGuest(): Promise<void>;
  /** Revalidate only entries currently visible to the user; callers should pass a small set. */
  refreshAvailable(opportunityIds: string[]): Promise<ShortlistEntry[]>;
  getEntries(): ShortlistEntry[];
  destroy(): void;
};

type Options = {
  signedIn: boolean;
  fetch?: typeof fetch;
  onChange?: (entries: ShortlistEntry[]) => void;
  onWarning?: (message: string) => void;
};

const storageVersion = 1 as const;
const tombstoneStorageKey = `${SHORTLIST_STORAGE_KEY}:tombstones`;
const importEntryLimit = 50;
const importBodyByteLimit = 200 * 1024;
// Storage can be disabled for a whole browser session. Keep only public guest
// snapshots here so a client remount does not pretend that such data was saved.
let volatileGuestEntries: ShortlistEntry[] = [];
let volatileGuestStorage: Storage | null = null;
type Tombstone = Pick<ShortlistEntry, 'updatedAt' | 'revision'> & {
  id: string;
};
let volatileTombstones: Tombstone[] = [];
let volatileTombstoneGeneration = 0;

function compareEntries(
  left: ShortlistEntry,
  right: ShortlistEntry,
): ShortlistEntry {
  if (left.updatedAt !== right.updatedAt)
    return left.updatedAt > right.updatedAt ? left : right;
  if (left.revision !== right.revision)
    return left.revision > right.revision ? left : right;
  // A deterministic value tie-break keeps two tabs from oscillating forever.
  return JSON.stringify(left) >= JSON.stringify(right) ? left : right;
}

function mergeEntries(
  current: ShortlistEntry[],
  incoming: ShortlistEntry[],
): ShortlistEntry[] {
  const byId = new Map(current.map((entry) => [entry.opportunity.id, entry]));
  for (const entry of incoming) {
    const existing = byId.get(entry.opportunity.id);
    byId.set(
      entry.opportunity.id,
      existing ? compareEntries(existing, entry) : entry,
    );
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.firstSeenAt.localeCompare(b.firstSeenAt) ||
      a.opportunity.id.localeCompare(b.opportunity.id),
  );
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues)
    crypto.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function importBodyBytes(entries: ShortlistEntry[]): number {
  const body = JSON.stringify({ entries });
  return typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(body).byteLength
    : body.length;
}

function isAcknowledged(entry: ShortlistEntry, tombstone: Tombstone): boolean {
  if (entry.updatedAt !== tombstone.updatedAt)
    return entry.updatedAt < tombstone.updatedAt;
  return entry.revision <= tombstone.revision;
}

export function createShortlistClient(options: Options): ShortlistClient {
  const request = options.fetch ?? globalThis.fetch;
  let entries: ShortlistEntry[] = [];
  let destroyed = false;

  const warn = (message: string) => {
    if (!destroyed) options.onWarning?.(message);
  };
  const publish = () => {
    if (!destroyed) options.onChange?.([...entries]);
  };
  const storage = (): Storage | null => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage;
    } catch {
      warn(
        'Shortlist storage is unavailable; changes will remain only in this browser session.',
      );
      return null;
    }
  };
  const readTombstones = (local: Storage): Tombstone[] => {
    try {
      const raw = local.getItem(tombstoneStorageKey);
      if (!raw) return volatileTombstones;
      const parsed: unknown = JSON.parse(raw);
      const legacy = Array.isArray(parsed);
      const payload = legacy ? { generation: 0, tombstones: parsed } : parsed;
      if (
        !payload ||
        typeof payload !== 'object' ||
        !Array.isArray((payload as { tombstones?: unknown }).tombstones) ||
        !Number.isInteger((payload as { generation?: unknown }).generation)
      )
        return volatileTombstones;
      const generation = (payload as { generation: number }).generation;
      if (generation > volatileTombstoneGeneration) volatileGuestEntries = [];
      volatileTombstoneGeneration = generation;
      volatileTombstones = (payload as { tombstones: unknown[] }).tombstones
        .filter(
          (item): item is Tombstone =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as Tombstone).id === 'string' &&
            typeof (item as Tombstone).updatedAt === 'string' &&
            Number.isInteger((item as Tombstone).revision),
        )
        .slice(-SHORTLIST_LIMIT);
    } catch {
      warn('Saved shortlist removal data could not be read.');
    }
    return volatileTombstones;
  };
  const writeTombstones = (next: Tombstone[]) => {
    if (next.length > SHORTLIST_LIMIT) volatileTombstoneGeneration += 1;
    volatileTombstones = next.slice(-SHORTLIST_LIMIT);
    const local = storage();
    if (!local) return;
    try {
      local.setItem(
        tombstoneStorageKey,
        JSON.stringify({
          generation: volatileTombstoneGeneration,
          tombstones: volatileTombstones,
        }),
      );
    } catch {
      warn('Shortlist removal state could not be saved.');
    }
  };
  const withoutAcknowledged = (
    values: ShortlistEntry[],
    tombstones: Tombstone[],
  ) => {
    const byId = new Map(
      tombstones.map((tombstone) => [tombstone.id, tombstone]),
    );
    return values.filter((entry) => {
      const tombstone = byId.get(entry.opportunity.id);
      return !tombstone || !isAcknowledged(entry, tombstone);
    });
  };
  const readGuest = (): ShortlistEntry[] => {
    const local = storage();
    if (!local) return [...volatileGuestEntries];
    try {
      if (local !== volatileGuestStorage) {
        volatileGuestStorage = local;
        volatileGuestEntries = [];
        volatileTombstones = [];
        volatileTombstoneGeneration = 0;
      }
      const tombstones = readTombstones(local);
      const raw = local.getItem(SHORTLIST_STORAGE_KEY);
      if (!raw) {
        volatileGuestEntries = withoutAcknowledged(
          volatileGuestEntries,
          tombstones,
        );
        return [...volatileGuestEntries];
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        warn('Saved shortlist data was invalid and has been reset.');
        try {
          local.removeItem(SHORTLIST_STORAGE_KEY);
        } catch {
          /* memory fallback below */
        }
        return [...volatileGuestEntries];
      }
      const parsed = shortlistStorageSchema.safeParse(value);
      if (!parsed.success) {
        warn('Saved shortlist data was invalid and has been reset.');
        try {
          local.removeItem(SHORTLIST_STORAGE_KEY);
        } catch {
          /* memory fallback below */
        }
        return [...volatileGuestEntries];
      }
      volatileGuestEntries = withoutAcknowledged(
        mergeEntries(volatileGuestEntries, parsed.data.entries),
        tombstones,
      );
      return [...volatileGuestEntries];
    } catch {
      warn(
        'Saved shortlist data could not be read; changes will remain only in this browser session.',
      );
      return [...volatileGuestEntries];
    }
  };
  const writeGuest = (next: ShortlistEntry[]): void => {
    const local = storage();
    volatileGuestEntries = local
      ? withoutAcknowledged(next, readTombstones(local))
      : [...next];
    if (next.length > SHORTLIST_LIMIT) {
      warn(
        `Shortlist sync found more than ${SHORTLIST_LIMIT} entries. Your browser copy was kept in memory; remove entries before trying to save more.`,
      );
      return;
    }
    if (!local) return;
    try {
      volatileGuestStorage = local;
      local.setItem(
        SHORTLIST_STORAGE_KEY,
        JSON.stringify({ version: storageVersion, entries: next }),
      );
    } catch {
      warn(
        'Shortlist could not be saved to this browser. Changes will remain only in this browser session.',
      );
    }
  };
  const syncGuest = () => {
    entries = readGuest();
    publish();
  };
  const storageListener = (event: StorageEvent) => {
    if (
      destroyed ||
      (event.key !== SHORTLIST_STORAGE_KEY &&
        event.key !== tombstoneStorageKey) ||
      event.storageArea !== storage()
    )
      return;
    syncGuest();
    // A simultaneous write can otherwise leave the persisted envelope with
    // only one tab's entry even though this tab safely merged both in memory.
    const local = storage();
    try {
      const parsed =
        local && local.getItem(SHORTLIST_STORAGE_KEY)
          ? shortlistStorageSchema.safeParse(
              JSON.parse(local.getItem(SHORTLIST_STORAGE_KEY)!),
            )
          : null;
      if (
        parsed?.success &&
        JSON.stringify(parsed.data.entries) !== JSON.stringify(entries)
      )
        writeGuest(entries);
    } catch {
      /* readGuest already reported a storage warning */
    }
  };
  if (!options.signedIn && typeof window !== 'undefined')
    window.addEventListener('storage', storageListener);

  async function api(path: string, init?: RequestInit): Promise<Response> {
    if (!request)
      throw new Error('Shortlist network transport is unavailable.');
    try {
      return await request(path, { credentials: 'same-origin', ...init });
    } catch {
      warn('Shortlist request failed. Check your connection and try again.');
      throw new Error('Shortlist request failed.');
    }
  }
  async function responseJson(
    response: Response,
    message: string,
  ): Promise<unknown | null> {
    try {
      return await response.json();
    } catch {
      warn(message);
      return null;
    }
  }
  async function loadAccount(): Promise<ShortlistEntry[]> {
    const response = await api('/api/shortlist');
    if (!response.ok) {
      warn('Could not load your shortlist.');
      throw new Error(`Could not load shortlist (${response.status}).`);
    }
    const payload = await responseJson(
      response,
      'Shortlist server response was invalid.',
    );
    const parsed = shortlistListSchema.safeParse(payload);
    if (!parsed.success) {
      warn('Shortlist server response was invalid.');
      throw new Error('Shortlist server response was invalid.');
    }
    if (destroyed) throw new Error('Shortlist client was destroyed.');
    entries = parsed.data.entries;
    publish();
    return [...entries];
  }
  async function refreshAvailable(
    opportunityIds: string[],
  ): Promise<ShortlistEntry[]> {
    const requested = new Set(opportunityIds);
    const targets = entries.filter((entry) =>
      requested.has(entry.opportunity.id),
    );
    let changed = false;
    const updates = new Map<
      string,
      { available: boolean; opportunity?: PublicOpportunity }
    >();
    const refreshOne = async (entry: ShortlistEntry) => {
      let response: Response;
      try {
        response = await api(
          `/api/public/v1/opportunities/${encodeURIComponent(entry.opportunity.id)}`,
        );
      } catch {
        return;
      }
      if (destroyed) return;
      const current = entries.find(
        (item) => item.opportunity.id === entry.opportunity.id,
      );
      if (!current) return;
      if (response.status === 404) {
        updates.set(entry.opportunity.id, { available: false });
        entries = entries.map((item) =>
          item.opportunity.id === entry.opportunity.id
            ? { ...item, available: false }
            : item,
        );
        changed = true;
        return;
      }
      if (!response.ok) {
        warn(
          'Could not refresh an opportunity. Its saved details were kept; try again later.',
        );
        return;
      }
      const payload = await responseJson(
        response,
        'Could not validate an opportunity refresh. Its saved details were kept.',
      );
      const opportunity = publicOpportunitySchema.safeParse(payload);
      if (!opportunity.success) {
        warn(
          'Could not validate an opportunity refresh. Its saved details were kept.',
        );
        return;
      }
      if (destroyed) return;
      updates.set(entry.opportunity.id, {
        opportunity: opportunity.data,
        available: true,
      });
      entries = entries.map((item) =>
        item.opportunity.id === entry.opportunity.id
          ? { ...item, opportunity: opportunity.data, available: true }
          : item,
      );
      changed = true;
    };
    // Four requests retain responsive UI without issuing an unbounded catalog sweep.
    for (let index = 0; index < targets.length; index += 4)
      await Promise.all(targets.slice(index, index + 4).map(refreshOne));
    if (changed && !destroyed) {
      if (!options.signedIn) {
        const refreshed = entries;
        entries = mergeEntries(readGuest(), refreshed).map((item) => ({
          ...item,
          ...updates.get(item.opportunity.id),
        }));
        writeGuest(entries);
      }
      publish();
    }
    return [...entries];
  }

  return {
    async load() {
      if (options.signedIn) return loadAccount();
      syncGuest();
      return [...entries];
    },
    async mutate(opportunity, change) {
      const safeOpportunity = publicOpportunitySchema.parse(opportunity);
      if (!options.signedIn) entries = readGuest();
      const local = !options.signedIn ? storage() : null;
      const acknowledged = local
        ? readTombstones(local).find(
            (tombstone) => tombstone.id === safeOpportunity.id,
          )
        : undefined;
      const existing = entries.find(
        (entry) => entry.opportunity.id === safeOpportunity.id,
      );
      const mutation: ShortlistMutation = shortlistMutationSchema.parse({
        mutationId: uuid(),
        opportunityId: safeOpportunity.id,
        expectedRevision: existing?.revision ?? 0,
        ...change,
      });
      if (!options.signedIn) {
        if (!existing && entries.length >= SHORTLIST_LIMIT) {
          warn(
            `A shortlist can contain at most ${SHORTLIST_LIMIT} opportunities.`,
          );
          throw new Error('Shortlist limit reached.');
        }
        const now = new Date().toISOString();
        const entry = shortlistEntrySchema.parse({
          opportunity: safeOpportunity,
          decision: mutation.decision ?? existing?.decision ?? 'seen',
          firstSeenAt: existing?.firstSeenAt ?? now,
          updatedAt: now,
          openedAt:
            mutation.opened === undefined
              ? (existing?.openedAt ?? null)
              : mutation.opened
                ? now
                : null,
          appliedAt:
            mutation.applied === undefined
              ? (existing?.appliedAt ?? null)
              : mutation.applied
                ? now
                : null,
          revision:
            Math.max(existing?.revision ?? 0, acknowledged?.revision ?? 0) + 1,
          available: existing?.available,
        });
        entries = mergeEntries(
          entries.filter(
            (item) => item.opportunity.id !== entry.opportunity.id,
          ),
          [entry],
        );
        writeGuest(entries);
        publish();
        return entry;
      }
      let response: Response;
      try {
        response = await api('/api/shortlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(mutation),
        });
      } catch (error) {
        // A timeout may have reached the server. Reload before allowing a user retry.
        await loadAccount().catch(() => {});
        throw error;
      }
      if (response.status === 409) {
        warn(
          'Your shortlist changed elsewhere. It has been reloaded; review the item and try again.',
        );
        await loadAccount();
        throw new Error('Shortlist conflict.');
      }
      if (!response.ok) {
        warn('Could not save your shortlist change.');
        throw new Error(`Could not save shortlist (${response.status}).`);
      }
      const payload = await responseJson(
        response,
        'Shortlist server response was invalid.',
      );
      const entry = shortlistEntrySchema.safeParse(
        payload && typeof payload === 'object'
          ? (payload as { entry?: unknown }).entry
          : undefined,
      );
      if (!entry.success) {
        warn('Shortlist server response was invalid.');
        throw new Error('Shortlist server response was invalid.');
      }
      if (destroyed) throw new Error('Shortlist client was destroyed.');
      entries = mergeEntries(
        entries.filter(
          (item) => item.opportunity.id !== entry.data.opportunity.id,
        ),
        [entry.data],
      );
      publish();
      return entry.data;
    },
    async mergeGuest() {
      if (!options.signedIn) return;
      const snapshot = readGuest();
      let cursor = 0;
      let retainedEntries = false;
      while (!destroyed && cursor < snapshot.length) {
        const batch: ShortlistEntry[] = [];
        while (cursor < snapshot.length) {
          const entry = snapshot[cursor];
          if (batch.length === importEntryLimit) break;
          const candidate = [...batch, entry];
          if (importBodyBytes(candidate) <= importBodyByteLimit) {
            batch.push(entry);
            cursor += 1;
            continue;
          }
          if (!batch.length) {
            warn(
              'A browser shortlist entry is too large to import. It remains in this browser.',
            );
            retainedEntries = true;
            cursor += 1;
            continue;
          }
          break;
        }
        if (!batch.length) continue;
        const baseline = new Map(
          batch.map((entry) => [entry.opportunity.id, JSON.stringify(entry)]),
        );
        const response = await api('/api/shortlist/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entries: batch }),
        });
        if (!response.ok) {
          warn(
            'Guest shortlist import failed. Your local shortlist was kept so you can try again.',
          );
          throw new Error(
            `Guest shortlist import failed (${response.status}).`,
          );
        }
        const result = shortlistImportResultSchema.safeParse(
          await responseJson(
            response,
            'Guest shortlist import response was invalid. Your local shortlist was kept.',
          ),
        );
        if (!result.success) {
          warn(
            'Guest shortlist import response was invalid. Your local shortlist was kept.',
          );
          throw new Error('Guest shortlist import response was invalid.');
        }
        if (destroyed) throw new Error('Shortlist client was destroyed.');
        entries = result.data.entries;
        publish();
        const acknowledged = new Set(result.data.acknowledgedIds);
        const acknowledgedEntries = batch.filter((entry) =>
          acknowledged.has(entry.opportunity.id),
        );
        if (acknowledgedEntries.length) {
          const local = storage();
          const prior = local ? readTombstones(local) : volatileTombstones;
          writeTombstones([
            ...prior.filter((tombstone) => !acknowledged.has(tombstone.id)),
            ...acknowledgedEntries.map((entry) => ({
              id: entry.opportunity.id,
              updatedAt: entry.updatedAt,
              revision: entry.revision,
            })),
          ]);
        }
        const current = readGuest();
        const retained = current.filter(
          (entry) =>
            !acknowledged.has(entry.opportunity.id) ||
            baseline.get(entry.opportunity.id) !== JSON.stringify(entry),
        );
        writeGuest(retained);
        if (!acknowledged.size) {
          retainedEntries = true;
          warn(
            'Some browser entries could not be imported. They remain in this browser; your account choices were kept.',
          );
        }
      }
      if (retainedEntries) return;
    },
    refreshAvailable,
    getEntries() {
      return [...entries];
    },
    destroy() {
      destroyed = true;
      if (!options.signedIn && typeof window !== 'undefined')
        window.removeEventListener('storage', storageListener);
    },
  };
}
