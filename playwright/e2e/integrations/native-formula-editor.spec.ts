import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { test } from '../../support/native-formula-editor-server';

import type { Locator, Page } from '@playwright/test';
import type { Token } from '@notion-formula/sdk';

test.use({ timezoneId: 'Asia/Singapore' });

type Evidence = {
  workers: number;
  terminated: number;
  held: boolean;
  clockOwners: number;
  requests: Array<{ worker: number; method: string; args: unknown[] }>;
  replies: Array<{ worker: number; method: string; value: unknown }>;
  observed: Array<{ source: string; preview: string; diagnostics: string }>;
  external: {
    bindings: number;
    releases: number;
    owners: number;
    metadataObservers: number;
    rowObservers: number;
    pendingSources: number;
    sourceReturns: number;
  };
};

type ExternalPreviewFixture = {
  enableExternalSources: (options?: { cold?: boolean; clock?: boolean; people?: boolean }) => void;
  holdSource: (kind: 'metadata' | 'row') => void;
  releaseSource: () => void;
  setRemoteExpression: (expression: string) => void;
};

type MemberPreviewFixture = {
  setMemberName: (name: string) => Promise<void>;
  trackClockSubscriptions: () => void;
};

type TokenInspection = {
  references: Array<{ ref: string; start: number; end: number; idSpan: { start: number; end: number } }>;
  tokens: Token[];
  diagnostics: unknown[];
  display: string;
};

type TokenEditorFixture = {
  inspectExpression: (expression: string, source?: string) => Promise<TokenInspection>;
  encodeFormulaString: (value: string) => string;
  addTextProperty: (id: string, name: string, value: string) => void;
  holdNextReply: (method: string) => void;
  setSavedExpression: (expression: string) => void;
  fields: Map<string, Map<string, unknown>>;
};

async function inspectExpression(page: Page, expression: string, source?: string) {
  return page.evaluate(
    ({ expression, source }) =>
      (window as unknown as { editorFixture: TokenEditorFixture }).editorFixture.inspectExpression(expression, source),
    { expression, source }
  );
}

async function enableExternalPreview(page: Page, options: { cold?: boolean; clock?: boolean; people?: boolean } = {}) {
  await page.getByRole('button', { name: 'Close consumers', exact: true }).click();
  await page.evaluate((options) => {
    (window as unknown as { editorFixture: ExternalPreviewFixture }).editorFixture.enableExternalSources(options);
  }, options);
  await expect(page.getByTestId('formula-catalogue-property-rollup')).toBeVisible();
}

const evidence = (page: Page) => page.evaluate(() => (window as unknown as { editorEvidence: Evidence }).editorEvidence);

async function replaceSource(input: Locator, source: string) {
  await expect(input).toBeEditable();
  await expect(input).toHaveAttribute('contenteditable', 'true');
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await input.pressSequentially(source, { delay: 0 });
}

async function pasteSource(input: Locator, source: string) {
  await input.evaluate((element, text) => {
    const data = new DataTransfer();

    data.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, source);
}

async function copySelection(input: Locator) {
  return input.evaluate((element) => {
    const data = new DataTransfer();

    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  });
}

test.beforeEach(async ({ page, formulaURL, formulaHTML }) => {
  await page.route('**/native-formula-editor-fixture*', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/native-formula-editor-fixture', formulaURL).href);
  await expect(page.getByTestId('committed-total')).toHaveText('25');
  await expect(page.getByTestId('formula-editor-input')).toBeVisible();
  await expect(page.getByTestId('formula-editor-input')).toBeEditable();
});

test.afterEach(async ({ page }, testInfo) => {
  const artifact = {
    scenario: testInfo.title,
    status: testInfo.status,
    profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
    browser: await page.evaluate(() => navigator.userAgent),
    timezone: 'Asia/Singapore',
    saved: await page
      .getByTestId('saved-expression')
      .textContent({ timeout: 1000 })
      .catch(() => null),
    evidence: await evidence(page),
  };
  const json = testInfo.outputPath('native-formula-editor-evidence.json');
  const screenshot = testInfo.outputPath('native-formula-editor.png');

  await writeFile(
    json,
    JSON.stringify(artifact, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value), 2)
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-editor-evidence.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-editor.png', { path: screenshot, contentType: 'image/png' });
});

// Failure modes at the browser seam: a JS checker/completer/evaluator still
// runs; editing blocks the committed Engine; formulas disappear from property
// completion; saving stores names; cancellation writes Yjs; one-row runtime
// errors prohibit a statically valid save; a Worker is created on each edit.
test('displays native Union and Unknown types without losing their structure', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');
  const cases = [
    ['42', 'number'],
    ['"text"', 'text'],
    ['true', 'boolean'],
    ['today()', 'date'],
    ['[1, 2]', 'list<number>'],
    ['[1, "x"]', 'list<number | text>'],
    ['[[1, "x"]]', 'list<list<number | text>>'],
    ['if(true, 1, "x")', 'number | text'],
    ['[]', 'list<unknown>'],
    ['empty()', 'unknown'],
  ];

  for (const [expression, expected] of cases) {
    await replaceSource(input, expression);
    await expect(page.getByTestId('formula-editor-type'), expression).toHaveText(`Type: ${expected}`);
    await expect(page.getByTestId('formula-editor-error'), expression).toHaveCount(0);
  }
});

test('Draft completion and candidate preview remain isolated from saved formulas', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');
  const saved = page.getByTestId('saved-expression');

  await expect
    .poll(async () => (await evidence(page)).requests.some((request) => request.method === 'draft.getState'))
    .toBe(true);
  await replaceSource(input, 'sub');
  await expect(page.getByTestId('formula-suggestion-Subtotal')).toBeVisible();
  await page.getByTestId('formula-suggestion-Subtotal').click();
  await expect(input).toHaveAttribute('data-value', 'prop("subtotal")');
  await expect(page.getByTestId('formula-token')).toHaveAttribute('data-ref', 'subtotal');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('20');
  await expect(saved).toHaveText('prop("subtotal") + 5');
  await page.getByRole('button', { name: 'Set Price to 15', exact: true }).click();
  await expect(page.getByTestId('committed-total')).toHaveText('35');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('30');
  await page.getByTestId('formula-editor-cancel').click();
  await expect(saved).toHaveText('prop("subtotal") + 5');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await replaceSource(input, 'test("x", "[")');
  await expect(page.getByTestId('formula-editor-error')).toContainText('InvalidRegex');
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  await page.getByTestId('formula-editor-done').click();
  await expect(saved).toHaveText('test("x", "[")');
  await expect(page.getByTestId('formula-editor')).toHaveCount(0);
  const requests = (await evidence(page)).requests;
  const committedWorkers = new Set(
    requests.filter((request) => request.method === 'engine.getProperties').map((request) => request.worker)
  );
  const previews = requests
    .filter((request) => request.method === 'engine.evaluate' && !committedWorkers.has(request.worker))
    .map((request) => request.args[0]) as Array<{
    row_ids: string[];
    runtime: { time_zone: string; now: string };
  }>;

  expect(previews.every((request) => request.row_ids.length === 1)).toBe(true);
  expect(previews.every((request) => request.runtime.time_zone === '+08:00')).toBe(true);
  expect((await evidence(page)).workers).toBeLessThanOrEqual(5);
});

// Native coordinates are UTF-16, including text before the cursor. Formatting
// and quick fixes must use version-bound native edits, preserve the result's
// cursor, and enter Slate history as one operation that undo/redo can restore.
test('Chinese and emoji survive native help, formatting, fixes and undo', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, 'if(true,"你好😀","no")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('你好😀');
  await input.press('Escape');
  await page.getByTestId('formula-editor-format').click();
  await expect(input).toHaveAttribute('data-value', 'if(true, "你好😀", "no")\n');
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', 'if(true,"你好😀","no")');
  await input.press('ControlOrMeta+Shift+z');
  await expect(input).toHaveAttribute('data-value', 'if(true, "你好😀", "no")\n');
  await replaceSource(input, 'if(true, "你好😀", "no"');
  await expect(page.getByTestId('formula-signature-help')).toContainText('if');
  await expect(page.getByTestId('formula-editor-quick-fix').first()).toBeVisible();
  await input.press('Escape');
  await page.getByTestId('formula-editor-quick-fix').first().click();
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('你好😀');
  const helpRequests = (await evidence(page)).requests.filter((request) => request.method === 'draft.help');

  expect(helpRequests.some((request) => request.args[1] === 'if(true, "你好😀", "no"'.length)).toBe(true);
});

// A property's displayed name is not its binding. Typed/pasted prop("Label")
// binds against the edit's schema before a rename/name reuse; canonical copied
// source stays bound, and asynchronous tokenization cannot erase undo history.
test('renames, name reuse and pasted references keep IDs through undo and redo', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, 'prop("Price") * 2');
  await expect(input).toHaveAttribute('data-value', 'prop("price") * 2');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('20');
  await input.press('End');
  await pasteSource(input, ' + 1');
  await expect(input).toHaveAttribute('data-value', 'prop("price") * 2 + 1');
  await page.getByRole('button', { name: 'Rename and reuse Price', exact: true }).click();
  await expect(page.getByTestId('formula-token')).toHaveText('金额💰');
  await expect(input).toHaveAttribute('data-value', 'prop("price") * 2 + 1');
  await input.click();
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', 'prop("price") * 2');
  await input.press('ControlOrMeta+Shift+z');
  await expect(input).toHaveAttribute('data-value', 'prop("price") * 2 + 1');
  await pasteSource(input, ' + prop("price")');
  await expect(page.getByTestId('formula-token')).toHaveCount(2);
  await expect(page.getByTestId('formula-preview-value')).toHaveText('31');
  await page.getByRole('button', { name: 'Remove Price', exact: true }).click();
  await expect(page.getByTestId('formula-token').first()).toHaveAttribute('data-missing', 'true');
  await expect(page.getByTestId('formula-editor-done')).toBeDisabled();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
});

// Holding actual Worker replies exposes three separate revisions: a bigint
// Draft version, local edit/caret changes, and collaborative schema changes.
// Old help, edits and preview results must never overwrite current local text.
test('held native help and preview replies cannot overwrite newer edits', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await page.getByRole('button', { name: 'Hold next help', exact: true }).click();
  await replaceSource(input, 'rou');
  await expect.poll(async () => (await evidence(page)).held).toBe(true);
  await replaceSource(input, '42');
  await page.getByRole('button', { name: 'Release reply', exact: true }).click();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('42');
  await expect(input).toHaveAttribute('data-value', '42');
  await expect(page.getByTestId('formula-suggestion-round()')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hold next preview', exact: true }).click();
  await replaceSource(input, '43');
  await expect.poll(async () => (await evidence(page)).held).toBe(true);
  const observedBefore = (await evidence(page)).observed.length;

  await replaceSource(input, '44');
  await page.getByRole('button', { name: 'Release reply', exact: true }).click();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('44');
  expect((await evidence(page)).observed.slice(observedBefore).map((entry) => entry.preview)).not.toContain('43');
  await expect(input).toHaveAttribute('data-value', '44');
  await page.getByRole('button', { name: 'Hold next format', exact: true }).click();
  await page.getByTestId('formula-editor-format').click();
  await expect.poll(async () => (await evidence(page)).held).toBe(true);
  await replaceSource(input, '45');
  await page.getByRole('button', { name: 'Release reply', exact: true }).click();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('45');
  await expect(input).toHaveAttribute('data-value', '45');
});

test('a schema change during save forces fresh native validation', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, 'prop("price") * 2');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('20');
  await page.getByRole('button', { name: 'Hold next save', exact: true }).click();
  await page.getByTestId('formula-editor-done').click();
  await expect.poll(async () => (await evidence(page)).held).toBe(true);
  await page.getByRole('button', { name: 'Remove Price', exact: true }).click();
  await page.getByRole('button', { name: 'Release reply', exact: true }).click();
  await expect(page.getByTestId('formula-editor-done')).toBeDisabled();
  await expect(page.getByTestId('formula-editor-error')).toBeVisible();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
  await expect(input).toHaveAttribute('data-value', 'prop("price") * 2');
});

test('canonical copied chips remain bound when a display name is reused', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, 'prop("Price")');
  await expect(input).toHaveAttribute('data-value', 'prop("price")');
  await expect(page.getByTestId('formula-token')).toHaveCount(1);
  await input.press('ControlOrMeta+a');
  const copied = await input.evaluate((element) => {
    const data = new DataTransfer();

    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    Object.assign(window, { copiedFormula: data });
    return data.getData('text/plain');
  });

  expect(copied).toBe('prop("price")');
  await page.getByRole('button', { name: 'Rename and reuse Price', exact: true }).click();
  await input.click();
  await input.press('End');
  await pasteSource(input, ' + ');
  await expect(input).toHaveAttribute('data-value', 'prop("price") + ');
  await input.evaluate((element) =>
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: (window as unknown as { copiedFormula: DataTransfer }).copiedFormula,
        bubbles: true,
        cancelable: true,
      })
    )
  );
  await expect(input).toHaveAttribute('data-value', 'prop("price") + prop("price")');
  await expect(page.getByTestId('formula-token')).toHaveCount(2);
  await expect(page.getByTestId('formula-preview-value')).toHaveText('20');
  await page.getByTestId('formula-editor-done').click();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("price") + prop("price")');
});

// Current host behavior uses the latest local save for formula text only.
// Concurrent remote text must not erase local edits/history; remote format
// options survive, and a deleted/retyped target cannot be written as Formula.
test('save revalidates current fields and preserves the local-save policy', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, 'prop("subtotal") + 7');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('27');
  await page.getByRole('button', { name: 'Remote formula and format', exact: true }).click();
  await expect(input).toHaveAttribute('data-value', 'prop("subtotal") + 7');
  await expect(page.getByTestId('saved-expression')).toHaveText('100');
  await page.getByTestId('formula-editor-done').click();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 7');
  await expect(page.getByTestId('saved-format')).toHaveText('2');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await replaceSource(input, 'prop("price") * 2');
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  await page.getByRole('button', { name: 'Retype Price as text', exact: true }).click();
  await expect(page.getByTestId('formula-editor-error')).toContainText('InvalidValueType');
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  await expect(input).toHaveAttribute('data-value', 'prop("price") * 2');
  await replaceSource(input, '10');
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  await page.getByRole('button', { name: 'Retype Total as text', exact: true }).click();
  await expect(page.getByTestId('formula-editor-done')).toBeDisabled();
  await expect(page.getByTestId('formula-editor-error')).toBeVisible();
});

// A historical context owns an independent Engine and immutable row snapshot.
// Switching context must dispose old editor/preview Workers without remounting
// Slate, preserve local edits/history, and never let Done write history Yjs.
test('historical preview remains isolated and editor Workers close on cancel', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, 'prop("price") * 3');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('30');
  await page.getByRole('button', { name: 'Switch to history', exact: true }).click();
  await expect(input).toHaveAttribute('data-value', 'prop("price") * 3');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('30');
  await page.getByRole('button', { name: 'Set Price to 15', exact: true }).click();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('30');
  await expect(page.getByTestId('formula-editor-done')).toBeDisabled();
  await input.click();
  await input.press('ControlOrMeta+z');
  await expect(input).not.toHaveAttribute('data-value', 'prop("price") * 3');
  await page.getByTestId('formula-editor-cancel').click();
  await page.getByRole('button', { name: 'Close consumers', exact: true }).click();
  await expect
    .poll(async () => {
      const current = await evidence(page);

      return current.terminated === current.workers;
    })
    .toBe(true);
});

test('native token source distinguishes strings and multiline comments', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');
  const source =
    '/* prop("Price")\r\nprop("Quantity") */\r\nif(true, "prop(\\"Price\\")😀", prop( /* keep */ "Price" ))';

  await replaceSource(input, '');
  await pasteSource(input, source);
  await expect(input).toHaveAttribute(
    'data-value',
    source.replace(/\r\n/g, '\n').replace('/* keep */ "Price"', '/* keep */ "price"')
  );
  await expect(page.getByTestId('formula-token')).toHaveCount(1);
  await expect(page.getByTestId('formula-token')).toHaveAttribute('data-ref', 'price');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('prop("Price")😀');
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', '');
  await input.press('ControlOrMeta+Shift+z');
  await expect(page.getByTestId('formula-token')).toHaveCount(1);
  await replaceSource(input, '');
  await pasteSource(input, 'Price * 2');
  await expect(input).toHaveAttribute('data-value', 'Price * 2');
  await expect(page.getByTestId('formula-token')).toHaveCount(0);
  await expect(page.getByTestId('formula-preview-value')).toHaveAttribute('data-evaluation-state', 'not-ready');
  await expect(page.getByTestId('formula-editor-error')).toContainText('Formula is not ready');
});

test('real native tokens recognize complete prop calls while syntax errors still block saving', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');
  const cases: Array<{
    source: string;
    refs: string[];
    chips?: string[];
    invalid?: boolean;
    unterminatedString?: boolean;
  }> = [
    { source: '["price", format(prop("price"))]', refs: ['price'] },
    { source: '"😀" + prop /*before*/ ( /*inside*/ "price" /*after*/ )', refs: ['price'] },
    { source: 'prop(\n/* inside */ "price"\n)', refs: ['price'], chips: [] },
    { source: '/* prop("price") */ "prop(\\"price\\")"', refs: [] },
    { source: 'prop("price")prop("quantity")', refs: ['price', 'quantity'], invalid: true },
    {
      source: 'prop("missing") + prop("price") + prop("missing")',
      refs: ['missing', 'price', 'missing'],
      invalid: true,
    },
    { source: 'prop("")', refs: [''], invalid: true },
    { source: 'prop("price", "quantity")', refs: [], invalid: true },
    { source: 'prop("price" + "")', refs: [], invalid: true },
    { source: 'prop()', refs: [], invalid: true },
    { source: 'prop("price"', refs: [], invalid: true, unterminatedString: false },
    { source: 'prop("price)', refs: [], invalid: true, unterminatedString: true },
    { source: "prop('price')", refs: [], invalid: true },
    { source: 'prop("price\')', refs: [], invalid: true, unterminatedString: true },
    { source: 'prop("price\\)', refs: [], invalid: true, unterminatedString: true },
    { source: 'prop("price\\', refs: [], invalid: true, unterminatedString: true },
    { source: String.raw`prop("bad\q")`, refs: ['badq'], invalid: true },
    { source: String.raw`prop("bad\\q")`, refs: [String.raw`bad\q`], invalid: true },
    { source: String.raw`prop("bad\u0061")`, refs: ['badu0061'], invalid: true },
    { source: String.raw`prop("bad\r")`, refs: ['badr'], invalid: true },
    { source: String.raw`prop("bad\'")`, refs: ["bad'"], invalid: true },
    { source: String.raw`prop("\price")`, refs: ['price'], invalid: false },
    { source: '"x" /* receiver */ . /* member */ prop("price")', refs: [], invalid: true },
    { source: 'prop("price").prop("other")', refs: ['price'], invalid: true },
  ];

  for (const { source, refs, chips = refs, invalid, unterminatedString } of cases) {
    const inspection = await inspectExpression(page, source);
    const workerState = (await evidence(page)).replies
      .filter((reply) => reply.method === 'draft.getState')
      .map(
        (reply) => reply.value as { definition: { expression: string }; tokens: Token[]; diagnostics: unknown[] }
      )
      .reverse()
      .find((state) => state.definition.expression === source);

    expect(workerState?.tokens, source).toEqual(inspection.tokens);
    for (const token of workerState?.tokens ?? []) {
      expect(Object.keys(token).sort(), source).toEqual(['kind', 'span', 'text']);
      expect(token.text, source).toBe(source.slice(token.span.start, token.span.end));
    }

    if (unterminatedString) {
      const unterminatedDiagnostic = expect.arrayContaining([
        expect.objectContaining({
          message: 'unterminated string literal',
          span: { start: source.indexOf('"'), end: source.length },
        }),
      ]);

      expect(inspection.diagnostics, source).toEqual(unterminatedDiagnostic);
      expect(workerState?.diagnostics, source).toEqual(unterminatedDiagnostic);
      expect(inspection.tokens.some(({ kind }) => kind === 'String'), source).toBe(false);
      expect(workerState?.tokens.some(({ kind }) => kind === 'String'), source).toBe(false);
    } else if (unterminatedString === false) {
      expect(inspection.tokens.some(({ kind }) => kind === 'String'), source).toBe(true);
      expect(inspection.diagnostics, source).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'unterminated string literal' })])
      );
    }

    expect(
      inspection.references.map((reference) => reference.ref),
      source
    ).toEqual(refs);
    for (const reference of inspection.references) {
      expect(source.slice(reference.start, reference.end), source).toContain('prop');
      const literal = inspection.tokens.find(
        (token) => token.span.start === reference.idSpan.start && token.span.end === reference.idSpan.end
      );

      expect(literal?.kind, source).toBe('String');
      expect(literal?.text, source).toBe(source.slice(reference.idSpan.start, reference.idSpan.end));
    }

    await replaceSource(input, '');
    await pasteSource(input, source);
    await expect(input, source).toHaveAttribute('data-value', source);
    await expect(page.getByTestId('formula-token'), source).toHaveCount(chips.length);
    expect(
      await page.getByTestId('formula-token').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-ref'))),
      source
    ).toEqual(chips);
    if (invalid) {
      expect(inspection.diagnostics.length, source).toBeGreaterThan(0);
      await expect(page.getByTestId('formula-editor-done'), source).toBeDisabled();
    } else if (invalid === false) {
      expect(inspection.diagnostics, source).toEqual([]);
      await expect(page.getByTestId('formula-editor-done'), source).toBeEnabled();
    }
  }
});

test('identity escapes bind distinct property names and preserve literal backslashes', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await page.evaluate(() => {
    const fixture = (window as unknown as { editorFixture: TokenEditorFixture }).editorFixture;

    fixture.addTextProperty('q-id', 'badq', 'identity');
    fixture.addTextProperty(String.raw`literal-\q`, String.raw`bad\q`, 'backslash');
  });
  const source = String.raw`["bad\q", "bad\\q", prop("bad\q"), prop("bad\\q")].join("|")`;
  const canonical = String.raw`["bad\q", "bad\\q", prop("q-id"), prop("literal-\\q")].join("|")`;
  const inspection = await inspectExpression(page, source);

  expect(inspection.references.map((reference) => reference.ref)).toEqual(['badq', String.raw`bad\q`]);
  expect(inspection.tokens.filter((token) => token.kind === 'String').map((token) => token.text)).toEqual([
    String.raw`"bad\q"`,
    String.raw`"bad\\q"`,
    String.raw`"bad\q"`,
    String.raw`"bad\\q"`,
    '"|"',
  ]);
  await replaceSource(input, '');
  await pasteSource(input, source);
  await expect(input).toHaveAttribute('data-value', canonical);
  await expect
    .poll(() =>
      page.getByTestId('formula-token').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-ref')))
    )
    .toEqual(['q-id', String.raw`literal-\q`]);
  await expect(page.getByTestId('formula-preview-value')).toHaveText(String.raw`badq|bad\q|identity|backslash`);
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  const bound = await inspectExpression(page, canonical);

  expect(bound.diagnostics).toEqual([]);
  expect(bound.display).toBe(String.raw`["bad\q", "bad\\q", prop("badq"), prop("bad\\q")].join("|")`);
  await input.press('ControlOrMeta+a');
  expect(await copySelection(input)).toBe(canonical);
  await page.getByTestId('formula-editor-done').click();
  await expect(page.getByTestId('saved-expression')).toHaveText(canonical);
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await expect(input).toHaveAttribute('data-value', canonical);
  await expect(page.getByTestId('formula-token')).toHaveCount(2);
  await expect(page.getByTestId('formula-preview-value')).toHaveText(String.raw`badq|bad\q|identity|backslash`);
});

test('escaped property literals bind only arguments and round-trip through rename, docs, clipboard and undo', async ({
  page,
}) => {
  const input = page.getByTestId('formula-editor-input');
  const id = 'field-"\\中文😀\n\t\b';
  const name = '名称 "path\\你好😀\n\t';
  const value = 'value "\\中文😀';
  const { idLiteral, nameLiteral } = await page.evaluate(
    ({ id, name, value }) => {
      const fixture = (window as unknown as { editorFixture: TokenEditorFixture }).editorFixture;

      fixture.addTextProperty(id, name, value);
      return { idLiteral: fixture.encodeFormulaString(id), nameLiteral: fixture.encodeFormulaString(name) };
    },
    { id, name, value }
  );
  const source = `[${nameLiteral}, prop /* keep */ (${nameLiteral})]`;
  const canonical = `[${nameLiteral}, prop /* keep */ (${idLiteral})]`;
  const inspection = await inspectExpression(page, source);

  expect(inspection.references.map((reference) => reference.ref)).toEqual([name]);
  expect(inspection.tokens.filter((token) => token.kind === 'String').map((token) => token.text)).toEqual([
    nameLiteral,
    nameLiteral,
  ]);
  expect(inspection.tokens.every((token) => source.slice(token.span.start, token.span.end) === token.text)).toBe(true);
  await replaceSource(input, '');
  await pasteSource(input, source);
  await expect(input).toHaveAttribute('data-value', canonical);
  await expect(page.getByTestId('formula-token')).toHaveAttribute('data-ref', id);
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', '');
  await input.press('ControlOrMeta+Shift+z');
  await expect(input).toHaveAttribute('data-value', canonical);
  await expect(page.getByTestId('formula-token')).toHaveCount(1);
  await input.press('ControlOrMeta+a');
  expect(await copySelection(input)).toBe(canonical);
  const bound = await inspectExpression(page, canonical);

  expect(bound.diagnostics).toEqual([]);
  expect(bound.references.map((reference) => reference.ref)).toEqual([id]);
  expect(bound.tokens.filter((token) => token.kind === 'String').map((token) => token.text)).toEqual([
    nameLiteral,
    idLiteral,
  ]);
  await page.getByTestId('formula-editor-done').click();
  await expect(page.getByTestId('saved-expression')).toHaveText(canonical);
  const renamed = '重命名 "next\\😀\n\t行';
  const renamedLiteral = await page.evaluate(
    ({ id, renamed }) => {
      const fixture = (window as unknown as { editorFixture: TokenEditorFixture }).editorFixture;

      fixture.fields.get(id)!.set('name', renamed);
      return fixture.encodeFormulaString(renamed);
    },
    { id, renamed }
  );

  await page.getByRole('button', { name: 'Property menu', exact: true }).click();
  await expect(page.getByTestId('formula-edit-formula')).toHaveText(
    `[${nameLiteral}, prop /* keep */ (${renamedLiteral})]`
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await expect(input).toHaveAttribute('data-value', canonical);
  await expect(page.getByTestId('formula-token')).toHaveText(renamed);
  await input.press('ControlOrMeta+a');
  await input.press('Escape');
  await page.getByTestId(`formula-catalogue-property-${id}`).hover();
  const example = page.getByTestId('formula-docs').locator('[data-expression]').first();

  await expect(example).toHaveAttribute('data-expression', `prop(${idLiteral})`);
  await example.click();
  await expect(input).toHaveAttribute('data-value', `prop(${idLiteral})`);
  await expect(page.getByTestId('formula-preview-value')).toHaveText(value);
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', canonical);
});

test('stale native token snapshots cannot chip or bind newer source', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');
  const stale = await inspectExpression(page, 'prop("price")', 'prop("other")');

  expect(stale.references).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as { editorFixture: TokenEditorFixture }).editorFixture.holdNextReply('draft.updateExpression')
  );
  await replaceSource(input, '');
  await pasteSource(input, 'prop("Price")');
  await expect.poll(async () => (await evidence(page)).held).toBe(true);
  await replaceSource(input, '');
  await pasteSource(input, '"Price"');
  await page.getByRole('button', { name: 'Release reply', exact: true }).click();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('Price');
  await expect(input).toHaveAttribute('data-value', '"Price"');
  await expect(page.getByTestId('formula-token')).toHaveCount(0);
});

test('startup tracking retains an unresolved saved ID matching a current display name', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await page.getByTestId('formula-editor-cancel').click();
  await page.evaluate(() => {
    const fixture = (window as unknown as { editorFixture: TokenEditorFixture }).editorFixture;

    fixture.addTextProperty('new-id', 'legacy-id', 'new field');
    fixture.setSavedExpression('prop("legacy-id")');
  });
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await expect(input).toHaveAttribute('data-value', 'prop("legacy-id")');
  await expect(page.getByTestId('formula-token')).toHaveAttribute('data-ref', 'legacy-id');
  await expect(page.getByTestId('formula-token')).toHaveAttribute('data-missing', 'true');
  await expect(page.getByTestId('formula-editor-done')).toBeDisabled();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("legacy-id")');
});

test('StrictMode effect replay keeps native editor sessions usable', async ({ page }) => {
  await page.goto(`${page.url()}?strict=1`);
  const input = page.getByTestId('formula-editor-input');

  await expect(input).toHaveAttribute('contenteditable', 'true');
  await replaceSource(input, '41 + 1');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('42');
  await page.getByTestId('formula-editor-done').click();
  await expect(page.getByTestId('saved-expression')).toHaveText('41 + 1');
});

test('chip selections survive rename, drag, cut and undo', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');
  const source = 'prop("price") * prop("quantity") + 1';
  const selected = 'prop("price") * prop("quantity")';

  await replaceSource(input, source);
  await expect(page.getByTestId('formula-token')).toHaveCount(2);
  await input.press('ControlOrMeta+Home');
  for (let index = 0; index < 5; index += 1) await input.press('Shift+ArrowRight');
  await expect.poll(() => copySelection(input)).toBe(selected);
  await page.getByRole('button', { name: 'Rename and reuse Price', exact: true }).click();
  await expect(page.getByTestId('formula-token').first()).toHaveText('金额💰');
  expect(await copySelection(input)).toBe(selected);
  const dragged = await input.evaluate((element) => {
    const data = new DataTransfer();
    const chip = element.querySelectorAll('[data-testid="formula-token"]')[1].querySelector('.truncate')!;

    data.setData('text/plain', '金额💰 * Quantity');
    chip.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }));
    const source = data.getData('text/plain');
    const leaf = Array.from(element.querySelectorAll('[data-slate-string]')).at(-1)!;
    const box = leaf.getBoundingClientRect();

    leaf.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
        clientX: box.right - 1,
        clientY: box.top + box.height / 2,
      })
    );
    return source;
  });

  expect(dragged).toBe(selected);
  await expect(input).toHaveAttribute('data-value', ` + 1${selected}`);
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', source);
  await expect(page.getByTestId('formula-token')).toHaveCount(2);
  await input.press('ControlOrMeta+a');
  const cut = await input.evaluate((element) => {
    const data = new DataTransfer();

    element.dispatchEvent(new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  });

  expect(cut).toBe(source);
  await expect(input).toHaveAttribute('data-value', '');
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', source);
  await expect(page.getByTestId('formula-token')).toHaveCount(2);
});

test('cell popover keeps the first Escape for native completion and cancels on the second', async ({ page }) => {
  await page.goto(`${page.url()}?host=popover`);
  const input = page.getByTestId('formula-editor-input');
  const host = page.getByTestId('formula-editor-dialog');

  await expect(host).toHaveAttribute('data-slot', 'popover-content');
  await replaceSource(input, 'sub');
  await expect(page.getByTestId('formula-suggestion-Subtotal')).toBeVisible();
  await input.press('Escape');
  await expect(page.getByTestId('formula-autocomplete')).toHaveCount(0);
  await expect(host).toBeVisible();
  await input.press('Escape');
  await expect(host).toHaveCount(0);
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
});

test('dialog keyboard save persists the canonical native definition', async ({ page }) => {
  await page.goto(`${page.url()}?host=dialog`);
  const input = page.getByTestId('formula-editor-input');

  await expect(page.getByTestId('formula-editor-dialog')).toHaveAttribute('data-slot', 'dialog-content');
  await replaceSource(input, 'prop("Price") + 1');
  await expect(input).toHaveAttribute('data-value', 'prop("price") + 1');
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  await input.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('formula-editor-dialog')).toHaveCount(0);
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("price") + 1');
});

test('ambiguous display names require a property choice and preview uses the selected row', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await page.getByRole('button', { name: 'Duplicate Price name', exact: true }).click();
  await replaceSource(input, 'prop("Price")');
  await expect(page.getByTestId('formula-editor-error')).toContainText('ambiguous');
  await expect(page.getByTestId('formula-editor-done')).toBeDisabled();
  await replaceSource(input, '');
  await expect(input).toHaveAttribute('data-value', '');
  await expect(page.getByTestId('formula-editor-error')).toBeVisible();
  await input.press('Escape');
  await page.getByTestId('formula-catalogue-property-subtotal').click();
  await expect(input).toHaveAttribute('data-value', 'prop("subtotal")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('20');
  await page.getByTestId('formula-preview-row').click();
  await page.getByRole('menuitem', { name: 'Beta', exact: true }).click();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('15');
  await expect(page.getByTestId('formula-preview-row')).toHaveText('Beta');
});

test('preview row remains selectable after a catalogue insertion', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, '');
  await expect(input).toHaveAttribute('data-value', '');
  await expect(page.getByTestId('formula-editor-error')).toBeVisible();
  await input.press('Escape');
  await page.getByTestId('formula-catalogue-property-subtotal').click();
  await expect(input).toHaveAttribute('data-value', 'prop("subtotal")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('20');
  await expect(page.getByTestId('formula-autocomplete')).toHaveCount(0);
  await page.getByTestId('formula-preview-row').click();
  await expect(page.getByRole('menuitem', { name: 'Beta', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Beta', exact: true }).click();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('15');
  await expect(page.getByTestId('formula-preview-row')).toHaveText('Beta');
});

test('property menu displays renamed references from native spans', async ({ page }) => {
  await page.getByRole('button', { name: 'Property menu', exact: true }).click();
  const preview = page.getByTestId('formula-edit-formula');

  await expect(preview).toHaveText('prop("Subtotal") + 5');
  await page.evaluate(() => {
    const fixture = (window as unknown as { editorFixture: { fields: Map<string, Map<string, unknown>> } })
      .editorFixture;

    fixture.fields.get('subtotal')!.set('name', '合计🧮');
  });
  await expect(preview).toHaveText('prop("合计🧮") + 5');
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
});

test('a saved missing property keeps its ID until the user explicitly selects a replacement', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, 'prop("Price") + 2');
  await expect(input).toHaveAttribute('data-value', 'prop("price") + 2');
  await expect(page.getByTestId('formula-editor-done')).toBeEnabled();
  await page.getByTestId('formula-editor-done').click();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("price") + 2');
  await page.getByRole('button', { name: 'Rename and reuse Price', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Price', exact: true }).click();
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await expect(input).toHaveAttribute('data-value', 'prop("price") + 2');
  await expect(page.getByTestId('formula-token')).toHaveAttribute('data-missing', 'true');
  await expect(page.getByTestId('formula-editor-error')).toBeVisible();
  await expect(page.getByTestId('formula-editor-done')).toBeDisabled();
  await page.getByTestId('formula-editor-cancel').click();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("price") + 2');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await replaceSource(input, '');
  await expect(input).toHaveAttribute('data-value', '');
  await expect(page.getByTestId('formula-editor-error')).toBeVisible();
  await input.press('Escape');
  await page.getByTestId('formula-catalogue-property-other').click();
  await expect(input).toHaveAttribute('data-value', 'prop("other")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('100');
  await page.getByTestId('formula-editor-done').click();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("other")');
  await expect(page.getByTestId('committed-total')).toHaveText('100');
});

test('catalogue and examples insert at the Slate selection and preserve undo', async ({ page }) => {
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, '3 + ');
  await expect(page.getByTestId('formula-editor-error')).toBeVisible();
  await input.press('Escape');
  await page.getByTestId('formula-catalogue-property-other').click();
  await expect(input).toHaveAttribute('data-value', '3 + prop("other")');
  await expect(input).toBeFocused();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('103');
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', '3 + ');
  await input.press('ControlOrMeta+Shift+z');
  await expect(input).toHaveAttribute('data-value', '3 + prop("other")');
  await input.press('ControlOrMeta+a');
  await input.press('Escape');
  await page.getByTestId('formula-catalogue-property-other').hover();
  await page.getByTestId('formula-docs').locator('[data-expression=\'prop("other")\']').click();
  await expect(input).toHaveAttribute('data-value', 'prop("other")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('100');
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveAttribute('data-value', '3 + prop("other")');
});

for (const source of ['timestamp(now/* clock */())', 'prop("clock")']) {
  test(`candidate preview keeps ticking for ${source}`, async ({ page }) => {
    await page.clock.install({ time: new Date('1970-01-01T00:00:01Z') });
    await page.clock.setFixedTime(new Date('1970-01-01T00:00:01Z'));
    await page.getByRole('button', { name: 'Close consumers', exact: true }).click();
    if (source === 'prop("clock")') {
      await page.evaluate(() => {
        (window as unknown as { editorFixture: { addClockFormula: () => void } }).editorFixture.addClockFormula();
      });
      await expect(page.getByTestId('formula-catalogue-property-clock')).toBeVisible();
    }

    await replaceSource(page.getByTestId('formula-editor-input'), source);
    await expect(page.getByTestId('formula-preview-value')).toHaveText('1000');
    await page.clock.setFixedTime(new Date('1970-01-01T00:00:03Z'));
    await page.clock.fastForward(1100);
    await expect(page.getByTestId('formula-preview-value')).toHaveText('3000');
    await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
    await page.getByTestId('formula-editor-cancel').click();
    await expect(page.getByTestId('formula-editor')).toHaveCount(0);
    await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
  });
}

// The editor is the only consumer of this related metadata snapshot. Remote
// Yjs updates arrive only while its public sync transport has a retained owner.
test('candidate preview retains realtime metadata until its external dependency is removed', async ({ page }) => {
  await enableExternalPreview(page);
  const input = page.getByTestId('formula-editor-input');

  await replaceSource(input, 'prop("rollup")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('6');
  await page.evaluate(() => {
    (window as unknown as { editorFixture: ExternalPreviewFixture }).editorFixture.setRemoteExpression(
      'prop("amount") * 2'
    );
  });
  await expect(page.getByTestId('formula-preview-value')).toHaveText('12');
  await expect.poll(async () => (await evidence(page)).external.owners).toBe(1);
  await expect(input).toHaveAttribute('data-value', 'prop("rollup")');
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
  await replaceSource(input, '42');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('42');
  await expect.poll(async () => (await evidence(page)).external.owners).toBe(0);
  await expect.poll(async () => (await evidence(page)).external.metadataObservers).toBe(0);
  await expect.poll(async () => (await evidence(page)).external.rowObservers).toBe(0);
  await page.evaluate(() => {
    (window as unknown as { editorFixture: ExternalPreviewFixture }).editorFixture.setRemoteExpression('99');
  });
  await expect(page.getByTestId('formula-preview-value')).toHaveText('42');
  await page.getByTestId('formula-editor-cancel').click();
  await expect
    .poll(async () => {
      const state = await evidence(page);

      return state.workers === state.terminated && state.external.bindings === state.external.releases;
    })
    .toBe(true);
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
});

test('candidate preview binds cold metadata before waiting for hydration and releases on Cancel', async ({ page }) => {
  await enableExternalPreview(page, { cold: true });
  await replaceSource(page.getByTestId('formula-editor-input'), 'prop("rollup")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('6');
  await expect.poll(async () => (await evidence(page)).external.owners).toBe(1);
  await page.getByTestId('formula-editor-cancel').click();
  await expect.poll(async () => (await evidence(page)).external.owners).toBe(0);
  await expect.poll(async () => (await evidence(page)).external.metadataObservers).toBe(0);
  await expect.poll(async () => (await evidence(page)).external.rowObservers).toBe(0);
  await expect
    .poll(async () => {
      const state = await evidence(page);

      return state.workers === state.terminated && state.external.bindings === state.external.releases;
    })
    .toBe(true);
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
});

for (const kind of ['metadata', 'row'] as const) {
  test(`late ${kind} loader cannot attach preview observers after ${
    kind === 'row' ? 'Cancel' : 'a newer edit'
  }`, async ({ page }) => {
    await enableExternalPreview(page);
    await page.evaluate((kind) => {
      (window as unknown as { editorFixture: ExternalPreviewFixture }).editorFixture.holdSource(kind);
    }, kind);
    await replaceSource(page.getByTestId('formula-editor-input'), 'prop("rollup")');
    await expect.poll(async () => (await evidence(page)).external.pendingSources).toBe(1);
    if (kind === 'row') {
      await expect.poll(async () => (await evidence(page)).external.metadataObservers).toBe(1);
      await page.getByTestId('formula-editor-cancel').click();
      await expect(page.getByTestId('formula-editor')).toHaveCount(0);
    } else {
      await replaceSource(page.getByTestId('formula-editor-input'), '42');
      await expect(page.getByTestId('formula-preview-value')).toHaveText('42');
    }

    const returns = (await evidence(page)).external.sourceReturns;

    await page.evaluate(() => {
      (window as unknown as { editorFixture: ExternalPreviewFixture }).editorFixture.releaseSource();
    });
    await expect.poll(async () => (await evidence(page)).external.sourceReturns).toBe(returns + 1);
    await expect.poll(async () => (await evidence(page)).external.metadataObservers).toBe(0);
    await expect.poll(async () => (await evidence(page)).external.rowObservers).toBe(0);
    await expect.poll(async () => (await evidence(page)).external.owners).toBe(0);
    if (kind === 'metadata') {
      await expect(page.getByTestId('formula-preview-value')).toHaveText('42');
      await page.getByTestId('formula-editor-cancel').click();
    }

    await expect
      .poll(async () => {
        const state = await evidence(page);

        return state.workers === state.terminated && state.external.bindings === state.external.releases;
      })
      .toBe(true);
    await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
  });
}

test('candidate preview keeps ticking for an external Formula through Rollup', async ({ page }) => {
  await page.clock.install({ time: new Date('1970-01-01T00:00:01Z') });
  await page.clock.setFixedTime(new Date('1970-01-01T00:00:01Z'));
  await enableExternalPreview(page, { clock: true });
  await replaceSource(page.getByTestId('formula-editor-input'), 'prop("rollup")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('1000');
  await page.clock.setFixedTime(new Date('1970-01-01T00:00:03Z'));
  await page.clock.fastForward(1100);
  await expect(page.getByTestId('formula-preview-value')).toHaveText('3000');
  await page.getByTestId('formula-editor-cancel').click();
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
});

async function prepareMemberPreview(page: Page, formulaURL: string) {
  await page.goto(new URL('/native-formula-editor-fixture?people', formulaURL).href);
  await expect(page.getByTestId('committed-total')).toHaveText('25');
  await expect(page.getByTestId('formula-editor-input')).toBeEditable();
  await page.clock.install({ time: new Date('2026-10-05T00:00:00Z') });
  await page.clock.setFixedTime(new Date('2026-10-05T00:00:00Z'));
  await page.getByRole('button', { name: 'Close consumers', exact: true }).click();
  await page.evaluate(async () => {
    const fixture = (window as unknown as { editorFixture: MemberPreviewFixture }).editorFixture;

    await fixture.setMemberName('Ada');
    fixture.trackClockSubscriptions();
  });
}

// Member-name changes live in IndexedDB, not the formula's collaborative
// document. A candidate with no saved clock dependency must still refresh.
for (const [id, label] of [
  ['person', 'Person'],
  ['creator', 'CreatedBy'],
  ['editor', 'LastEditedBy'],
  ['rollup', 'Person Rollup'],
]) {
  test(`member-only candidate ${label} refreshes names every 30 seconds and cancels its clock`, async ({
    page,
    formulaURL,
  }) => {
    await prepareMemberPreview(page, formulaURL);
    const input = page.getByTestId('formula-editor-input');

    if (id === 'rollup') await enableExternalPreview(page, { people: true });
    await replaceSource(input, `prop("${id}").join(",")`);
    await expect(page.getByTestId('formula-preview-value')).toHaveText('Ada');
    await expect.poll(async () => (await evidence(page)).clockOwners).toBe(1);
    const documentRevision = await page.getByTestId('formula-editor').getAttribute('data-document-revision');
    const evaluations = (await evidence(page)).requests.filter((request) => request.method === 'engine.evaluate').length;

    await page.evaluate(async () => {
      await (window as unknown as { editorFixture: MemberPreviewFixture }).editorFixture.setMemberName('Grace');
    });
    await page.clock.setFixedTime(new Date('2026-10-05T00:00:29Z'));
    await page.clock.fastForward(29_000);
    await expect(page.getByTestId('formula-preview-value')).toHaveText('Ada');
    expect((await evidence(page)).requests.filter((request) => request.method === 'engine.evaluate')).toHaveLength(
      evaluations
    );
    await page.clock.setFixedTime(new Date('2026-10-05T00:00:30Z'));
    await page.clock.fastForward(1_100);
    await expect(page.getByTestId('formula-preview-value')).toHaveText('Grace');
    await expect(page.getByTestId('formula-editor')).toHaveAttribute('data-document-revision', documentRevision!);
    await expect(input).toHaveAttribute('data-value', `prop("${id}").join(",")`);
    await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
    await page.getByTestId('formula-editor-cancel').click();
    await expect.poll(async () => (await evidence(page)).clockOwners).toBe(0);
    await expect
      .poll(async () => {
        const state = await evidence(page);

        return state.workers === state.terminated;
      })
      .toBe(true);
    const stopped = (await evidence(page)).requests.length;

    await page.clock.setFixedTime(new Date('2026-10-05T00:01:30Z'));
    await page.clock.fastForward(60_000);
    expect((await evidence(page)).requests).toHaveLength(stopped);
  });
}

test('member candidate history uses saved names without owning the live roster clock', async ({ page, formulaURL }) => {
  await prepareMemberPreview(page, formulaURL);
  await replaceSource(page.getByTestId('formula-editor-input'), 'prop("person").join(",")');
  await expect(page.getByTestId('formula-preview-value')).toHaveText('Ada');
  await expect.poll(async () => (await evidence(page)).clockOwners).toBe(1);
  await page.getByRole('button', { name: 'Switch to history', exact: true }).click();
  await expect(page.getByTestId('formula-preview-value')).toHaveText('Saved Ada');
  await expect.poll(async () => (await evidence(page)).clockOwners).toBe(0);
  // Restoring history chips may refresh Draft help after preview settles.
  // The history contract prohibits live reevaluation, not editor queries.
  const evaluations = (await evidence(page)).requests.filter((request) => request.method === 'engine.evaluate').length;

  await page.evaluate(async () => {
    await (window as unknown as { editorFixture: MemberPreviewFixture }).editorFixture.setMemberName('Grace');
  });
  await page.clock.setFixedTime(new Date('2026-10-05T00:01:00Z'));
  await page.clock.fastForward(60_000);
  await expect(page.getByTestId('formula-preview-value')).toHaveText('Saved Ada');
  expect((await evidence(page)).requests.filter((request) => request.method === 'engine.evaluate')).toHaveLength(
    evaluations
  );
  await page.getByTestId('formula-editor-cancel').click();
  await expect
    .poll(async () => {
      const state = await evidence(page);

      return state.workers === state.terminated;
    })
    .toBe(true);
  await expect(page.getByTestId('saved-expression')).toHaveText('prop("subtotal") + 5');
});
