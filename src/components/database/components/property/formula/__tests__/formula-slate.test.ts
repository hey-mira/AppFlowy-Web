import { createEditor, Editor, Transforms } from 'slate';
import { withHistory } from 'slate-history';

import {
  editorSource,
  ejectCaretFromToken,
  FORMULA_PROP,
  FormulaPropElement,
  moveCaret,
  offsetToPoint,
  pointToOffset,
  remapOffset,
  replaceSourceRange,
  resetSource,
  selectedSource,
  selectionOffsets,
  sourceToNodes,
  synchronizeFormulaTokens,
  tokenRangeAt,
  withFormulaTokens,
} from '../formula-slate';

import type { Token } from '@notion-formula/sdk';

// Explicit native-token fixtures only exercise Slate manipulation.
// Real-WASM browser tests cover reference recognition and property name binding.
const referenceFixtures: Record<string, Array<[number, number]>> = {
  'if(prop("Done"),\n  prop("Price") * 2,\n  0)': [
    [3, 15],
    [19, 32],
  ],
  '1 + prop("Price")': [[4, 17]],
  'a\nprop("B") + c': [[2, 11]],
  'upper(prop("Price"))': [[6, 19]],
  'x + prop("A") +\n prop("B")': [
    [4, 13],
    [17, 26],
  ],
  'prop("A")': [[0, 9]],
  'prop("A") + 1': [[0, 9]],
  '1 + prop("Price") * 2': [[4, 17]],
  'prop("A")\n2': [[0, 9]],
  'upper(prop("Name"))': [[6, 18]],
  '1 + prop("Price") + 2': [[4, 17]],
  'max(prop("Price"), 3)': [[4, 17]],
  'prop("Price") +\n prop("Amount")\n2': [
    [0, 13],
    [17, 31],
  ],
  'prop("Price") + prop("Amount")': [
    [0, 13],
    [16, 30],
  ],
  'prop("Notes")': [[0, 13]],
  'prop("Price")prop("Amount")': [
    [0, 13],
    [13, 27],
  ],
  'prop("Price") * prop("Amount")': [
    [0, 13],
    [16, 30],
  ],
  '1 + prop("Price") *\nprop("Amount")': [
    [4, 17],
    [20, 34],
  ],
  'pi() * prop("Amount") ^ 2': [[7, 21]],
  '1\n+ prop("Price") * 2': [[4, 17]],
  [String.raw`prop("bad\\q")`]: [[0, 14]],
};

function nativeTokens(source: string): Token[] {
  return (referenceFixtures[source] ?? []).flatMap(([start, end]) => [
    { kind: 'Ident', text: 'prop', span: { start, end: start + 4 } },
    { kind: 'OpenParen', text: '(', span: { start: start + 4, end: start + 5 } },
    {
      kind: 'String',
      text: source.slice(start + 5, end - 1),
      span: { start: start + 5, end: end - 1 },
    },
    { kind: 'CloseParen', text: ')', span: { start: end - 1, end } },
  ]);
}

function makeEditor(source = '') {
  const editor = withFormulaTokens(withHistory(createEditor()));
  editor.children = sourceToNodes(source, nativeTokens(source));
  Editor.normalize(editor, { force: true });
  Transforms.select(editor, offsetToPoint(editor, source.length));
  return editor;
}

function refreshTokens(editor: Editor) {
  synchronizeFormulaTokens(editor, nativeTokens(editorSource(editor)));
}

function tokens(editor: Editor): FormulaPropElement[] {
  return Array.from(
    Editor.nodes(editor, { at: [], match: (node) => (node as { type?: string }).type === FORMULA_PROP })
  ).map(([node]) => node as unknown as FormulaPropElement);
}

function type(editor: Editor, text: string) {
  for (const ch of text) Editor.insertText(editor, ch);
}

describe('formula slate document', () => {
  it('round-trips multi-line source with tokens', () => {
    const source = 'if(prop("Done"),\n  prop("Price") * 2,\n  0)';
    const editor = makeEditor(source);

    expect(editorSource(editor)).toBe(source);
    expect(tokens(editor).map((token) => token.ref)).toEqual(['Done', 'Price']);
  });

  it.each([
    { source: String.raw`prop("bad\q")`, refs: [] },
    { source: String.raw`prop("bad\\q")`, refs: [String.raw`bad\q`] },
  ])('preserves raw source with only valid native property tokens in $source', ({ source, refs }) => {
    const editor = makeEditor(source);

    expect(editorSource(editor)).toBe(source);
    expect(tokens(editor).map((token) => ({ ref: token.ref, source: token.source }))).toEqual(
      refs.map((ref) => ({ ref, source }))
    );
    expect(selectionOffsets(editor)).toEqual({ start: source.length, end: source.length });
    Transforms.select(editor, []);
    expect(selectedSource(editor)).toBe(source);
    Editor.deleteFragment(editor);
    expect(editorSource(editor)).toBe('');
    editor.undo();
    expect(editorSource(editor)).toBe(source);
    expect(tokens(editor).map((token) => token.ref)).toEqual(refs);
  });

  it('deletes a token as one unit with Backspace', () => {
    const editor = makeEditor('1 + prop("Price")');

    Editor.deleteBackward(editor, { unit: 'character' });
    expect(editorSource(editor)).toBe('1 + ');
    expect(tokens(editor)).toHaveLength(0);
  });

  it('maps offsets around tokens and snaps offsets inside a token to its end', () => {
    const editor = makeEditor('a\nprop("B") + c');

    expect(pointToOffset(editor, offsetToPoint(editor, 2))).toBe(2);
    expect(pointToOffset(editor, offsetToPoint(editor, 5))).toBe(11);
    expect(pointToOffset(editor, offsetToPoint(editor, 11))).toBe(11);
    expect(pointToOffset(editor, offsetToPoint(editor, 15))).toBe(15);
  });

  it('replaces a source range, tokenizing inserted references and placing the caret', () => {
    const editor = makeEditor('upper(ri)');

    replaceSourceRange(editor, 6, 8, 'prop("Price")', 13);
    refreshTokens(editor);
    expect(editorSource(editor)).toBe('upper(prop("Price"))');
    expect(tokens(editor)).toHaveLength(1);
    expect(selectionOffsets(editor)).toEqual({ start: 19, end: 19 });
  });

  it('pastes multi-line source as lines and tokens', () => {
    const editor = makeEditor('x + ');
    const data = { getData: () => 'prop("A") +\n prop("B")' } as unknown as DataTransfer;

    editor.insertData(data);
    refreshTokens(editor);
    expect(editorSource(editor)).toBe('x + prop("A") +\n prop("B")');
    expect(tokens(editor)).toHaveLength(2);
  });

  it('pastes after a token when the caret sits inside it', () => {
    // Chrome can give a paste a target range inside a token's spacer.
    const editor = makeEditor('prop("A")');

    Transforms.select(editor, { path: [0, 1, 0], offset: 0 });
    editor.insertData({ getData: () => ' + 1' } as unknown as DataTransfer);
    expect(editorSource(editor)).toBe('prop("A") + 1');
    expect(tokens(editor)).toHaveLength(1);
  });

  it('replaces a whole token when a pasted-over selection starts inside it', () => {
    const editor = makeEditor('prop("A") + 1');

    Transforms.select(editor, { anchor: { path: [0, 1, 0], offset: 0 }, focus: offsetToPoint(editor, 13) });
    editor.insertData({ getData: () => '2' } as unknown as DataTransfer);
    expect(editorSource(editor)).toBe('2');
    expect(tokens(editor)).toHaveLength(0);
  });

  it('copies tokens out as prop() calls', () => {
    const editor = makeEditor('1 + prop("Price") * 2');
    let copied = '';

    Transforms.select(editor, { anchor: offsetToPoint(editor, 4), focus: offsetToPoint(editor, 21) });
    editor.setFragmentData({ setData: (_: string, text: string) => (copied = text) } as unknown as DataTransfer);
    expect(copied).toBe('prop("Price") * 2');
    expect(selectedSource(editor)).toBe('prop("Price") * 2');
  });

  it('resets to new source and undoes edits', () => {
    const editor = makeEditor('1');

    resetSource(editor, 'prop("A")\n2', 3);
    refreshTokens(editor);
    expect(editorSource(editor)).toBe('prop("A")\n2');
    expect(tokens(editor)).toHaveLength(1);
    type(editor, 'x');
    editor.undo();
    expect(editorSource(editor)).toBe('prop("A")\n2');
  });

  it('moves the caret over a whole token with the arrow keys', () => {
    const editor = makeEditor('upper(prop("Name"))');

    expect(moveCaret(editor, true)).toBe(true);
    expect(selectionOffsets(editor)).toEqual({ start: 18, end: 18 });
    moveCaret(editor, true);
    expect(selectionOffsets(editor)).toEqual({ start: 6, end: 6 });
    moveCaret(editor, false);
    expect(selectionOffsets(editor)).toEqual({ start: 18, end: 18 });
    Transforms.select(editor, offsetToPoint(editor, 0));
    expect(moveCaret(editor, true)).toBe(false);
  });

  it('moves a caret inside a token to after it', () => {
    const editor = makeEditor('prop("A") + 1');

    Transforms.select(editor, { path: [0, 1, 0], offset: 0 });
    ejectCaretFromToken(editor);
    expect(selectionOffsets(editor)).toEqual({ start: 9, end: 9 });
    expect(editor.selection?.anchor.path).toEqual([0, 2]);
  });

  it('extends the selection over a whole token with Shift+Arrow', () => {
    const editor = makeEditor('1 + prop("Price") + 2');

    for (let i = 0; i < 4; i += 1) moveCaret(editor, true, true);
    expect(selectedSource(editor)).toBe(' + 2');
    moveCaret(editor, true, true);
    expect(selectedSource(editor)).toBe('prop("Price") + 2');
    Editor.deleteFragment(editor);
    expect(editorSource(editor)).toBe('1 + ');
  });
});

describe('formula copy and paste', () => {
  function pasteEditor(source = '', caret = source.length) {
    const editor = makeEditor(source);
    Transforms.select(editor, offsetToPoint(editor, caret));
    return editor;
  }
  function paste(editor: Editor, text: string) {
    editor.insertData({ getData: () => text } as unknown as DataTransfer);
    refreshTokens(editor);
  }
  function copyAll(editor: Editor): string {
    let copied = '';
    Transforms.select(editor, []);
    editor.setFragmentData({ setData: (_: string, text: string) => (copied = text) } as unknown as DataTransfer);
    return copied;
  }
  it.each([
    ['a lone reference', 'prop("Price")'],
    ['two adjacent references', 'prop("Price")prop("Amount")'],
    ['a reference whose name has quotes', 'prop("Say \\"hi\\"") + 1'],
    ['a reference in single quotes', "prop('Price') * 2"],
    ['a reference with padding', 'prop( "Price" ) * 2'],
    ['a non-Latin name', 'prop("状态") == "Done"'],
    ['a missing property', 'prop("Nope") + prop("Price")'],
    ['a reference into another database', 'prop("Name").prop("Price")'],
    ['a comment and a string that look like references', '/* prop("Price") */ "prop(\\"Price\\")" + prop("Price")'],
    ['blank lines and trailing newline', 'prop("Price")\n\n  * 2\n'],
    [
      'deep nesting',
      'if(empty(prop("Notes")), round(abs(prop("Price") - prop("Amount")) ^ 2, 1), max([prop("Price"), 0]))',
    ],
    ['a map with a variable', 'map([1, 2], current * prop("Price"))'],
  ])('round-trips %s', (_, source) => {
    const from = pasteEditor(source);
    const copied = copyAll(from);

    expect(copied).toBe(source);
    const to = pasteEditor();

    paste(to, copied);
    expect(editorSource(to)).toBe(source);
  });

  it('pastes the copy of part of a formula into the middle of another', () => {
    const from = pasteEditor('1 + prop("Price") * 2');

    Transforms.select(from, { anchor: offsetToPoint(from, 4), focus: offsetToPoint(from, 17) });
    let copied = '';

    from.setFragmentData({ setData: (_: string, text: string) => (copied = text) } as unknown as DataTransfer);
    const to = pasteEditor('max(, 3)', 4);

    paste(to, copied);
    expect(editorSource(to)).toBe('max(prop("Price"), 3)');
    expect(tokens(to)).toHaveLength(1);
    expect(selectionOffsets(to)).toEqual({ start: 17, end: 17 });
  });

  it('turns Windows line endings into lines', () => {
    const editor = pasteEditor();

    paste(editor, 'prop("Price") +\r\n prop("Amount")\r2');
    expect(editorSource(editor)).toBe('prop("Price") +\n prop("Amount")\n2');
    expect(editor.children).toHaveLength(3);
    expect(tokens(editor)).toHaveLength(2);
  });

  it('replaces a selection that covers tokens', () => {
    const editor = pasteEditor('prop("Price") + prop("Amount")');

    Transforms.select(editor, []);
    paste(editor, 'prop("Notes")');
    expect(editorSource(editor)).toBe('prop("Notes")');
    expect(tokens(editor).map((token) => token.ref)).toEqual(['Notes']);
  });

  it('deletes the selection on an empty paste', () => {
    const editor = pasteEditor('1 + prop("Price")');

    Transforms.select(editor, []);
    editor.insertData({ types: ['text/plain'], getData: () => '' } as unknown as DataTransfer);
    expect(editorSource(editor)).toBe('');
  });

  it('ignores a paste with no plain text', () => {
    const editor = pasteEditor('1');

    editor.insertData({ types: ['text/html'], getData: () => '' } as unknown as DataTransfer);
    expect(editorSource(editor)).toBe('1');
  });

  it('pastes between two tokens', () => {
    const editor = pasteEditor('prop("Price")prop("Amount")', 13);

    paste(editor, ' * ');
    expect(editorSource(editor)).toBe('prop("Price") * prop("Amount")');
    expect(tokens(editor)).toHaveLength(2);
  });

  it('undoes a paste in one step', () => {
    const editor = pasteEditor('1 + ');

    paste(editor, 'prop("Price") *\nprop("Amount")');
    expect(editorSource(editor)).toBe('1 + prop("Price") *\nprop("Amount")');
    editor.undo();
    expect(editorSource(editor)).toBe('1 + ');
    expect(tokens(editor)).toHaveLength(0);
    editor.redo();
    expect(editorSource(editor)).toBe('1 + prop("Price") *\nprop("Amount")');
    expect(tokens(editor)).toHaveLength(2);
  });

  it('copies and pastes back the same formula twice over', () => {
    const source = 'pi() * prop("Amount") ^ 2';
    const editor = pasteEditor(source);
    const first = copyAll(editor);

    Editor.deleteFragment(editor);
    paste(editor, first);
    const second = copyAll(editor);

    Editor.deleteFragment(editor);
    paste(editor, second);
    expect(second).toBe(source);
    expect(editorSource(editor)).toBe(source);
    expect(tokens(editor)).toHaveLength(1);
  });
});

describe('remapOffset', () => {
  const before = 'prop("Price") * 25 + 3';

  const after = 'prop("Cost") * 25 + 3';

  it('keeps an offset in the text before or after a change', () => {
    expect(remapOffset(before, after, 3)).toBe(3);
    expect(remapOffset(before, after, 'prop("Price") * 25'.length)).toBe('prop("Cost") * 25'.length);
    expect(remapOffset(before, after, before.length)).toBe(after.length);
    expect(remapOffset(before, before, 9)).toBe(9);
  });

  it('moves an offset inside the change after its replacement', () => {
    expect(remapOffset(before, after, 'prop("Pr'.length)).toBe('prop("Cost'.length);
    expect(remapOffset('ab', 'aXYb', 2)).toBe(4);
    expect(remapOffset('abc', 'c', 1)).toBe(0);
  });
});

/** A DataTransfer: jsdom has none. */
class FakeDataTransfer {
  private store = new Map<string, string>();

  constructor(init: Record<string, string> = {}) {
    Object.entries(init).forEach(([type, value]) => this.store.set(type, value));
  }

  get types() {
    return Array.from(this.store.keys());
  }

  getData(type: string) {
    return this.store.get(type) ?? '';
  }

  setData(type: string, value: string) {
    this.store.set(type, value);
  }

  clearData() {
    this.store.clear();
  }

  asDataTransfer() {
    return this as unknown as DataTransfer;
  }
}

describe('formula clipboard data', () => {
  it('carries only the formula source, not what the browser put in a drag first', () => {
    const editor = makeEditor('1 + prop("Price") * 2');
    // A selection drag starts with the selection's text and HTML: the token's name.
    const data = new FakeDataTransfer({ 'text/plain': '1 + Price * 2', 'text/html': '1 + <span>Price</span> * 2' });

    Transforms.select(editor, []);
    editor.setFragmentData(data.asDataTransfer());
    expect(data.types).toEqual(['text/plain']);
    expect(data.getData('text/plain')).toBe('1 + prop("Price") * 2');
  });

  it('finds the source range of the token at a path', () => {
    const editor = makeEditor('1\n+ prop("Price") * 2');

    expect(tokenRangeAt(editor, [1, 1])).toEqual({ start: 4, end: 17 });
    expect(tokenRangeAt(editor, [1, 1, 0])).toEqual({ start: 4, end: 17 });
    expect(tokenRangeAt(editor, [1, 0])).toBeNull();
    expect(tokenRangeAt(editor, [5])).toBeNull();
  });
});

describe('typed-in text taken off the editor', () => {
  it('reads text holding the zero-width marks drawn beside tokens the way a paste is read', () => {
    // What a macOS kill ring holds for a selection with a token: its name and the marks.
    const editor = makeEditor('1 + ');

    Editor.insertText(editor, 'Price\uFEFF * 2');
    expect(editorSource(editor)).toBe('1 + Price * 2');
    expect(tokens(editor)).toHaveLength(0);
    editor.undo();
    expect(editorSource(editor)).toBe('1 + ');
  });

  it('inserts other text as it is', () => {
    const editor = makeEditor('1 + ');

    Editor.insertText(editor, 'Price');
    expect(editorSource(editor)).toBe('1 + Price');
    expect(tokens(editor)).toHaveLength(0);
  });
});
