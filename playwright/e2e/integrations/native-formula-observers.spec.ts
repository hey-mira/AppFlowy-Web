import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

const test = createNativeFormulaTest('playwright/support/native-formula-observers.fixture.tsx');

test.beforeEach(async ({ page, formulaURL, formulaHTML }) => {
  await page.route('**/formula-observers-fixture*', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/formula-observers-fixture', formulaURL).href);
});

test.afterEach(async ({ page }, testInfo) => {
  const artifact = await page.evaluate(() => ({
    evidence: (window as unknown as { formulaObserverEvidence: unknown }).formulaObserverEvidence,
    outputs: Array.from(document.querySelectorAll('output'), (element) => ({
      id: element.getAttribute('data-testid'),
      state: element.getAttribute('data-evaluation-state'),
      text: element.textContent,
    })),
  }));
  const json = testInfo.outputPath('native-formula-observers.json');
  const screenshot = testInfo.outputPath('native-formula-observers.png');

  await writeFile(
    json,
    JSON.stringify(
      {
        ...artifact,
        browserVersion: page.context().browser()?.version(),
        profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
      },
      null,
      2
    )
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-observers.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-observers.png', { path: screenshot, contentType: 'image/png' });
});

// Zero is a value. Empty relation membership is null, and schema changes must
// refresh mounted Rollups even when their native Formula target is unmounted.
for (const summary of [false, true]) {
  test(`zero Formula Sum clears and restores relation membership (downstream summary: ${summary})`, async ({ page }) => {
    await page
      .getByRole('button', { name: summary ? 'Open zero Sum and summary' : 'Open zero Sum', exact: true })
      .click();
    await expect(page.getByTestId('owner-alpha-rollup')).toHaveText('0');
    if (summary) await expect(page.getByTestId('owner-summary')).toHaveText('Hours: 0');
    await page.getByRole('button', { name: 'Clear first relation', exact: true }).click();
    await expect(page.getByTestId('owner-alpha-rollup')).toHaveText('');
    await expect(page.getByTestId('owner-alpha-rollup')).toHaveAttribute('data-evaluation-state', 'null');
    if (summary) await expect(page.getByTestId('owner-summary')).toHaveText('Hours: ');
    await page.getByRole('button', { name: 'Restore first relation', exact: true }).click();
    await expect(page.getByTestId('owner-alpha-rollup')).toHaveText('0');
    if (summary) await expect(page.getByTestId('owner-summary')).toHaveText('Hours: 0');
    await page.getByRole('button', { name: 'Change target Formula to seven', exact: true }).click();
    await expect(page.getByTestId('owner-alpha-rollup')).toHaveText('7');
    if (summary) await expect(page.getByTestId('owner-summary')).toHaveText('Hours: 7');
  });
}

// Restore replaces and destroys source documents. Mounted native closures and
// their observers must rebind; edits to the restored rows remain observable.
test('native cell, filter and sort follow two external document restores', async ({ page }) => {
  await page.getByRole('button', { name: 'Open restored conditions', exact: true }).click();
  await expect(page.getByTestId('owner-alpha-formula')).toHaveText('20');
  await expect(page.getByTestId('observer-orders')).toHaveText('beta');
  await page.getByRole('button', { name: 'Restore older source', exact: true }).click();
  await expect(page.getByTestId('owner-alpha-formula')).toHaveText('60');
  await expect(page.getByTestId('observer-orders')).toHaveText('alpha');
  await page.getByRole('button', { name: 'Restore newer source', exact: true }).click();
  await expect(page.getByTestId('owner-alpha-formula')).toHaveText('100');
  await expect(page.getByTestId('observer-orders')).toHaveText('beta,alpha');
  await page.getByRole('button', { name: 'Edit restored first amount', exact: true }).click();
  await expect(page.getByTestId('owner-alpha-formula')).toHaveText('70');
  await expect(page.getByTestId('observer-orders')).toHaveText('alpha,beta');
});

// A cached related schema receives remote Yjs updates while any actual Rollup
// observer owns its sync. Disposing one must preserve the other's ownership.
test('two Rollup observers retain remote Formula metadata until the last disposal', async ({ page }) => {
  await page.getByRole('button', { name: 'Open remote schema observers', exact: true }).click();
  await expect(page.getByTestId('sync-first')).toHaveText('10');
  await expect(page.getByTestId('sync-second')).toHaveText('10');
  await expect(page.getByTestId('sync-owners')).toHaveText('2');
  await page.getByRole('button', { name: 'Remote Formula times two', exact: true }).click();
  await expect(page.getByTestId('sync-first')).toHaveText('20');
  await expect(page.getByTestId('sync-second')).toHaveText('20');
  await page.getByRole('button', { name: 'Dispose first observer', exact: true }).click();
  await expect(page.getByTestId('sync-owners')).toHaveText('1');
  await page.getByRole('button', { name: 'Remote Formula times three', exact: true }).click();
  await expect(page.getByTestId('sync-second')).toHaveText('30');
  await expect(page.getByTestId('sync-first')).toHaveText('20');
  await page.getByRole('button', { name: 'Dispose second observer', exact: true }).click();
  await expect(page.getByTestId('sync-owners')).toHaveText('0');
  await page.getByRole('button', { name: 'Remote Formula times four', exact: true }).click();
  await expect(page.getByTestId('cached-expression')).toHaveText('prop("amount") * 3');
  await expect(page.getByTestId('sync-second')).toHaveText('30');
});

test('Formula-only cell and conditions retain related realtime metadata and release the last owner', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open Formula-only realtime consumers', exact: true }).click();
  await expect(page.getByTestId('owner-alpha-formula')).toHaveText('20');
  await expect(page.getByTestId('observer-orders')).toHaveText('beta');
  await page.getByRole('button', { name: 'Remote standalone Formula times three', exact: true }).click();
  await expect(page.getByTestId('owner-alpha-formula')).toHaveText('60');
  await expect(page.getByTestId('observer-orders')).toHaveText('alpha,beta');
  await expect(page.getByTestId('realtime-owners')).toHaveText('1');
  await page.getByRole('button', { name: 'Close Formula-only cell', exact: true }).click();
  await page.getByRole('button', { name: 'Remote standalone Formula reverse order', exact: true }).click();
  await expect(page.getByTestId('observer-orders')).toHaveText('beta,alpha');
  await expect(page.getByTestId('realtime-owners')).toHaveText('1');
  await page.getByRole('button', { name: 'Close Formula-only conditions', exact: true }).click();
  await expect(page.getByTestId('realtime-owners')).toHaveText('0');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const evidence = (window as unknown as { formulaObserverEvidence: { workers: number; terminated: number } })
          .formulaObserverEvidence;

        return evidence.terminated === evidence.workers;
      })
    )
    .toBe(true);
  const requests = await page.evaluate(
    () =>
      (window as unknown as { formulaObserverEvidence: { requests: unknown[] } }).formulaObserverEvidence.requests.length
  );

  await page.getByRole('button', { name: 'Remote standalone Formula times four', exact: true }).click();
  await expect(page.getByTestId('realtime-cached-expression')).toHaveText('40 - prop("amount")');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { formulaObserverEvidence: { requests: unknown[] } }).formulaObserverEvidence.requests
          .length
    )
  ).toBe(requests);
});

for (const source of ['view', 'target']) {
  test(`required Rollup ${source} failure cannot become an ordinary null in a Formula`, async ({ page }) => {
    await page.getByRole('button', { name: `Open unavailable Rollup ${source}`, exact: true }).click();
    const formula = page.getByTestId('owner-alpha-formula');

    await expect(formula).toHaveAttribute('data-evaluation-state', 'error');
    await expect(formula).toHaveAttribute('data-error-source', 'host');
    await expect(formula).toContainText(source === 'view' ? 'database' : 'completed');
    await page.getByRole('button', { name: `Recover Rollup ${source}`, exact: true }).click();
    await expect(formula).toHaveAttribute('data-evaluation-state', 'value');
    await expect(formula).toHaveText('10');
  });
}

// Settings must get native static metadata without a visible target cell and
// refresh saved/stale selections when the target Formula's result type changes.
test('Rollup settings compile unmounted Formula targets and refresh result types', async ({ page }) => {
  await page.getByRole('button', { name: 'Open native target settings', exact: true }).click();
  await page.getByRole('button', { name: 'Select related database', exact: true }).click();
  await expect(page.getByTestId('settings-targets')).toHaveText('completed,amount,title');
  await expect(page.getByTestId('settings-target')).toHaveText('completed:Number');
  await expect(page.getByTestId('settings-stored-target-type')).toHaveText('Number');
  await page.getByRole('button', { name: 'Remember target selection', exact: true }).click();
  await page.getByRole('button', { name: 'Change settings Formula to boolean', exact: true }).click();
  await expect(page.getByTestId('settings-target')).toHaveText('completed:Checkbox');
  await page.getByRole('button', { name: 'Select remembered target', exact: true }).click();
  await expect(page.getByTestId('settings-stored-target-type')).toHaveText('Checkbox');
});

test('opening Rollup settings preserves an existing numeric calculation over Unknown Formula output', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open saved dynamic Average settings', exact: true }).click();
  await expect(page.getByTestId('settings-target')).toHaveText('completed:RichText');
  await expect(page.getByTestId('settings-calculation')).toHaveText('Average');
  await expect(page.getByTestId('owner-alpha-rollup')).toHaveText('10');
  await page.getByRole('button', { name: 'Clear saved dynamic amount', exact: true }).click();
  await expect(page.getByTestId('owner-alpha-rollup')).toHaveText('');
  await expect(page.getByTestId('settings-calculation')).toHaveText('Average');
});
