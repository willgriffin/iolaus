import { browser } from '$app/environment';
import type { FilterMode, FilterState } from '../types';

function parseHash(): FilterState {
  if (!browser) return { tags: new Set(), mode: 'or' };
  const params = new URLSearchParams(window.location.hash.slice(1));
  const tags = params.get('tags');
  const mode = params.get('mode');
  return {
    tags: tags ? new Set(tags.split(',').filter(Boolean)) : new Set(),
    mode: mode === 'and' ? 'and' : 'or',
  };
}

function writeHash(state: FilterState): void {
  if (!browser) return;
  const params = new URLSearchParams();
  const list = [...state.tags];
  if (list.length) params.set('tags', list.join(','));
  if (state.mode === 'and') params.set('mode', 'and');
  const hash = params.toString();
  const url =
    window.location.pathname +
    window.location.search +
    (hash ? `#${hash}` : '');
  window.history.replaceState(null, '', url);
}

export class FilterStore {
  tags = $state<Set<string>>(new Set());
  mode = $state<FilterMode>('or');

  constructor() {
    const initial = parseHash();
    this.tags = initial.tags;
    this.mode = initial.mode;
  }

  bindHashListener(): () => void {
    if (!browser) return () => {};
    const onHash = () => {
      const next = parseHash();
      this.tags = next.tags;
      this.mode = next.mode;
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }

  private persist(): void {
    writeHash({ tags: this.tags, mode: this.mode });
  }

  setTags(tags: Set<string>): void {
    this.tags = tags;
    this.persist();
  }

  setMode(mode: FilterMode): void {
    this.mode = mode;
    this.persist();
  }

  toggle(id: string): void {
    const next = new Set(this.tags);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.setTags(next);
  }

  clear(): void {
    this.setTags(new Set());
  }
}
