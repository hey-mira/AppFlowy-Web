import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

const test = createNativeFormulaTest('playwright/support/native-formula-conversion-sync.fixture.tsx');

test.beforeEach(async ({ page, formulaURL, formulaHTML }) => {
  await page.route('**/conversion-sync-fixture*', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/conversion-sync-fixture', formulaURL).href);
  await expect(page.getByTestId('conversion-workers')).toHaveText('0');
});

test.afterEach(async ({ page }, testInfo) => {
  const artifact = await page.evaluate(() => ({
    evidence: (window as unknown as { conversionSyncEvidence: unknown }).conversionSyncEvidence,
    outputs: Array.from(document.querySelectorAll('output'), (element) => ({
      id: element.getAttribute('data-testid'),
      text: element.textContent,
    })),
  }));
  const json = testInfo.outputPath('native-formula-conversion-sync.json');
  const screenshot = testInfo.outputPath('native-formula-conversion-sync.png');

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
  await testInfo.attach('native-formula-conversion-sync.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-conversion-sync.png', { path: screenshot, contentType: 'image/png' });
});

test('conversion without display owners reads current remote metadata for every row', async ({ page }) => {
  await page.getByRole('button', { name: 'Remote metadata times three', exact: true }).click();
  await page.getByRole('button', { name: 'Convert Formula to Number', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  await expect(page.getByTestId('converted-alpha')).toHaveText('36');
  await expect(page.getByTestId('converted-beta')).toHaveText('48');
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
});

test('conversion observes remote metadata changes while its native evaluation is held', async ({ page }) => {
  await page.getByRole('button', { name: 'Hold native conversion', exact: true }).click();
  await expect(page.getByTestId('conversion-held')).toHaveText('true');
  await page.getByRole('button', { name: 'Remote metadata times three', exact: true }).click();
  await page.getByRole('button', { name: 'Release native conversion', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  await expect(page.getByTestId('converted-alpha')).toHaveText('36');
  await expect(page.getByTestId('converted-beta')).toHaveText('48');
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
});

test('cancelling a held conversion releases metadata sync and preserves the Formula field', async ({ page }) => {
  await page.getByRole('button', { name: 'Hold native conversion', exact: true }).click();
  await expect(page.getByTestId('conversion-held')).toHaveText('true');
  await expect(page.getByTestId('conversion-owners')).toHaveText('1');
  await page.getByRole('button', { name: 'Cancel conversion', exact: true }).click();
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
  await expect(page.getByTestId('metadata-listeners')).toHaveText('0');
  await expect(page.getByTestId('stored-type')).toHaveText('Formula');
  await page.getByRole('button', { name: 'Remote metadata times three', exact: true }).click();
  await page.getByRole('button', { name: 'Release native conversion', exact: true }).click();
  await expect(page.getByTestId('converted-alpha')).toHaveText('');
  await expect(page.getByTestId('converted-beta')).toHaveText('');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const evidence = (window as unknown as { conversionSyncEvidence: { workers: number; terminated: number } })
          .conversionSyncEvidence;

        return evidence.workers === evidence.terminated;
      })
    )
    .toBe(true);
});

test('a metadata load arriving after conversion cancellation installs no listeners or Workers', async ({ page }) => {
  await page.getByRole('button', { name: 'Hold metadata load', exact: true }).click();
  await page.getByRole('button', { name: 'Convert Formula to Number', exact: true }).click();
  await expect(page.getByTestId('metadata-held')).toHaveText('true');
  await page.getByRole('button', { name: 'Cancel conversion', exact: true }).click();
  await page.getByRole('button', { name: 'Release metadata load', exact: true }).click();
  await expect(page.getByTestId('old-conversion-state')).toContainText('superseded');
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
  await expect(page.getByTestId('metadata-listeners')).toHaveText('0');
  await expect(page.getByTestId('stored-type')).toHaveText('Formula');
  await expect(page.getByTestId('metadata-attachments')).toHaveText('0');
  await expect(page.getByTestId('conversion-workers')).toHaveText('1');
  await expect(page.getByTestId('converted-alpha')).toHaveText('');
});

test('native Formula waits for a required cold Rollup row before publishing its complete sum', async ({ page }) => {
  await page.getByRole('button', { name: 'Use cold related row', exact: true }).click();
  await page.getByRole('button', { name: 'Open native Formula', exact: true }).click();
  await expect(page.getByTestId('cold-row-returned')).toHaveText('true');
  await expect(page.getByTestId('live-formula')).toHaveAttribute('data-state', 'pending');
  await expect(page.getByTestId('live-formula')).toHaveText('');
  await page.getByRole('button', { name: 'Hydrate related row', exact: true }).click();
  await expect(page.getByTestId('live-formula')).toHaveAttribute('data-state', 'value');
  await expect(page.getByTestId('live-formula')).toHaveText('28');
  await page.getByRole('button', { name: 'Close native Formula', exact: true }).click();
  await expect(page.getByTestId('cold-row-listeners')).toHaveText('0');
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
});

test('permanent conversion waits for every required cold Rollup row before committing', async ({ page }) => {
  await page.getByRole('button', { name: 'Use cold related row', exact: true }).click();
  await page.getByRole('button', { name: 'Convert Formula to Number', exact: true }).click();
  await expect(page.getByTestId('cold-row-returned')).toHaveText('true');
  await expect(page.getByTestId('conversion-state')).toHaveText('pending');
  await expect(page.getByTestId('stored-type')).toHaveText('Formula');
  await expect(page.getByTestId('converted-alpha')).toHaveText('');
  await page.getByRole('button', { name: 'Hydrate related row', exact: true }).click();
  await expect(page.getByTestId('conversion-state')).toHaveText('converted');
  await expect(page.getByTestId('converted-alpha')).toHaveText('28');
  await expect(page.getByTestId('converted-beta')).toHaveText('16');
  await expect(page.getByTestId('cold-row-listeners')).toHaveText('0');
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
});

test('required cold Rollup row timeout is a host failure in a native Formula', async ({ page }) => {
  await page.getByRole('button', { name: 'Use cold related row', exact: true }).click();
  await page.getByRole('button', { name: 'Open native Formula', exact: true }).click();
  await expect(page.getByTestId('cold-row-returned')).toHaveText('true');
  await expect(page.getByTestId('live-formula')).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('live-formula')).toHaveAttribute('data-error-source', 'host');
  await expect(page.getByTestId('live-formula')).toContainText('child-one');
  await page.getByRole('button', { name: 'Close native Formula', exact: true }).click();
  await expect(page.getByTestId('cold-row-listeners')).toHaveText('0');
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
});

test('required cold Rollup row timeout refuses conversion and preserves all stored cells', async ({ page }) => {
  await page.getByRole('button', { name: 'Use cold related row', exact: true }).click();
  await page.getByRole('button', { name: 'Convert Formula to Number', exact: true }).click();
  await expect(page.getByTestId('old-conversion-state')).toContainText('error:');
  await expect(page.getByTestId('old-conversion-state')).toContainText('child-one');
  await expect(page.getByTestId('stored-type')).toHaveText('Formula');
  await expect(page.getByTestId('converted-alpha')).toHaveText('');
  await expect(page.getByTestId('converted-beta')).toHaveText('');
  await expect(page.getByTestId('cold-row-listeners')).toHaveText('0');
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
});

test('cancelling conversion during required row hydration releases its waiting listener immediately', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Use cold related row', exact: true }).click();
  await page.getByRole('button', { name: 'Convert Formula to Number', exact: true }).click();
  await expect(page.getByTestId('cold-row-returned')).toHaveText('true');
  await expect(page.getByTestId('conversion-state')).toHaveText('pending');
  await page.getByRole('button', { name: 'Cancel conversion', exact: true }).click();
  await expect(page.getByTestId('cold-row-listeners')).toHaveText('0');
  await expect(page.getByTestId('conversion-owners')).toHaveText('0');
  await expect(page.getByTestId('old-conversion-state')).toContainText('superseded');
  await page.getByRole('button', { name: 'Hydrate related row', exact: true }).click();
  await expect(page.getByTestId('stored-type')).toHaveText('Formula');
  await expect(page.getByTestId('converted-alpha')).toHaveText('');
});
