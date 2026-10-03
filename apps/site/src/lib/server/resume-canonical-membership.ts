/** The canonical assembler's existing string-field predicates, without trimming. */
function hasText(value: unknown): boolean {
  return typeof value === 'string' && Boolean(value);
}
export function isCanonicalOtherRoleEntry(value: {
  role?: unknown;
  company?: unknown;
  period?: unknown;
}): boolean {
  return hasText(value.role) && hasText(value.company) && hasText(value.period);
}
export function isCanonicalEducationEntry(value: {
  title?: unknown;
  detail?: unknown;
}): boolean {
  return hasText(value.title) && hasText(value.detail);
}
