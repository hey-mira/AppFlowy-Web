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

  await writeFile(
    json,
    JSON.stringify(
      {
        url: page.url(),
        order: await page.getByTestId('condition-orders').textContent(),
        resultType: await page.getByTestId('condition-orders').getAttribute('data-result-type'),
        browserVersion: page.context().browser()?.version(),
      },
      null,
      2
    )
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-conditions.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-conditions.png', { path: screenshot, contentType: 'image/png' });
});

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
