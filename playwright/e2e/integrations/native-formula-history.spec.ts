import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

const test = createNativeFormulaTest('playwright/support/native-formula-history.fixture.tsx');

test.afterEach(async ({ page }, testInfo) => {
  const evidence = await page.evaluate(() =>
    (window as unknown as { verifyFormulaHistory: () => unknown }).verifyFormulaHistory()
  );
  const json = testInfo.outputPath('native-formula-history.json');
  const screenshot = testInfo.outputPath('native-formula-history.png');

  await writeFile(json, JSON.stringify({ evidence, browserVersion: page.context().browser()?.version() }, null, 2));
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-history.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-history.png', { path: screenshot, contentType: 'image/png' });
});

// Snapshot reads must ignore warm current member names and current relation
// loaders, including when only the document's immutable marker identifies history.
for (const marker of [false, true]) {
  for (const source of ['rollups', 'people']) {
    for (const consumer of ['cell', 'footer', 'filter', 'sort']) {
      test(`${marker ? 'marker' : 'explicit'} history ${source} ${consumer} stays isolated from current data`, async ({
        page,
        formulaURL,
        formulaHTML,
      }) => {
        await page.route('**/formula-history-fixture?**', (route) =>
          route.fulfill({ contentType: 'text/html', body: formulaHTML })
        );
        await page.goto(
          new URL(`/formula-history-fixture?source=${source}&consumer=${consumer}&marker=${Number(marker)}`, formulaURL)
            .href
        );
        const first = source === 'people' ? 'Saved Zed|User 42' : '9|external-z';
        const second = source === 'people' ? 'Saved Ada|User 43' : '2|external-a';

        if (consumer === 'cell') {
          await expect(page.getByTestId('formula-cell-row-z-formula')).toHaveText(first);
          await expect(page.getByTestId('rollup-cell-row-z-rollup')).toHaveText('9');
        } else if (consumer === 'footer') {
          await expect(page.getByTestId('history-footer')).toHaveAttribute('data-ready', 'true');
          await expect(page.getByTestId('history-footer')).toHaveText(`${first};${second}`);
        } else {
          await expect(page.getByTestId('history-orders')).toHaveText(consumer === 'filter' ? 'row-z' : 'row-a,row-z');
        }

        expect(
          await page.evaluate(() =>
            (window as unknown as { verifyFormulaHistory: () => unknown }).verifyFormulaHistory()
          )
        ).toEqual({ liveLoads: 0, warmedCurrentMembers: true, unchanged: true });
      });
    }
  }
}
