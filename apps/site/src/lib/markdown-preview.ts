const placeholderPrefix = '\u0000md-preview-';
const placeholderSuffix = '\u0000';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function isSafeHref(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/')) return true;
  try {
    const parsed = new URL(trimmed);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isExternalHref(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function restorePlaceholders(value: string, placeholders: string[]): string {
  return value.replace(
    new RegExp(`${placeholderPrefix}(\\d+)${placeholderSuffix}`, 'gu'),
    (_, index: string) => placeholders[Number(index)] ?? '',
  );
}

function placeholderFor(value: string, placeholders: string[]): string {
  const index = placeholders.push(value) - 1;
  return `${placeholderPrefix}${index}${placeholderSuffix}`;
}

function renderInlineMarkdown(value: string): string {
  const placeholders: string[] = [];
  let working = value.replace(/`([^`]+)`/gu, (_, code: string) =>
    placeholderFor(`<code>${escapeHtml(code)}</code>`, placeholders),
  );

  working = working.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu,
    (match: string, label: string, href: string) => {
      if (!isSafeHref(href)) return escapeHtml(match);
      const targetAttrs = isExternalHref(href)
        ? ' target="_blank" rel="noreferrer noopener"'
        : '';
      return placeholderFor(
        `<a href="${escapeAttribute(href)}"${targetAttrs}>${renderInlineMarkdown(label)}</a>`,
        placeholders,
      );
    },
  );

  const escaped = escapeHtml(working)
    .replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/gu, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/gu, '<em>$1</em>')
    .replace(/_([^_\n]+)_/gu, '<em>$1</em>');

  return restorePlaceholders(escaped, placeholders);
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/u.test(line);
}

function isHorizontalRule(line: string): boolean {
  return /^(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line);
}

function isUnorderedListItem(line: string): boolean {
  return /^\s*[-*+]\s+\S/u.test(line);
}

function isOrderedListItem(line: string): boolean {
  return /^\s*\d+[.)]\s+\S/u.test(line);
}

function isBlockquote(line: string): boolean {
  return /^\s*>\s?/u.test(line);
}

function isBlockStart(line: string): boolean {
  return (
    line.startsWith('```') ||
    isHeading(line) ||
    isHorizontalRule(line) ||
    isUnorderedListItem(line) ||
    isOrderedListItem(line) ||
    isBlockquote(line)
  );
}

function renderList(
  lines: string[],
  startIndex: number,
  kind: 'ol' | 'ul',
): { html: string; nextIndex: number } {
  const items: string[] = [];
  const matcher = kind === 'ol' ? /^\s*\d+[.)]\s+(.+)$/u : /^\s*[-*+]\s+(.+)$/u;
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index]?.match(matcher);
    if (!match) break;
    items.push(`<li>${renderInlineMarkdown(match[1] ?? '')}</li>`);
    index += 1;
  }

  return { html: `<${kind}>${items.join('')}</${kind}>`, nextIndex: index };
}

function renderCodeBlock(
  lines: string[],
  startIndex: number,
): { html: string; nextIndex: number } {
  const codeLines: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length && !lines[index]?.startsWith('```')) {
    codeLines.push(lines[index] ?? '');
    index += 1;
  }

  return {
    html: `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`,
    nextIndex: index < lines.length ? index + 1 : index,
  };
}

function renderBlockquote(
  lines: string[],
  startIndex: number,
): { html: string; nextIndex: number } {
  const quoteLines: string[] = [];
  let index = startIndex;
  while (index < lines.length && isBlockquote(lines[index] ?? '')) {
    quoteLines.push((lines[index] ?? '').replace(/^\s*>\s?/u, ''));
    index += 1;
  }

  return {
    html: `<blockquote>${renderSafeMarkdown(quoteLines.join('\n'))}</blockquote>`,
    nextIndex: index,
  };
}

export function renderSafeMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, '\n').trim().split('\n');
  if (lines.length === 1 && lines[0] === '') return '';

  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trimEnd() ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const block = renderCodeBlock(lines, index);
      blocks.push(block.html);
      index = block.nextIndex;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      const level = heading[1]?.length ?? 2;
      blocks.push(
        `<h${level}>${renderInlineMarkdown(heading[2] ?? '')}</h${level}>`,
      );
      index += 1;
      continue;
    }

    if (isHorizontalRule(line.trim())) {
      blocks.push('<hr>');
      index += 1;
      continue;
    }

    if (isUnorderedListItem(line)) {
      const block = renderList(lines, index, 'ul');
      blocks.push(block.html);
      index = block.nextIndex;
      continue;
    }

    if (isOrderedListItem(line)) {
      const block = renderList(lines, index, 'ol');
      blocks.push(block.html);
      index = block.nextIndex;
      continue;
    }

    if (isBlockquote(line)) {
      const block = renderBlockquote(lines, index);
      blocks.push(block.html);
      index = block.nextIndex;
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? '';
      if (!paragraphLine.trim()) break;
      if (paragraphLines.length > 0 && isBlockStart(paragraphLine.trimEnd()))
        break;
      paragraphLines.push(paragraphLine.trim());
      index += 1;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
  }

  return blocks.join('\n');
}
