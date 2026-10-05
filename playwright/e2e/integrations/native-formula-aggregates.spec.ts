import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

const test = createNativeFormulaTest('playwright/support/native-formula-aggregates.fixture.tsx');

test.beforeEach(async ({ page, formulaHTML }) => {
  await page.route('**/formula-aggregates-fixture?**', (route) => route.fulfill({ contentType: 'text/html', body: formulaHTML }));
});

test.afterEach(async ({ page }, testInfo) => {
  const json = testInfo.outputPath('native-formula-aggregates.json');
  const screenshot = testInfo.outputPath('native-formula-aggregates.png');

  await writeFile(json, JSON.stringify({
    url: page.url(),
    profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
    browserVersion: page.context().browser()?.version(),
    footers: await page.getByTestId('grid-calculate-cell-formula').allTextContents(),
    rollup: await page.getByTestId('rollup-cell-row-0-median').textContent(),
    evidence: await page.evaluate(() => (window as unknown as { nativeAggregateEvidence: unknown }).nativeAggregateEvidence),
  }, (_key, value: unknown) => typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
    ? { Number: Object.is(value, -0) ? '-0' : String(value) } : value, 2));
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-aggregates.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-aggregates.png', { path: screenshot, contentType: 'image/png' });
});

// Native builtin aggregate contract: propagate every NaN; order -0 before +0
// for median selection. Row sorting retains its separate stable zero ties.
const cases: { name: string; values: (string | null)[]; median: string; raw?: string }[] = [
  { name: 'NaN first', values: ['NaN', '1', '2'], median: 'NaN' },
  { name: 'NaN middle', values: ['1', 'NaN', '2'], median: 'NaN' },
  { name: 'NaN last', values: ['1', '2', 'NaN'], median: 'NaN' },
  { name: 'NaN only', values: ['NaN'], median: 'NaN' },
  { name: 'opposite infinities with finite middle', values: ['Infinity', '1', '-Infinity'], median: '1' },
  { name: 'positive infinities', values: ['Infinity', 'Infinity'], median: 'Infinity' },
  { name: 'negative infinities', values: ['-Infinity', '-Infinity'], median: '-Infinity' },
  { name: 'opposite infinities even', values: ['Infinity', '-Infinity'], median: 'NaN' },
  { name: 'finite and positive infinity', values: ['1', 'Infinity'], median: 'Infinity' },
  { name: 'finite and negative infinity', values: ['-Infinity', '1'], median: '-Infinity' },
  { name: 'negative-zero majority positive first', values: ['0', '-0', '-0'], median: '-0' },
  { name: 'negative-zero majority positive middle', values: ['-0', '0', '-0'], median: '-0' },
  { name: 'negative-zero majority positive last', values: ['-0', '-0', '0'], median: '-0' },
  { name: 'positive-zero majority negative first', values: ['-0', '0', '0'], median: '0' },
  { name: 'positive-zero majority negative middle', values: ['0', '-0', '0'], median: '0' },
  { name: 'positive-zero majority negative last', values: ['0', '0', '-0'], median: '0' },
  { name: 'mixed zeros negative first even', values: ['-0', '0'], median: '0' },
  { name: 'mixed zeros positive first even', values: ['0', '-0'], median: '0' },
  { name: 'negative zeros even', values: ['-0', '-0'], median: '-0' },
  { name: 'finite odd', values: ['3', '1', '2'], median: '2' },
  // The footer keeps its exact finite decimal path; Rollup keeps its raw f64.
  { name: 'finite decimal even', values: ['0.1', '0.2'], median: '0.15', raw: '0.15000000000000002' },
  { name: 'ordinary null is skipped', values: [null, '1', '3'], median: '2' },
];

for (const { name, values, median, raw = median } of cases) {
  test(`native median ${name} agrees across Grid, Timeline and numeric Rollup`, async ({ page, formulaURL }) => {
    await page.goto(new URL(`/formula-aggregates-fixture?${new URLSearchParams({ scenario: name, values: JSON.stringify(values) })}`, formulaURL).href);
    await expect(page.getByTestId('aggregate-native-type')).toHaveText('number');
    const footers = page.getByTestId('grid-calculate-cell-formula');

    await expect(footers).toHaveCount(2);
    for (const footer of await footers.all()) await expect(footer).toHaveAttribute('data-evaluation-state', 'ready');
    await expect(page.getByTestId('aggregate-rollup-raw')).toHaveAttribute('data-loaded', 'true');
    // Soft assertions retain both independent public consumer failures in red.
    await expect.soft(footers, { message: name }).toHaveText([`Median${median}`, `Median${median}`], { timeout: 1500 });
    await expect.soft(page.getByTestId('rollup-cell-row-0-median'), { message: name }).toHaveText(median, { timeout: 1500 });
    await expect.soft(page.getByTestId('aggregate-rollup-raw'), { message: name }).toHaveText(raw, { timeout: 1500 });
    const evidence = await page.evaluate(() => (window as unknown as { nativeAggregateEvidence: {
      workers: number; evaluations: number; errors: string[]; cells: Record<string, { evaluationState: string; resultType: string }>;
    } }).nativeAggregateEvidence);

    expect(evidence.workers).toBeGreaterThan(0);
    expect(evidence.evaluations).toBeGreaterThan(0);
    expect(evidence.errors).toEqual([]);
    for (let index = 0; index < values.length; index += 1) {
      expect(evidence.cells[`row-${index}`].resultType).toBe('number');
      expect(evidence.cells[`row-${index}`].evaluationState).toBe(values[index] === null ? 'null' : 'value');
    }
  });
}
