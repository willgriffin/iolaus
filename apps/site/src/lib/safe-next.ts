function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Post-login destination: a same-origin path, never an absolute or protocol-relative URL. */
export function safeNextPath(
  value: string | null | undefined,
  fallback = '/admin',
): string {
  if (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !hasControlCharacter(value)
  ) {
    return value;
  }
  return fallback;
}
