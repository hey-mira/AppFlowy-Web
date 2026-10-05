import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

const test = createNativeFormulaTest('playwright/support/native-formula-consumers.fixture.tsx');

test.beforeEach(async ({ page, formulaURL, formulaHTML }, testInfo) => {
  if (testInfo.title.includes('commented native') || testInfo.title.includes('current roster')) {
    const time = new Date(testInfo.title.includes('today()') ? '2026-01-02T15:59:59Z' : '2026-01-02T02:00:00Z');

    await page.clock.install({ time });
    await page.clock.setFixedTime(time);
  }

  await page.route('**/formula-consumers-fixture*', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(
    new URL(`/formula-consumers-fixture${testInfo.title.includes('ISO viewer') ? '?viewer=iso' : ''}`, formulaURL).href
  );
});

test.afterEach(async ({ page }, testInfo) => {
  const artifact = await page.evaluate(() => ({
    evidence: (window as unknown as { formulaConsumersEvidence: unknown }).formulaConsumersEvidence,
    footer: document.querySelector('[data-testid="grid-calculate-cell-formula"]')?.textContent,
    projection: document.querySelector('[data-testid="formula-details"]')?.textContent,
  }));
  const json = testInfo.outputPath('native-formula-consumers.json');
  const screenshot = testInfo.outputPath('native-formula-consumers.png');

  await writeFile(
    json,
    JSON.stringify(
      {
        ...artifact,
        browserVersion: page.context().browser()?.version(),
        profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
      2
    )
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-consumers.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-consumers.png', { path: screenshot, contentType: 'image/png' });
});

// Failure modes: offscreen rows are omitted; JS supplies the footer; pending or
// failed rows persist zero; an old batch overwrites edits; reopen keeps old data.
for (const mode of ['grid', 'timeline'] as const) {
  test(`${mode} footer waits for complete native results and distinguishes failure from null`, async ({ page }) => {
    const footer = page.getByTestId('grid-calculate-cell-formula');

    if (mode === 'timeline') await page.getByRole('button', { name: 'Use timeline footer', exact: true }).click();
    await expect(footer).toHaveText('Sum12');
    await page.getByRole('button', { name: 'Hold edited value', exact: true }).click();
    await page.waitForFunction(
      () => (window as unknown as { formulaConsumersEvidence: { held: boolean } }).formulaConsumersEvidence.held
    );
    await expect(footer).toHaveAttribute('data-evaluation-state', 'pending');
    await page.getByRole('button', { name: 'Release newer value', exact: true }).click();
    await expect(footer).toHaveText('Sum30');
    await page.getByRole('button', { name: 'Formula failure', exact: true }).click();
    await expect(footer).toHaveAttribute('data-evaluation-state', 'error');
    await expect(footer).toHaveText('Error');
    await page.getByRole('button', { name: 'Ordinary null', exact: true }).click();
    await expect(footer).toHaveAttribute('data-evaluation-state', 'ready');
    await expect(footer).toHaveText('Sum4');
    await page.getByRole('button', { name: 'Close footer', exact: true }).click();
    await page.getByRole('button', { name: 'Edit closed database', exact: true }).click();
    await page.getByRole('button', { name: 'Open footer', exact: true }).click();
    await expect(footer).toHaveText('Sum21');
    expect(
      await page.evaluate(
        () => (window as unknown as { formulaConsumersEvidence: { workers: number } }).formulaConsumersEvidence.workers
      )
    ).toBe(1);
  });
}

// A permanent conversion must evaluate in Rust and retry if row or schema
// changes arrive while its native response is held. Every offscreen row is kept.
test('Formula conversion commits only current native values for every row', async ({ page }) => {
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum12');
  await page.getByRole('button', { name: 'Start held conversion', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('pending');
  await page.waitForFunction(
    () => (window as unknown as { formulaConsumersEvidence: { held: boolean } }).formulaConsumersEvidence.held
  );
  await page.getByRole('button', { name: 'Edit during conversion', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  await expect(page.getByTestId('converted-alpha')).toHaveText('33');
  await expect(page.getByTestId('converted-beta')).toHaveText('12');
});

test('Formula conversion refuses native failures and permits ordinary null', async ({ page }) => {
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum12');
  await page.getByRole('button', { name: 'Formula failure', exact: true }).click();
  await page.getByRole('button', { name: 'Convert to Number', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toContainText('error:');
  await expect(page.getByTestId('stored-field-type')).toHaveText('Formula');
  await page.getByRole('button', { name: 'Ordinary null', exact: true }).click();
  await page.getByRole('button', { name: 'Convert to Number', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  await expect(page.getByTestId('converted-alpha')).toHaveText('');
  await expect(page.getByTestId('converted-beta')).toHaveText('4');
});

test('Formula conversion to text preserves the displayed number format', async ({ page }) => {
  await page.getByRole('button', { name: 'Use percent display', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('25%');
  await page.getByRole('button', { name: 'Convert to Text', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  await expect(page.getByTestId('converted-alpha')).toHaveText('25%');
});

test('unmounted typed formula targets keep Rollup and dependent formulas current', async ({ page }) => {
  await page.getByRole('button', { name: 'Show related formulas', exact: true }).click();
  const rollup = page.getByTestId('rollup-cell-alpha-checked');
  const formula = page.getByTestId('formula-cell-alpha-rollup_formula');

  await expect(rollup).toHaveText('1');
  await expect(formula).toHaveText('11');
  await page.getByRole('button', { name: 'Edit related input', exact: true }).click();
  await expect(rollup).toHaveText('0');
  await expect(formula).toHaveText('10');
  await page.getByRole('button', { name: 'Fail related formula', exact: true }).click();
  await expect(rollup).toHaveText('Error');
  await expect(formula).toHaveAttribute('data-evaluation-state', 'error');
  await page.getByRole('button', { name: 'Null related formula', exact: true }).click();
  await expect(rollup).toHaveText('');
  await expect(formula).toHaveAttribute('data-evaluation-state', 'null');
});

test('native DateValue ranges retain endpoints and include_time through conversion', async ({ page }) => {
  await page.getByRole('button', { name: 'Use date range', exact: true }).click();
  const details = page.getByTestId('formula-details');

  await expect(details).toContainText(
    '"DateValue":{"start":"1789344000000","end":"1789516800000","include_time":false}'
  );
  await expect(details).toContainText('"rawDate":{"start":1789344000,"end":1789516800,"includeTime":false}');
  await page.getByRole('button', { name: 'Add day to range', exact: true }).click();
  await expect(details).toContainText('"rawDate":{"start":1789430400,"end":1789603200,"includeTime":false}');
  await page.getByRole('button', { name: 'Convert to Date', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  for (const id of ['alpha', 'beta']) {
    const converted = page.getByTestId(`converted-${id}`);

    await expect(converted).toHaveText('1789430400');
    await expect(converted).toHaveAttribute('data-range', 'true');
    await expect(converted).toHaveAttribute('data-end', '1789603200');
    await expect(converted).toHaveAttribute('data-include-time', 'false');
  }
});

test('timed date ranges and nested dates preserve milliseconds and date-only values', async ({ page }) => {
  await page.getByRole('button', { name: 'Use timed range', exact: true }).click();
  const details = page.getByTestId('formula-details');

  await expect(details).toContainText('"DateValue":{"start":"1789344000123","end":"1789516800456","include_time":true}');
  await expect(details).toContainText('"rawDate":{"start":1789344000.123,"end":1789516800.456,"includeTime":true}');
  await page.getByRole('button', { name: 'Use nested dates', exact: true }).click();
  await expect(details).toContainText(
    '"List":[{"DateValue":{"start":"1789344000123","end":"1789516800456","include_time":true}},{"DateValue":{"start":"1789315200000","end":null,"include_time":false}}]'
  );
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveAttribute('data-evaluation-state', 'value');
});

test('an unsafe range endpoint retains the native value and exposes a projection failure', async ({ page }) => {
  await page.getByRole('button', { name: 'Use unsafe range end', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('Error');
  const details = page.getByTestId('formula-details');

  await expect(details).toContainText('"errorSource":"host-projection"');
  await expect(details).toContainText('"end":"9007199254740993"');
  await page.getByRole('button', { name: 'Convert to Date', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toContainText('error:');
  await expect(page.getByTestId('stored-field-type')).toHaveText('Formula');
});

for (const value of ['NaN', 'Infinity', 'negative zero']) {
  test(`native ${value} remains a value across footer, Rollup and Number conversion`, async ({ page }) => {
    await page.getByRole('button', { name: `Use ${value}`, exact: true }).click();
    const expected = value === 'negative zero' ? '-0' : value;

    await expect(page.getByTestId('formula-details')).toContainText(`"rawNumeric":"${expected}"`);
    await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText(
      `${value === 'negative zero' ? 'Min' : 'Sum'}${expected}`
    );
    await expect(page.getByTestId('rollup-cell-alpha-checked')).toHaveText(expected);
    await expect(page.getByTestId('formula-cell-alpha-rollup_formula')).toHaveAttribute(
      'data-evaluation-state',
      'value'
    );
    await page.getByRole('button', { name: 'Convert to Number', exact: true }).click();
    await expect(page.getByTestId('conversion-state')).toHaveText('converted');
    await expect(page.getByTestId('converted-alpha')).toHaveText(expected);
    if (value === 'negative zero')
      await expect(page.getByTestId('converted-alpha')).toHaveAttribute('data-negative-zero', 'true');
  });
}

for (const target of ['owner', 'creator', 'editor']) {
  for (const computed of [false, true]) {
    test(`${
      computed ? 'Formula' : 'ordinary'
    } ${target} Rollup resolves current member names before conversion`, async ({ page }) => {
      if (computed) await page.getByRole('button', { name: 'Use computed member target', exact: true }).click();
      await page.getByRole('button', { name: `Use ${target} Rollup`, exact: true }).click();
      await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('Ada,Ada');
      await page.getByRole('button', { name: 'Convert to Text', exact: true }).click();
      await expect(page.getByTestId('conversion-state')).toHaveText('converted');
      await expect(page.getByTestId('converted-alpha')).toHaveText('Ada,Ada');
    });
  }
}

test('conversion retries changed related rows and target schema before it commits', async ({ page }) => {
  await page.getByRole('button', { name: 'Use external conversion', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('12');
  await page.getByRole('button', { name: 'Start held conversion', exact: true }).click();
  await page.waitForFunction(
    () => (window as unknown as { formulaConsumersEvidence: { held: boolean } }).formulaConsumersEvidence.held
  );
  await page.getByRole('button', { name: 'Edit external conversion', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  await expect(page.getByTestId('converted-alpha')).toHaveText('33');
  await expect(page.getByTestId('converted-beta')).toHaveText('');
});

test('a newer Text conversion supersedes a held Number conversion', async ({ page }) => {
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum12');
  await page.getByRole('button', { name: 'Start held conversion', exact: true }).click();
  await page.waitForFunction(
    () => (window as unknown as { formulaConsumersEvidence: { held: boolean } }).formulaConsumersEvidence.held
  );
  await page.getByRole('button', { name: 'Convert to Text', exact: true }).click();
  await page.getByRole('button', { name: 'Release held conversion', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  expect(
    await page.evaluate(
      () => (window as unknown as { formulaConsumersEvidence: { errors: string[] } }).formulaConsumersEvidence.errors
    )
  ).toEqual(expect.arrayContaining([expect.stringContaining('superseded')]));
  await expect(page.getByTestId('stored-field-type')).toHaveText('Text');
  await expect(page.getByTestId('converted-alpha')).toHaveText('4');
});

for (const change of ['Delete', 'Retype']) {
  test(`conversion abandons a ${change.toLowerCase()}d source field while native evaluation is held`, async ({
    page,
  }) => {
    await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum12');
    await page.getByRole('button', { name: 'Start held conversion', exact: true }).click();
    await page.waitForFunction(
      () => (window as unknown as { formulaConsumersEvidence: { held: boolean } }).formulaConsumersEvidence.held
    );
    await page.getByRole('button', { name: `${change} converting formula`, exact: true }).click();
    await expect(page.getByTestId('conversion-state')).toContainText('Field type changed');
    await expect(page.getByTestId('stored-field-type')).toHaveText(change === 'Delete' ? 'Deleted' : 'Checkbox');
  });
}

test('hidden member Rollups refresh native cells, footer and filter from the current roster', async ({ page }) => {
  await page.getByRole('button', { name: 'Use unique member list', exact: true }).click();
  await page.getByRole('button', { name: 'Use owner Rollup', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('Ada');
  await page.getByRole('button', { name: 'Show member length footer and filter', exact: true }).click();
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum3');
  await expect(page.getByTestId('consumer-orders')).toHaveText('');
  await page.getByRole('button', { name: 'Refresh stored member', exact: true }).click();
  await expect(page.getByTestId('member-profile-state')).toHaveText('Grace');
  await page.clock.setFixedTime(new Date('2026-01-02T02:00:31Z'));
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('5');
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum5');
  await expect(page.getByTestId('consumer-orders')).toHaveText('alpha');
});

test('relation membership changes update native cells, footer and conditions independently of titles', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Use relation membership', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('2');
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum2');
  await expect(page.getByTestId('consumer-orders')).toHaveText('alpha');
  await page.getByRole('button', { name: 'Delete first related member', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('1');
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum1');
  await page.getByRole('button', { name: 'Blank related title', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('1');
  await page.getByRole('button', { name: 'Restore first related member', exact: true }).click();
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum2');
  await page.getByRole('button', { name: 'Convert to Number', exact: true }).click();
  await expect(page.getByTestId('converted-alpha')).toHaveText('2');
});

test('replacement cells maps and row metadata are re-read across the render subscription gap', async ({ page }) => {
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum12');
  await page.getByRole('button', { name: 'Replace cells map', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('18');
  await page.getByRole('button', { name: 'Use edited timestamp', exact: true }).click();
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum4');
  await page.getByRole('button', { name: 'Edit row metadata', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('11');
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum13');
  await page.getByRole('button', { name: 'Edit between render and subscription', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('15');
});

test('commented native now() syntax keeps cells and footer current', async ({ page }) => {
  await page.getByRole('button', { name: 'Use commented clock', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('1767319200000');
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum3534638400000');
  await page.getByRole('button', { name: 'Filter clock values', exact: true }).click();
  await expect(page.getByTestId('consumer-orders')).toHaveText('');
  await page.clock.setFixedTime(new Date('2026-01-02T02:00:01Z'));
  await page.clock.fastForward(1000);
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('1767319201000');
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum3534638402000');
  await expect(page.getByTestId('consumer-orders')).toHaveText('alpha,beta');
  await page.getByRole('button', { name: 'Close all consumers', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { formulaConsumersEvidence: { terminated: number } }).formulaConsumersEvidence.terminated
      )
    )
    .toBe(1);
  const requests = await page.evaluate(
    () =>
      (window as unknown as { formulaConsumersEvidence: { requests: unknown[] } }).formulaConsumersEvidence.requests
        .length
  );

  await page.clock.fastForward(10_000);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { formulaConsumersEvidence: { requests: unknown[] } }).formulaConsumersEvidence.requests
          .length
    )
  ).toBe(requests);
});

test('commented native today() syntax follows local midnight', async ({ page }) => {
  await page.getByRole('button', { name: 'Use commented today', exact: true }).click();
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('1767283200000');
  await page.getByRole('button', { name: 'Filter clock values', exact: true }).click();
  await expect(page.getByTestId('consumer-orders')).toHaveText('');
  await page.clock.setFixedTime(new Date('2026-01-02T16:00:00Z'));
  await page.clock.fastForward(1100);
  await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('1767369600000');
  await expect(page.getByTestId('consumer-orders')).toHaveText('alpha,beta');
});

for (const viewer of ['ISO viewer', 'default viewer']) {
  test(`${viewer} date formatting survives native Formula conversion to Text`, async ({ page }) => {
    await page.getByRole('button', { name: 'Use viewer date', exact: true }).click();
    await page.getByRole('button', { name: 'Convert to Text', exact: true }).click();
    await expect(page.getByTestId('conversion-state')).toHaveText('converted');
    for (const id of ['alpha', 'beta']) {
      await expect(page.getByTestId(`converted-${id}`)).toHaveText(
        viewer === 'ISO viewer' ? '2024-03-10 09:30' : '03/10/2024 9:30 AM'
      );
    }
  });
}

test('ISO viewer date lists preserve date ranges and date-only text for offscreen rows', async ({ page }) => {
  await page.getByRole('button', { name: 'Use viewer date list', exact: true }).click();
  await page.getByRole('button', { name: 'Convert to Text', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  for (const id of ['alpha', 'beta']) {
    await expect(page.getByTestId(`converted-${id}`)).toHaveText('2024-03-10 09:30 → 2024-03-11 17:45, 2024-03-12');
  }
});

for (const target of ['SingleSelect', 'MultiSelect']) {
  test(`${target} conversion preserves existing options and deduplicates native values across offscreen rows`, async ({
    page,
  }) => {
    await page.getByRole('button', { name: `Prepare ${target} conversion`, exact: true }).click();
    await page.getByRole('button', { name: `Convert to ${target}`, exact: true }).click();
    await expect(page.getByTestId('conversion-state')).toHaveText('converted');
    const options = JSON.parse(await page.getByTestId('converted-select-options').innerText()) as {
      disable_color: boolean;
      options: { id: string; name: string; color: string }[];
    };

    expect(options.disable_color).toBe(true);
    expect(options.options).toEqual([
      { id: 'existing-option', name: 'Existing', color: 'Purple' },
      { id: 'unused-option', name: 'Unused', color: 'Blue' },
      expect.objectContaining({ name: 'New' }),
    ]);
    for (const id of ['alpha', 'beta']) {
      await expect(page.getByTestId(`converted-${id}`)).toHaveText(
        `existing-option,${options.options[2].id},${options.options[2].id}`
      );
      await expect(page.getByTestId(`select-option-cell-${id}-formula`)).toHaveText(
        target === 'SingleSelect' ? 'Existing' : 'ExistingNewNew'
      );
    }

    await expect(page.getByTestId('converted-gamma')).toHaveText('');
  });
}

for (const consumer of ['grid', 'timeline', 'filter']) {
  test(`${consumer} settles all 501 native relation titles and follows an edited title`, async ({ page }) => {
    if (consumer === 'timeline') await page.getByRole('button', { name: 'Use timeline footer', exact: true }).click();
    await page.getByRole('button', { name: 'Use 501 relation titles', exact: true }).click();
    if (consumer === 'filter')
      await page.getByRole('button', { name: 'Filter 501 relation titles', exact: true }).click();
    const footer = page.getByTestId('grid-calculate-cell-formula');

    await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('501');
    if (consumer === 'filter') await expect(page.getByTestId('consumer-orders')).toHaveText('alpha');
    else await expect(footer).toHaveText('Sum501');
    await page.getByRole('button', { name: 'Blank first of 501 titles', exact: true }).click();
    await expect(page.getByTestId('formula-cell-alpha-formula')).toHaveText('500');
    if (consumer === 'filter') await expect(page.getByTestId('consumer-orders')).toHaveText('');
    else await expect(footer).toHaveText('Sum500');
    await page.getByRole('button', { name: 'Restore first of 501 titles', exact: true }).click();
    if (consumer === 'filter') await expect(page.getByTestId('consumer-orders')).toHaveText('alpha');
    else await expect(footer).toHaveText('Sum501');
  });
}

test('database switches isolate native replies and reopen current rows and schema', async ({ page }) => {
  const formula = page.getByTestId('formula-cell-alpha-formula');

  await expect(formula).toHaveText('4');
  await page.getByRole('button', { name: 'Hold edited value', exact: true }).click();
  await page.waitForFunction(
    () => (window as unknown as { formulaConsumersEvidence: { held: boolean } }).formulaConsumersEvidence.held
  );
  await page.getByRole('button', { name: 'Open another database', exact: true }).click();
  await expect(formula).toHaveText('70');
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum110');
  const requests = await page.evaluate(
    () =>
      (window as unknown as { formulaConsumersEvidence: { requests: unknown[] } }).formulaConsumersEvidence.requests
        .length
  );

  await page.getByRole('button', { name: 'Edit closed original database', exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { formulaConsumersEvidence: { requests: unknown[] } }).formulaConsumersEvidence.requests
          .length
    )
  ).toBe(requests);
  await page.getByRole('button', { name: 'Release original database reply', exact: true }).click();
  await expect(formula).toHaveText('70');
  await page.getByRole('button', { name: 'Return original database', exact: true }).click();
  await expect(formula).toHaveText('15');
  await expect(page.getByTestId('grid-calculate-cell-formula')).toHaveText('Sum27');
});

for (const mode of ['grid', 'timeline']) {
  test(`${mode} configured Average accepts native numbers and nulls with Unknown type and rejects incompatible values`, async ({
    page,
  }) => {
    if (mode === 'timeline') await page.getByRole('button', { name: 'Use timeline footer', exact: true }).click();
    await page.getByRole('button', { name: 'Use Unknown numeric averages', exact: true }).click();
    const footer = page.getByTestId('grid-calculate-cell-formula');

    await expect(footer).toHaveText('Average3');
    await expect(page.getByTestId('rollup-cell-alpha-checked')).toHaveText('3');
    await page.getByRole('button', { name: 'Clear first average values', exact: true }).click();
    await expect(footer).toHaveText('Average4');
    await expect(page.getByTestId('rollup-cell-alpha-checked')).toHaveText('4');
    await page.getByRole('button', { name: 'Restore first average values', exact: true }).click();
    await expect(footer).toHaveText('Average3');
    await page.getByRole('button', { name: 'Use mixed native averages', exact: true }).click();
    await expect(footer).toHaveAttribute('data-evaluation-state', 'error');
    await expect(footer).toHaveText('Error');
    await expect(footer.getByRole('alert')).toHaveAttribute('title', /requires Number values/);
    await expect(page.getByTestId('rollup-cell-alpha-checked')).toHaveText('Error');
    await expect(page.getByTestId('formula-cell-alpha-rollup_formula')).toHaveAttribute(
      'data-evaluation-state',
      'error'
    );
  });
}
