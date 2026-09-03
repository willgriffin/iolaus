import type { FilterMode, SkillGroup } from '../types';

export type GroupMap = Record<string, SkillGroup>;

function resolveSets(
  activeIds: Iterable<string>,
  groupMap: GroupMap,
): string[][] {
  return [...activeIds].map((id) =>
    groupMap[id] ? groupMap[id].skills : [id],
  );
}

export function matches(
  tags: string[],
  activeIds: Set<string>,
  groupMap: GroupMap,
  mode: FilterMode,
): boolean {
  if (!activeIds.size) return true;
  const sets = resolveSets(activeIds, groupMap);
  if (mode === 'or') {
    return sets.some((set) => set.some((s) => tags.includes(s)));
  }
  return sets.every((set) => set.some((s) => tags.includes(s)));
}

export type HighlightPart = { text: string; mark: boolean };

export function highlight(text: string, query: string): HighlightPart[] {
  const q = query.trim();
  if (!q) return [{ text, mark: false }];
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');
  const parts = text.split(
    new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'),
  );
  return parts.map((part) => ({ text: part, mark: re.test(part) }));
}
