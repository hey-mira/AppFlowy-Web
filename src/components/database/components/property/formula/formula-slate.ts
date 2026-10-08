import { Descendant, Editor, Element, Node, Path, Point, Range, Text, Transforms } from 'slate';
import { HistoryEditor, MERGING } from 'slate-history';

import { findPropReferences, FormulaPropMatch } from './property-references';

import type { TextEdit, Token } from '@notion-formula/sdk';

/**
 * The formula editor is a small Slate document: one `formula-line` element per
 * source line, holding text and `formula-prop` tokens. A token is an inline
 * void that stands for a complete `prop("...")` call; it keeps that call's
 * exact source, so the document always serializes back to the formula text.
 *
 * Offsets below are positions in that serialized source. A token counts as
 * its source length and no caret can sit inside it.
 */

export const FORMULA_LINE = 'formula-line';
export const FORMULA_PROP = 'formula-prop';

export interface FormulaPropElement {
  type: typeof FORMULA_PROP;
  /** The `prop("...")` call as written. */
  source: string;
  /** The decoded argument: a property name or id. */
  ref: string;
  children: [{ text: '' }];
}

export function isFormulaProp(node: unknown): node is FormulaPropElement {
  return Element.isElement(node) && node.type === FORMULA_PROP;
}

function isFormulaLine(node: unknown): node is Element {
  return Element.isElement(node) && node.type === FORMULA_LINE;
}

function propElement(source: string, ref: string): FormulaPropElement {
  return { type: FORMULA_PROP, source, ref, children: [{ text: '' }] };
}

/** A line's children: its text, with `matches` (offsets into the line) as tokens. */
function lineChildren(line: string, matches: FormulaPropMatch[]): Descendant[] {
  const children: Descendant[] = [];
  let cursor = 0;

  for (const match of matches) {
    children.push({ text: line.slice(cursor, match.start) });
    children.push(propElement(line.slice(match.start, match.end), match.ref) as unknown as Descendant);
    cursor = match.end;
  }

  children.push({ text: line.slice(cursor) });
  return children;
}

export function sourceToNodes(source: string, nativeTokens: Token[] = []): Descendant[] {
  // References are read off the whole source, since a string or comment can
  // span lines; a call split over lines stays text.
  const references = findPropReferences(source, nativeTokens);
  let lineStart = 0;

  return source.split('\n').map((line) => {
    const start = lineStart;
    const end = start + line.length;
    const matches = references
      .filter((match) => match.start >= start && match.end <= end)
      .map((match) => ({ ...match, start: match.start - start, end: match.end - start }));

    lineStart = end + 1;
    return { type: FORMULA_LINE, children: lineChildren(line, matches) } as Descendant;
  });
}

function nodeSource(node: Node): string {
  if (Text.isText(node)) return node.text;
  if (isFormulaProp(node)) return node.source;
  return (node as Element).children.map(nodeSource).join('');
}

export function nodesToSource(nodes: Descendant[]): string {
  return nodes.map(nodeSource).join('\n');
}

export function editorSource(editor: Editor): string {
  return nodesToSource(editor.children);
}

/** Where `point` falls in the serialized source. */
export function pointToOffset(editor: Editor, point: Point): number {
  const [lineIndex, childIndex] = point.path;
  let offset = 0;

  editor.children.forEach((line, index) => {
    if (index < lineIndex) offset += nodeSource(line).length + 1;
  });

  const line = editor.children[lineIndex] as Element | undefined;

  line?.children.forEach((child, index) => {
    if (index < childIndex) offset += nodeSource(child).length;
  });

  // A point inside a token (its empty text) sits after the token.
  const child = line?.children[childIndex];

  if (isFormulaProp(child)) return offset + child.source.length;
  return offset + point.offset;
}

/** The text point for a source offset; offsets inside a token snap to its end. */
export function offsetToPoint(editor: Editor, target: number): Point {
  let remaining = Math.max(0, target);

  for (let lineIndex = 0; lineIndex < editor.children.length; lineIndex += 1) {
    const line = editor.children[lineIndex] as Element;
    const length = nodeSource(line).length;
    const isLast = lineIndex === editor.children.length - 1;

    if (remaining > length && !isLast) {
      remaining -= length + 1;
      continue;
    }

    for (let childIndex = 0; childIndex < line.children.length; childIndex += 1) {
      const child = line.children[childIndex];

      if (Text.isText(child)) {
        if (remaining <= child.text.length) return { path: [lineIndex, childIndex], offset: remaining };
        remaining -= child.text.length;
        continue;
      }

      const size = nodeSource(child).length;

      remaining = Math.max(0, remaining - size);
    }

    return Editor.end(editor, [lineIndex]);
  }

  return Editor.end(editor, []);
}

export function selectionOffsets(editor: Editor): { start: number; end: number } | null {
  const { selection } = editor;

  if (!selection) return null;
  const [start, end] = Range.edges(selection);

  return { start: pointToOffset(editor, start), end: pointToOffset(editor, end) };
}

/** Source ranges covered by tokens. */
export function tokenRanges(editor: Editor): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;

  editor.children.forEach((line, lineIndex) => {
    if (lineIndex > 0) offset += 1;
    (line as Element).children.forEach((child) => {
      const size = nodeSource(child).length;

      if (isFormulaProp(child)) ranges.push({ start: offset, end: offset + size });
      offset += size;
    });
  });

  return ranges;
}

/** The source range of the token at `path` (or holding it), or null when there is none. */
export function tokenRangeAt(editor: Editor, path: Path): { start: number; end: number } | null {
  if (!Node.has(editor, path)) return null;
  const entry = isFormulaProp(Node.get(editor, path))
    ? [Node.get(editor, path), path]
    : Editor.above(editor, { at: path, match: isFormulaProp, voids: true });

  if (!entry) return null;
  const token = entry[0] as unknown as FormulaPropElement;
  // A point inside a token sits after it.
  const end = pointToOffset(editor, Editor.start(editor, entry[1] as Path));

  return { start: end - token.source.length, end };
}

/**
 * Moves the caret one character, stepping over a whole token. With `extend`
 * only the selection's focus moves (Shift+Arrow). Returns false when there is
 * nowhere to go, so the caller can fall back.
 */
export function moveCaret(editor: Editor, reverse: boolean, extend = false): boolean {
  const { selection } = editor;

  if (!selection) return false;
  const focus = pointToOffset(editor, selection.focus);
  let target: number;

  if (!extend && !Range.isCollapsed(selection)) {
    // Like a text field: an arrow collapses the selection to that side.
    const [start, end] = Range.edges(selection);

    target = pointToOffset(editor, reverse ? start : end);
  } else {
    target = focus + (reverse ? -1 : 1);
    const token = tokenRanges(editor).find((range) => target > range.start && target < range.end);

    if (token) target = reverse ? token.start : token.end;
  }

  if (target < 0 || target > editorSource(editor).length) return false;
  const point = offsetToPoint(editor, target);

  Transforms.select(editor, extend ? { anchor: selection.anchor, focus: point } : point);
  return true;
}

/** A caret that landed inside a token (e.g. by a click) moves after it. */
export function ejectCaretFromToken(editor: Editor): void {
  const { selection } = editor;

  if (!selection || !Range.isCollapsed(selection)) return;
  const [token] = Editor.nodes(editor, { at: selection, match: isFormulaProp });

  if (token) Transforms.select(editor, offsetToPoint(editor, pointToOffset(editor, selection.anchor)));
}

/**
 * Moves selection edges that sit inside a token out of it: a caret goes after
 * the token, a range grows to cover it. Slate ignores text inserted into a
 * void, and Chrome can hand a paste a target range inside a token's spacer.
 */
function selectOutsideTokens(editor: Editor) {
  const { selection } = editor;

  if (!selection) return;
  const inToken = (point: Point) => Editor.above(editor, { at: point, match: isFormulaProp });

  if (!inToken(selection.anchor) && !inToken(selection.focus)) return;
  if (Range.isCollapsed(selection)) {
    Transforms.select(editor, offsetToPoint(editor, pointToOffset(editor, selection.anchor)));
    return;
  }

  const [start, end] = Range.edges(selection);
  const startToken = inToken(start);
  const startOffset = startToken
    ? pointToOffset(editor, start) - (startToken[0] as unknown as FormulaPropElement).source.length
    : pointToOffset(editor, start);

  Transforms.select(editor, {
    anchor: offsetToPoint(editor, startOffset),
    focus: offsetToPoint(editor, pointToOffset(editor, end)),
  });
}

/** Inserts plain source at the selection; new lines split the line. */
export function insertSource(editor: Editor, text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  selectOutsideTokens(editor);
  Editor.withoutNormalizing(editor, () => {
    if (editor.selection && !Range.isCollapsed(editor.selection)) Transforms.delete(editor);
    lines.forEach((line, index) => {
      if (index > 0) Transforms.splitNodes(editor, { always: true });
      if (line) Transforms.insertText(editor, line);
    });
  });
}

/** Replaces `[start, end)` of the source with `text` and puts the caret `caretOffset` into it. */
export function replaceSourceRange(editor: Editor, start: number, end: number, text: string, caretOffset: number) {
  Transforms.select(editor, { anchor: offsetToPoint(editor, start), focus: offsetToPoint(editor, end) });
  insertSource(editor, text);
  Transforms.select(editor, offsetToPoint(editor, start + caretOffset));
}

/** Replaces the whole document; used when the formula changes from outside. */
export function resetSource(editor: Editor, source: string, caret?: number) {
  const apply = () => {
    Editor.withoutNormalizing(editor, () => {
      for (let index = editor.children.length - 1; index >= 0; index -= 1) {
        Transforms.removeNodes(editor, { at: [index] });
      }

      Transforms.insertNodes(editor, sourceToNodes(source), { at: [0] });
    });
    Transforms.select(editor, offsetToPoint(editor, caret ?? source.length));
  };

  // A new formula from outside starts a fresh undo history.
  if (HistoryEditor.isHistoryEditor(editor)) {
    HistoryEditor.withoutSaving(editor, apply);
    editor.history = { undos: [], redos: [] };
  } else {
    apply();
  }
}

/**
 * Where `offset` in `before` falls in `after`: text the change left alone
 * keeps its place, and an offset inside the changed text goes after its
 * replacement.
 */
export function remapOffset(before: string, after: string, offset: number): number {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;

  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  if (offset <= prefix) return offset;
  let suffix = 0;

  while (suffix < shorter - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix += 1;
  }

  return after.length - Math.min(before.length - offset, suffix);
}

/** Source offset of every text node, keyed by path, for syntax decorations. */
export function textOffsets(nodes: Descendant[]): Map<string, number> {
  const offsets = new Map<string, number>();
  let offset = 0;

  nodes.forEach((line, lineIndex) => {
    if (lineIndex > 0) offset += 1;
    (line as Element).children.forEach((child, childIndex) => {
      if (Text.isText(child)) offsets.set(`${lineIndex}.${childIndex}`, offset);
      offset += nodeSource(child).length;
    });
  });

  return offsets;
}

/** Selected source; tokens copy out as their `prop("...")` call. */
export function selectedSource(editor: Editor): string {
  const offsets = selectionOffsets(editor);

  if (!offsets) return '';
  return editorSource(editor).slice(offsets.start, offsets.end);
}

/** Keep native edits and their structural token changes in one Slate undo step. */
export function withFormulaHistoryBatch(editor: Editor, operation: () => void, mergeIntoPrevious = false) {
  if (!HistoryEditor.isHistoryEditor(editor)) return operation();
  const previous = MERGING.get(editor);
  const apply = editor.apply;
  let first = true;

  editor.apply = (op) => {
    if (op.type !== 'set_selection') {
      MERGING.set(editor, !first || mergeIntoPrevious);
      first = false;
    }

    apply(op);
  };

  try {
    operation();
  } finally {
    editor.apply = apply;
    MERGING.set(editor, previous);
  }
}

/** Rust validates the ranges and computes the final cursor before these UI operations. */
export function applySourceEdits(editor: Editor, edits: TextEdit[], cursor: number, merge = false) {
  withFormulaHistoryBatch(
    editor,
    () =>
      Editor.withoutNormalizing(editor, () => {
        [...edits]
          .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end)
          .reverse()
          .forEach(({ range, new_text }) =>
            replaceSourceRange(editor, range.start, range.end, new_text, new_text.length)
          );
        Transforms.select(editor, offsetToPoint(editor, cursor));
      }),
    merge
  );
}

/** Token metadata arrives asynchronously, but never changes formula text. */
export function synchronizeFormulaTokens(editor: Editor, tokens: Token[]) {
  const source = editorSource(editor);
  const matches = findPropReferences(source, tokens).filter(
    ({ start, end }) => !source.slice(start, end).includes('\n')
  );
  const selection = selectionOffsets(editor);
  const apply = () =>
    Editor.withoutNormalizing(editor, () => {
      let offset = 0;
      const stale: Array<{ path: Path; source: string }> = [];

      editor.children.forEach((line, lineIndex) => {
        if (lineIndex > 0) offset += 1;
        (line as Element).children.forEach((child, childIndex) => {
          const size = nodeSource(child).length;

          if (
            isFormulaProp(child) &&
            !matches.some((match) => match.start === offset && match.end === offset + size && match.ref === child.ref)
          ) {
            stale.push({ path: [lineIndex, childIndex], source: child.source });
          }

          offset += size;
        });
      });
      stale.reverse().forEach(({ path, source }) => {
        Transforms.removeNodes(editor, { at: path });
        Transforms.insertNodes(editor, { text: source }, { at: path });
      });
      const current = tokenRanges(editor);
      const unbound: Array<{ path: Path; match: FormulaPropMatch }> = [];

      offset = 0;
      editor.children.forEach((line, lineIndex) => {
        if (lineIndex > 0) offset += 1;
        (line as Element).children.forEach((child, childIndex) => {
          const start = offset;
          const end = start + nodeSource(child).length;

          if (Text.isText(child))
            matches
              .filter(
                (match) =>
                  match.start >= start &&
                  match.end <= end &&
                  !current.some((range) => range.start === match.start && range.end === match.end)
              )
              .forEach((match) =>
                unbound.push({
                  path: [lineIndex, childIndex],
                  match: { ...match, start: match.start - start, end: match.end - start },
                })
              );
          offset = end;
        });
      });
      unbound.reverse().forEach(({ path, match }) => {
        const text = (Node.get(editor, path) as Text).text;

        Transforms.insertNodes(
          editor,
          [propElement(text.slice(match.start, match.end), match.ref) as unknown as Node, { text: '' }],
          {
            at: { anchor: { path, offset: match.start }, focus: { path, offset: match.end } },
          }
        );
      });
    });

  if (HistoryEditor.isHistoryEditor(editor) && editor.history.undos.length === 0)
    HistoryEditor.withoutSaving(editor, apply);
  else withFormulaHistoryBatch(editor, apply, true);
  if (selection)
    Transforms.select(editor, {
      anchor: offsetToPoint(editor, selection.start),
      focus: offsetToPoint(editor, selection.end),
    });
}

/** Inline property chips carry canonical source through typing, clipboard and drag operations. */
export function withFormulaTokens<T extends Editor>(editor: T): T {
  const { insertText, isInline, isVoid, normalizeNode } = editor;

  editor.isInline = (element) => element.type === FORMULA_PROP || isInline(element);
  editor.isVoid = (element) => element.type === FORMULA_PROP || isVoid(element);
  editor.normalizeNode = (entry) => {
    const [node, path] = entry;

    if (path.length === 0 && editor.children.length === 0) {
      Transforms.insertNodes(editor, sourceToNodes(''), { at: [0] });
      return;
    }

    if (path.length === 1 && !isFormulaLine(node)) {
      if (Text.isText(node))
        Transforms.wrapNodes(editor, { type: FORMULA_LINE, children: [] } as unknown as Element, { at: path });
      else Transforms.setNodes(editor, { type: FORMULA_LINE } as Partial<Element>, { at: path });
      return;
    }

    if (path.length === 2 && Element.isElement(node) && !isFormulaProp(node)) {
      Transforms.unwrapNodes(editor, { at: path });
      return;
    }

    normalizeNode(entry);
  };

  editor.setFragmentData = (data) => {
    if (typeof data.clearData === 'function') data.clearData();
    data.setData('text/plain', selectedSource(editor));
  };

  editor.insertData = (data) => {
    if (!Array.from(data.types ?? []).includes('text/plain') && !data.getData('text/plain')) return;
    insertSource(editor, data.getData('text/plain'));
  };

  editor.insertText = (text, options) => {
    insertText(text.split('\uFEFF').join(''), options);
  };

  return editor;
}
