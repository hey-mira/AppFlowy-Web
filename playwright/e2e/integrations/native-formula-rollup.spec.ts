import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

import type { RollupReport } from '../../support/native-formula-rollup.fixture';

const test = createNativeFormulaTest('playwright/support/native-formula-rollup.fixture.ts');

test.use({ timezoneId: 'UTC', locale: 'en-US' });

// This maps every retired group, including parameterized cases. The existing
// suites retain native range transport, non-finite values, null/failure origin,
// clock subscription disposal, and the Formula→Rollup→Formula cycle oracle.
const migration = {
  source: 'src/application/database-yjs/__tests__/rollup-formula-combinations.test.ts',
  preserved: {
    'typed targets, formatting, date reducers, lists and chains': 'typed Formula targets',
    'selected-option counts, percentages and five wire formats': 'typed Formula targets',
    'project effort source/formula/relation edits': 'project effort',
    'completed/high-priority tasks and blank/empty recovery': 'project completion',
    'expense quantities and unrelated rows': 'expense totals',
    'nested external edits, target type change and disposal': 'nested observer',
    'disposal while a row is loading': 'pending row',
    'rejected/missing/unresolved metadata retries': 'metadata retry',
    'missing database/title/row during permanent materialization': 'permanent materialization',
    '64/65-hop boundary': 'Rollup depth',
  },
  reused: {
    'clock targets and disposal':
      'native-formula-consumers.spec.ts: commented native now() syntax keeps cells and footer current',
    'cross-database cycles':
      'native-formula.spec.ts: independent Ready formulas continue through host loading, errors and cycles',
    'raw range/time flags, null and non-finite values':
      'native-formula-consumers.spec.ts and native-formula-values.spec.ts',
  },
  differences: [
    {
      source: '1 / 0',
      legacy: { CountEmpty: 2 },
      native: { CountEmpty: 0 },
      reason: 'Infinity remains a Number value.',
    },
    {
      source: '',
      legacy: { CountNonEmpty: 0 },
      native: 'NotReady failure',
      reason: 'A blank expression has native MissingExpr diagnostics.',
    },
    {
      source: 'match("text", "[")',
      native: 'CountEmpty failure',
      reason: 'A row error is a failure, never ordinary null.',
    },
  ],
};

test.beforeEach(async ({ page, formulaURL, formulaHTML }, testInfo) => {
  const mode = testInfo.title.includes('typed Formula')
    ? 'matrix'
    : testInfo.title.includes('project effort')
    ? 'effort'
    : testInfo.title.includes('project completion')
    ? 'completion'
    : testInfo.title.includes('expense totals')
    ? 'expenses'
    : testInfo.title.includes('nested observer')
    ? 'nested'
    : testInfo.title.includes('pending row')
    ? 'pending'
    : testInfo.title.includes('metadata retry')
    ? testInfo.title.split(' ').at(-1)!
    : testInfo.title.includes('permanent materialization')
    ? 'materialization'
    : `depth-${testInfo.title.includes('65') ? '65' : '64'}`;

  await page.route('**/formula-rollup-fixture*', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  const url = new URL('/formula-rollup-fixture', formulaURL);

  url.searchParams.set('mode', mode);
  await page.goto(url.href);
});

test.afterEach(async ({ page }, testInfo) => {
  const report = await page.evaluate(
    () => (window as unknown as { nativeRollupReport?: RollupReport }).nativeRollupReport
  );
  const json = testInfo.outputPath('native-formula-rollup.json');
  const screenshot = testInfo.outputPath('native-formula-rollup.png');

  await writeFile(
    json,
    JSON.stringify(
      {
        report,
        migration,
        profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
        browserVersion: page.context().browser()?.version(),
      },
      (_key, value: unknown) => {
        if (typeof value === 'bigint') return String(value);
        if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
          return { Number: Object.is(value, -0) ? '-0' : String(value) };
        return value;
      },
      2
    )
  );
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('native-formula-rollup.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-rollup.png', { path: screenshot, contentType: 'image/png' });
});

test('typed Formula targets preserve authored Rollup calculations and selected-option conditions', async ({ page }) => {
  await expect(page.getByTestId('rollup-ready')).toHaveText('ready');
  const report = await page.evaluate(
    () => (window as unknown as { nativeRollupReport: RollupReport }).nativeRollupReport
  );
  const byId = (id: string) => report.results.find((row) => row.id === id)!;

  expect(report.failure).toBeUndefined();
  expect(report.workers).toBeGreaterThan(0);
  for (const [id, value, rawNumeric, nativeType, targetFieldType] of [
    ['number-sum', '14', 14, 'Number', 1],
    ['number-average', '7', 7, 'Number', 1],
    ['boolean-checked', '1', 1, 'Boolean', 5],
    ['boolean-percent', '50.0%', 50, 'Boolean', 5],
    ['boolean-unchecked', '2', 2, 'Boolean', 5],
    ['text-unique', '2', 2, 'String', 0],
    ['division-infinity', '0', 0, 'Number', 1],
    ['formula-chain', '24', 24, 'Number', 1],
  ] as const) {
    expect.soft(byId(id), id).toMatchObject({ result: { value, rawNumeric, targetFieldType }, nativeType });
    expect.soft(byId(id)?.result.error, id).toBeUndefined();
  }

  expect(byId('percent-display').result.rawNumeric).toBe(0.75);
  expect(byId('list-formula').result.list).toEqual(['Done, In progress', 'In progress']);
  expect(byId('blank-formula').result.error).toContain('not ready');
  expect(byId('invalid-regex').result.error).toBeDefined();
  expect(byId('invalid-regex').result.rawNumeric).toBeUndefined();
  expect(byId('date-original-list').result).toMatchObject({
    targetFieldType: 2,
    filterCells: [
      { date: { data: String(Date.parse('2026-09-24T18:00:00Z') / 1000), includeTime: true, isRange: true } },
    ],
  });
  expect(byId('date-earliest').result.rawDate?.data).toBe(String(Date.parse('2026-09-24') / 1000));
  for (const [id, instant, display] of [
    ['range-earliest', '2026-09-24T18:45:00Z', '09/24/2026 6:45 PM'],
    ['range-latest', '2026-09-26T09:15:00Z', '09/26/2026 9:15 AM'],
  ]) {
    expect(byId(id).result.value).toBe(display);
    expect(byId(id).result.rawDate).toMatchObject({ data: String(Date.parse(instant) / 1000), includeTime: true });
    expect(byId(id).result.rawDate?.isRange).not.toBe(true);
    expect(byId(id).result.rawDate?.endTimestamp).toBeUndefined();
  }

  expect(byId('range-span').result.rawDate).toMatchObject({
    data: String(Date.parse('2026-09-24T18:45:00Z') / 1000),
    endTimestamp: String(Date.parse('2026-09-26T09:15:00Z') / 1000),
    isRange: true,
  });
  for (const type of ['single', 'multi']) {
    for (const [name, value, rawNumeric] of [
      ['count', '3', 3],
      ['any', '75.0%', 75],
      ['done', '50.0%', 50],
      ['deleted', '0.0%', 0],
    ] as const)
      expect(byId(`${type}-${name}`).result).toMatchObject({ value, rawNumeric });
  }

  expect(byId('empty-relation').result.value).toBe('');
  expect(byId('unconfigured-condition').result.value).toBe('');
  expect(report.wire.map((row) => [row.raw, row.decoded, row.roundTrip])).toEqual([
    ['', [], []],
    ['done', ['done'], ['done']],
    ['["done","progress","done"]', ['done', 'progress'], ['done', 'progress']],
    ['["done",1]', ['["done",1]'], ['["done",1]']],
    ['[malformed', ['[malformed'], ['[malformed']],
  ]);
});

test('project effort follows source, Formula and relation edits through one observer', async ({ page }) => {
  const value = page.getByTestId('rollup-value');

  await expect(value).toHaveText('8');
  for (const [action, expected] of [
    ['Edit hours', '12'],
    ['Complete second task', '28'],
    ['Double completed hours', '56'],
    ['Only second task', '32'],
    ['Restore effort links', '56'],
    ['Zero first task', '32'],
    ['Unlink effort', ''],
    ['Restore effort links', '32'],
  ]) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(value).toHaveText(expected);
  }

  await expect(page.getByTestId('rollup-native-type')).toHaveText('Number');
});

test('project completion retains completed, priority and empty-recovery oracles', async ({ page }) => {
  const value = page.getByTestId('rollup-value');

  await expect(value).toHaveText('28');
  for (const [action, expected] of [
    ['Count completed tasks', '2'],
    ['Count unfinished high priority', '1'],
    ['Use completion percentage', '66.7%'],
    ['Add blank task', '50.0%'],
    ['Only unfinished task', '0.0%'],
    ['Only blank task', '0.0%'],
    ['Unlink completion', ''],
    ['Restore completion links', '66.7%'],
  ]) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(value).toHaveText(expected);
  }

  await expect(page.getByTestId('rollup-native-type')).toHaveText('Boolean');
});

test('expense totals refresh quantity changes and exclude unrelated expenses', async ({ page }) => {
  await expect(page.getByTestId('rollup-value')).toHaveText('2100');
  await page.getByRole('button', { name: 'Double third quantity', exact: true }).click();
  await expect(page.getByTestId('rollup-value')).toHaveText('2400');
});

test('nested observer tracks external inputs and releases all subscriptions on disposal', async ({ page }) => {
  await expect(page.getByTestId('rollup-value')).toHaveText('12');
  await page.getByRole('button', { name: 'Edit child amount', exact: true }).click();
  await expect(page.getByTestId('rollup-value')).toHaveText('20');
  await page.getByRole('button', { name: 'Use nested checked percentage', exact: true }).click();
  await expect(page.getByTestId('rollup-value')).toHaveText('100.0%');
  await page.getByRole('button', { name: 'Stop observer', exact: true }).click();
  const notifications = await page.getByTestId('rollup-notifications').textContent();
  const workers = await page.evaluate(
    () => (window as unknown as { nativeRollupReport: RollupReport }).nativeRollupReport.workers
  );

  await page.getByRole('button', { name: 'Edit disposed child', exact: true }).click();
  await expect(page.getByTestId('rollup-phase')).toHaveText('disposed edit settled');
  await expect(page.getByTestId('rollup-notifications')).toHaveText(notifications!);
  expect(
    await page.evaluate(() => (window as unknown as { nativeRollupReport: RollupReport }).nativeRollupReport.workers)
  ).toBe(workers);
});

test('pending row disposal prevents later dependency discovery and callbacks', async ({ page }) => {
  await expect(page.getByTestId('rollup-row-loads')).toHaveText('1');
  expect(
    await page.evaluate(() => (window as unknown as { nativeRollupReport: RollupReport }).nativeRollupReport.workers)
  ).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop observer', exact: true }).click();
  await page.getByRole('button', { name: 'Release pending row', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const report = (window as unknown as { nativeRollupReport: RollupReport }).nativeRollupReport;

        return report.terminated === report.workers;
      })
    )
    .toBe(true);
  await expect(page.getByTestId('rollup-row-loads')).toHaveText('1');
  await expect(page.getByTestId('rollup-notifications')).toHaveText('0');
});

for (const failure of ['rejected', 'missing', 'unresolved']) {
  test(`metadata retry recovers without a source edit: ${failure}`, async ({ page }) => {
    await expect(page.getByTestId('rollup-notifications')).not.toHaveText('0');
    await expect
      .poll(async () => Number(await page.getByTestId('rollup-notifications').textContent()))
      .toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('rollup-value')).toHaveText('6');
    await page.getByRole('button', { name: 'Edit recovered source', exact: true }).click();
    await expect(page.getByTestId('rollup-value')).toHaveText('8');
  });
}

test('permanent materialization rejects missing databases, title properties and row payloads', async ({ page }) => {
  await expect(page.getByTestId('rollup-ready')).toHaveText('ready');
  const report = await page.evaluate(
    () => (window as unknown as { nativeRollupReport: RollupReport }).nativeRollupReport
  );

  expect(report.results.map((row) => row.id)).toEqual(['missing-database', 'title-property', 'row-payload']);
  for (const row of report.results) {
    const expectedError = row.id === 'row-payload' ? 'could not be hydrated for formula evaluation' : 'could not be loaded';

    expect(row.result.error, row.id).toContain(expectedError);
    expect(row.result.rawNumeric, row.id).toBeUndefined();
  }
});

for (const depth of [64, 65]) {
  test(`Rollup depth preserves the authored ${depth}-hop boundary`, async ({ page }) => {
    await expect(page.getByTestId('rollup-ready')).toHaveText('ready');
    const report = await page.evaluate(
      () => (window as unknown as { nativeRollupReport: RollupReport }).nativeRollupReport
    );
    const result = report.results[0]?.result;

    expect(report.failure).toBeUndefined();
    expect(report.workers).toBeGreaterThanOrEqual(64);
    if (depth === 64) {
      expect(result?.error).toBeUndefined();
      expect(result?.rawNumeric).toBe(1);
    } else {
      expect(result).toMatchObject({ value: '', error: 'Formula and rollup dependencies are too deep' });
    }
  });
}
