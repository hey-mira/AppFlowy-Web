import type { Token } from '@notion-formula/sdk';

export type HighlightKind =
  | 'plain'
  | 'comment'
  | 'number'
  | 'string'
  | 'function'
  | 'keyword'
  | 'variable'
  | 'prop'
  | 'operator';
export interface HighlightSegment {
  text: string;
  kind: HighlightKind;
}

/** Paint only the current Rust token snapshot; gaps and stale snapshots stay plain. */
export function highlightFormula(source: string, tokens: Token[] = []): HighlightSegment[] {
  if (!source) return [];
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.span.end <= cursor || token.span.start < cursor || token.span.end > source.length) continue;
    if (token.span.start > cursor) segments.push({ text: source.slice(cursor, token.span.start), kind: 'plain' });
    let kind: HighlightKind = 'operator';
    const tokenKind = token.kind.toLowerCase();

    if (tokenKind.includes('comment')) kind = 'comment';
    else if (tokenKind.includes('number')) kind = 'number';
    else if (tokenKind.includes('string')) kind = 'string';
    else if (tokenKind.includes('bool') || tokenKind === 'not') kind = 'keyword';
    else if (tokenKind.includes('ident')) kind = tokens[index + 1]?.text === '(' ? 'function' : 'variable';
    else if (tokenKind === 'newline' || tokenKind === 'eof') kind = 'plain';
    segments.push({ text: source.slice(token.span.start, token.span.end), kind });
    cursor = token.span.end;
  }

  if (cursor < source.length) segments.push({ text: source.slice(cursor), kind: 'plain' });
  return segments;
}

export const HIGHLIGHT_CLASS: Record<HighlightKind, string> = {
  plain: '',
  comment: 'text-text-tertiary italic',
  number: 'text-[var(--formula-number,#6941B8)]',
  string: 'text-[var(--formula-string,#2F7D32)]',
  function: 'text-[var(--formula-function,#B5306A)]',
  keyword: 'text-[var(--formula-keyword,#1F5FB0)]',
  variable: 'text-text-primary',
  prop: 'rounded-[4px] bg-fill-secondary text-text-primary',
  operator: 'text-text-secondary',
};
