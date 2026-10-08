import type { Span, Token } from '@notion-formula/sdk';

export interface FormulaPropMatch {
  start: number;
  end: number;
  ref: string;
  idSpan: Span;
}

/** Complete literal calls in the current native token snapshot, including unresolved IDs. */
export function findPropReferences(source: string, tokens: Token[]): FormulaPropMatch[] {
  let previousEnd = 0;

  for (const token of tokens) {
    const { start, end } = token.span;

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < previousEnd ||
      end < start ||
      end > source.length ||
      source.slice(start, end) !== token.text
    )
      return [];
    previousEnd = end;
  }

  const significant = tokens.filter(
    ({ kind }) => kind !== 'LineComment' && kind !== 'BlockComment' && kind !== 'Newline'
  );
  const matches: FormulaPropMatch[] = [];

  for (let index = 0; index < significant.length; index += 1) {
    const callee = significant[index];
    const open = significant[index + 1];
    const argument = significant[index + 2];
    const close = significant[index + 3];

    if (
      callee.kind !== 'Ident' ||
      callee.text !== 'prop' ||
      significant[index - 1]?.kind === 'Dot' ||
      open?.kind !== 'OpenParen' ||
      argument?.kind !== 'String' ||
      typeof argument.string_value !== 'string' ||
      close?.kind !== 'CloseParen'
    )
      continue;
    matches.push({
      start: callee.span.start,
      end: close.span.end,
      ref: argument.string_value,
      idSpan: argument.span,
    });
  }

  return matches;
}
