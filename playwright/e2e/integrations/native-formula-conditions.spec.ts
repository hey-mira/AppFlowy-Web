import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

const test = createNativeFormulaTest('playwright/support/native-formula-conditions.fixture.tsx');

test.beforeEach(async ({ page, formulaHTML }) => {
  await page.clock.install({ time: new Date('2024-03-13T04:00:00Z') });
  await page.clock.setFixedTime(new Date('2024-03-13T04:00:00Z'));
  await page.route('**/formula-conditions-fixture?**', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
});

test.afterEach(async ({ page }, testInfo) => {
  const json = testInfo.outputPath('native-formula-conditions.json');
  const screenshot = testInfo.outputPath('native-formula-conditions.png');
  const output = page.getByTestId('condition-orders');
  const present = await output.count();

  await writeFile(
    json,
    JSON.stringify(
      {
        url: page.url(),
        order: present ? await output.textContent() : null,
        resultType: present ? await output.getAttribute('data-result-type') : null,
        numeric: await page.evaluate(() => (window as unknown as { nativeNumericEvidence?: unknown }).nativeNumericEvidence),
        profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
        browserVersion: page.context().browser()?.version(),
      },
      (_key, value: unknown) => typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
        ? { Number: Object.is(value, -0) ? '-0' : String(value) } : value,
      2
    )
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-conditions.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-conditions.png', { path: screenshot, contentType: 'image/png' });
});

// Keep the host's stable zero ties and empty-last convention. NaN is a value:
// after +Infinity ascending, before it descending, with NaN ties stable.
const numericAscending = 'negative-infinity,negative,zero,negative-zero,fraction,positive,large,positive-infinity,nan,nan-second,empty,error';
const numericDescending = 'nan,nan-second,positive-infinity,large,positive,fraction,zero,negative-zero,negative,negative-infinity,empty,error';

for (const field of ['numeric', 'rolled']) {
  for (const [direction, expected] of [['asc', numericAscending], ['desc', numericDescending]]) {
    test(`native special Number ${field} sorts ${direction} without merging NaN and null`, async ({ page, formulaURL }) => {
      await page.goto(new URL(`/formula-conditions-fixture?mode=numbers&field=${field}&sort=${direction}`, formulaURL).href);
      await expect(page.getByTestId('condition-orders')).toHaveText(expected);
      await expect(page.getByTestId('numeric-native-type')).toHaveText('number');
      await expect(page.getByTestId('formula-cell-positive-infinity-numeric')).toHaveText('Infinity');
      await expect(page.getByTestId('formula-cell-negative-infinity-numeric')).toHaveText('-Infinity');
      await expect(page.getByTestId('formula-cell-nan-numeric')).toHaveText('NaN');
      await expect(page.getByTestId('formula-cell-negative-zero-numeric')).toHaveText('-0');
      await expect(page.getByTestId('formula-cell-empty-numeric')).toHaveAttribute('data-evaluation-state', 'null');
      await expect(page.getByTestId('formula-cell-error-numeric')).toHaveAttribute('data-evaluation-state', 'error');
      await expect(page.getByTestId('formula-cell-positive-numeric')).toHaveText('8');
    });
  }
}

const numericFilters = [
  { condition: 0, content: '0', expected: 'zero,negative-zero' },
  { condition: 1, content: '0', expected: 'positive-infinity,positive,negative-infinity,negative,fraction,large' },
  { condition: 2, content: '0', expected: 'positive-infinity,positive,fraction,large' },
  { condition: 3, content: '0', expected: 'negative-infinity,negative' },
  { condition: 4, content: '0', expected: 'positive-infinity,positive,zero,negative-zero,fraction,large' },
  { condition: 5, content: '0', expected: 'zero,negative-infinity,negative-zero,negative' },
  { condition: 6, content: '', expected: 'empty' },
  { condition: 7, content: '', expected: 'nan,positive-infinity,positive,zero,negative-infinity,negative-zero,negative,fraction,large,nan-second' },
  { condition: 0, content: 'Infinity', expected: 'positive-infinity' },
  { condition: 1, content: 'Infinity', expected: 'positive,zero,negative-infinity,negative-zero,negative,fraction,large' },
  { condition: 2, content: 'Infinity', expected: '' },
  { condition: 3, content: 'Infinity', expected: 'positive,zero,negative-infinity,negative-zero,negative,fraction,large' },
  { condition: 4, content: 'Infinity', expected: 'positive-infinity' },
  { condition: 5, content: 'Infinity', expected: 'positive-infinity,positive,zero,negative-infinity,negative-zero,negative,fraction,large' },
  { condition: 0, content: '-Infinity', expected: 'negative-infinity' },
  { condition: 1, content: '-Infinity', expected: 'positive-infinity,positive,zero,negative-zero,negative,fraction,large' },
  { condition: 2, content: '-Infinity', expected: 'positive-infinity,positive,zero,negative-zero,negative,fraction,large' },
  { condition: 3, content: '-Infinity', expected: '' },
  { condition: 4, content: '-Infinity', expected: 'positive-infinity,positive,zero,negative-infinity,negative-zero,negative,fraction,large' },
  { condition: 5, content: '-Infinity', expected: 'negative-infinity' },
  { condition: 2, content: '9007199254740990', expected: 'positive-infinity,large' },
  { condition: 3, content: '0.0000011', expected: 'zero,negative-infinity,negative-zero,negative,fraction' },
  // A blank bound disables the predicate, retaining every row and its state.
  { condition: 2, content: ' ', expected: 'empty,nan,positive-infinity,positive,zero,error,negative-infinity,negative-zero,negative,fraction,large,nan-second' },
  ...[0, 1, 2, 3, 4, 5].map((condition) => ({ condition, content: 'NaN', expected: '' })),
];

for (const { condition, content, expected } of numericFilters) {
  test(`native special Number filter ${condition} with ${JSON.stringify(content)} preserves values and failure state`, async ({ page, formulaURL }) => {
    await page.goto(new URL(`/formula-conditions-fixture?${new URLSearchParams({ mode: 'numbers', field: 'numeric', condition: String(condition), content })}`, formulaURL).href);
    await expect(page.getByTestId('numeric-native-type')).toHaveText('number');
    await expect(page.getByTestId('formula-cell-positive-numeric')).toHaveAttribute('data-evaluation-state', 'value');
    await expect(page.getByTestId('condition-orders')).toHaveText(expected);
    const evidence = await page.evaluate(() => (window as unknown as { nativeNumericEvidence: { errors: string[]; workers: number } }).nativeNumericEvidence);

    expect(evidence.errors).toEqual([]);
    expect(evidence.workers).toBeGreaterThan(0);
  });
}

for (const { condition, content, expected } of numericFilters.slice(0, 8)) {
  test(`native numeric Rollup filter ${condition} preserves non-finite values and excludes errors`, async ({ page, formulaURL }) => {
    await page.goto(new URL(`/formula-conditions-fixture?${new URLSearchParams({ mode: 'numbers', field: 'rolled', condition: String(condition), content })}`, formulaURL).href);
    await expect(page.getByTestId('numeric-native-type')).toHaveText('number');
    await expect(page.getByTestId('condition-orders')).toHaveText(expected);
  });
}

const types = [
  { field: 'double', type: 'number', condition: 2, content: '10', expected: 'row-b,row-c' },
  { field: 'label', type: 'text', condition: 2, content: 'done', expected: 'row-a' },
  { field: 'flag', type: 'boolean', condition: 0, content: '', expected: 'row-b,row-c' },
  { field: 'next', type: 'date', condition: 0, content: '{"timestamp":1709510400}', expected: 'row-a' },
];

for (const { field, type, condition, content, expected } of types) {
  test(`native ${type} formulas use their host filter vocabulary`, async ({ page, formulaURL }) => {
    await page.goto(
      new URL(
        `/formula-conditions-fixture?${new URLSearchParams({
          mode: 'types',
          field,
          condition: String(condition),
          content,
        })}`,
        formulaURL
      ).href
    );
    await expect(page.getByTestId('condition-orders')).toHaveAttribute('data-result-type', type);
    await expect(page.getByTestId('condition-orders')).toHaveText(expected);
  });
}

for (const [field, type, direction, expected] of [
  ['double', 'number', 'asc', 'row-a,row-c,row-b'],
  ['double', 'number', 'desc', 'row-b,row-c,row-a'],
  ['label', 'text', 'asc', 'row-a,row-b,row-c'],
  ['next', 'date', 'asc', 'row-b,row-c,row-a'],
]) {
  test(`native ${type} formulas sort ${direction} by current values`, async ({ page, formulaURL }) => {
    await page.goto(new URL(`/formula-conditions-fixture?mode=types&field=${field}&sort=${direction}`, formulaURL).href);
    await expect(page.getByTestId('condition-orders')).toHaveAttribute('data-result-type', type);
    await expect(page.getByTestId('condition-orders')).toHaveText(expected);
  });
}

for (const condition of [0, 8]) {
  test(`epoch formula dates remain distinct from null for date condition ${condition}`, async ({ page, formulaURL }) => {
    await page.goto(
      new URL(
        `/formula-conditions-fixture?${new URLSearchParams({
          mode: 'epoch',
          condition: String(condition),
          content: '{"timestamp":0}',
        })}`,
        formulaURL
      ).href
    );
    await expect(page.getByTestId('condition-orders')).toHaveText('epoch');
  });
}

for (const [condition, expected] of [
  [8, 'on,single'],
  [9, 'before,last-week'],
  [10, 'after,next-week'],
  [11, 'before,on,last-week,single'],
  [12, 'on,after,next-week,single'],
  [13, 'before,on,after,single'],
  [14, 'empty'],
  [15, 'before,on,after,last-week,next-week,single'],
  [22, 'on,single'],
  [23, 'before'],
  [24, 'after'],
  [25, 'before,on,after,single'],
  [26, 'last-week'],
  [27, 'next-week'],
] as const) {
  test(`native formula ranges filter by their end for date condition ${condition}`, async ({ page, formulaURL }) => {
    await page.goto(
      new URL(
        `/formula-conditions-fixture?${new URLSearchParams({
          mode: 'range',
          condition: String(condition),
          content: '{"timestamp":1710288000,"start":1710201600,"end":1710374400}',
        })}`,
        formulaURL
      ).href
    );
    await expect(page.getByTestId('condition-orders')).toHaveText(expected);
  });
}

for (const selection of ['simple', 'advanced']) {
  test(`saved ${selection} date-formula selections survive native metadata becoming Ready`, async ({
    page,
    formulaURL,
  }) => {
    await page.goto(
      new URL(
        `/formula-conditions-fixture?${new URLSearchParams({
          mode: 'types',
          field: 'next',
          selection,
          condition: '0',
          content: '{"timestamp":1709510400}',
        })}`,
        formulaURL
      ).href
    );
    await expect(page.getByTestId('condition-orders')).toHaveText('row-a');
    await expect(page.getByTestId(selection === 'simple' ? 'simple-selection' : 'advanced-selection')).toContainText(
      '"timestamp":1709510400'
    );
    if (selection === 'advanced')
      await expect(page.getByTestId('all-selections')).toContainText('"timestamp":1709510400');
  });
}
