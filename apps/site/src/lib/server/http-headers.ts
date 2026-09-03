const PDF_EXTENSION = '.pdf';
const MAX_FILENAME_LENGTH = 120;

export function safePdfFilename(filename: string | null | undefined): string {
  const sanitized = replaceControlCharacters(String(filename ?? ''))
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/[^\w .-]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');

  const stem = sanitized
    .replace(/\.pdf$/i, '')
    .slice(0, MAX_FILENAME_LENGTH - PDF_EXTENSION.length)
    .replace(/[.\s-]+$/g, '');

  return `${stem || 'resume'}${PDF_EXTENSION}`;
}

function replaceControlCharacters(value: string): string {
  let result = '';

  for (const char of value) {
    const code = char.charCodeAt(0);
    result += code < 32 || code === 127 ? ' ' : char;
  }

  return result;
}
