import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

import type { Page } from '@playwright/test';

const test = createNativeFormulaTest('playwright/support/native-formula-deletion.fixture.tsx');

type Evidence = {
  attemptedWorkers: number;
  workers: number;
  terminated: number;
  held: boolean;
  requests: Array<{ worker: number; method: string; args: unknown[] }>;
  replies: unknown[];
  pageErrors: string[];
};
type Fixture = {
  fields: Map<string, Map<string, unknown>>;
  databaseDoc: { transact: (operation: () => void) => void };
  setHold: (method: string) => void;
  selectTarget: (id: string) => void;
  release: () => void;
  documentState: () => {
    ids: string[];
    orders: string[];
    subtotal: string;
    total: string;
    rollupFormula: string;
    priceCell: unknown;
    otherName: unknown;
  };
};
const evidence = (page: Page) =>
  page.evaluate(() => (window as unknown as { deletionEvidence: Evidence }).deletionEvidence);

test.beforeEach(async ({ page, formulaURL, formulaHTML }) => {
  await page.route('**/native-formula-deletion-fixture*', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/native-formula-deletion-fixture', formulaURL).href);
  await expect(page.getByTestId('committed-total')).toHaveText('21');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test.afterEach(async ({ page }, testInfo) => {
  const json = testInfo.outputPath('native-formula-deletion-evidence.json');
  const screenshot = testInfo.outputPath('native-formula-deletion.png');

  await writeFile(
    json,
    JSON.stringify(
      {
        scenario: testInfo.title,
        status: testInfo.status,
        profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
        documents: await page.evaluate(() =>
          (window as unknown as { deletionFixture: Fixture }).deletionFixture.documentState()
        ),
        evidence: await evidence(page),
      },
      null,
      2
    )
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-deletion-evidence.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-deletion.png', { path: screenshot, contentType: 'image/png' });
});

test('native deletion warning includes transitive and already invalid formulas without changing committed evaluation', async ({
  page,
}) => {
  const warning = page.getByTestId('formula-deletion-warning');

  await expect(warning.locator('li')).toHaveText([
    'Base',
    'Total',
    'Invalid type',
    'Missing input',
    'Cycle A',
    'Cycle B',
  ]);
  await expect
    .poll(async () => (await evidence(page)).requests.some((request) => request.method === 'engine.remove'))
    .toBe(true);
  const requests = (await evidence(page)).requests;
  const committed = new Set(
    requests.filter((request) => request.method === 'engine.evaluate').map((request) => request.worker)
  );

  expect(
    requests.filter((request) => request.method === 'engine.remove').every((request) => !committed.has(request.worker))
  ).toBe(true);
  await expect(page.getByTestId('committed-total')).toHaveText('21');
  await expect(page.getByTestId('field-present')).toHaveText('true');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('field-present')).toHaveText('true');
  await expect
    .poll(async () => {
      const current = await evidence(page);

      return current.terminated === current.workers - 1;
    })
    .toBe(true);
});

test('relation deletion warning follows host rollups into native formula dependencies', async ({ page, formulaURL }) => {
  await page.goto(new URL('/native-formula-deletion-fixture?target=links', formulaURL).href);
  await expect(page.getByTestId('committed-total')).toHaveText('21');
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveText([
    'Rolled formula',
    'Rolled summary',
  ]);
  expect(
    (await evidence(page)).requests
      .filter((request) => request.method === 'engine.remove')
      .map((request) => request.args)
  ).toEqual([['links'], ['rollup']]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('field-present')).toHaveText('true');
  await expect(page.getByTestId('committed-total')).toHaveText('21');
});

for (const target of ['price', 'subtotal']) {
  test(`deleting ${target} through database history restores field order, cells and native results on undo and redo`, async ({
    page,
    formulaURL,
  }) => {
    await page.goto(new URL(`/native-formula-deletion-fixture?history=1&target=${target}`, formulaURL).href);
    await expect(page.getByTestId('committed-base')).toHaveText('20');
    await expect(page.getByTestId('committed-total')).toHaveText('21');
    await expect(page.getByTestId('committed-unrelated')).toHaveText('42');
    await expect(page.getByTestId('history-undo')).toBeDisabled();
    const orders = await page.getByTestId('field-orders').textContent();
    const afterDeletion = orders!
      .split(',')
      .filter((id) => id !== target)
      .join(',');

    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('field-present')).toHaveText('false');
    await expect(page.getByTestId('field-orders')).toHaveText(afterDeletion);
    await expect(page.getByTestId('committed-total')).toHaveAttribute('data-state', 'not-ready');
    await expect(page.getByTestId('committed-total')).toHaveAttribute('data-error', /not ready/);
    await expect(page.getByTestId('committed-total')).toHaveText('');
    await expect(page.getByTestId('committed-unrelated')).toHaveText('42');
    await expect(page.getByTestId('saved-total')).toHaveText('prop("subtotal") + 1');
    await expect(page.getByTestId('row-price')).toHaveText('10');
    if (target === 'price') {
      await expect(page.getByTestId('committed-base')).toHaveAttribute('data-state', 'not-ready');
      await expect(page.getByTestId('saved-subtotal')).toHaveText('prop("price") * 2');
    }

    await page.getByRole('button', { name: 'Undo deletion', exact: true }).click();
    await expect(page.getByTestId('field-present')).toHaveText('true');
    await expect(page.getByTestId('field-orders')).toHaveText(orders!);
    await expect(page.getByTestId('committed-base')).toHaveText('20');
    await expect(page.getByTestId('committed-base')).toHaveAttribute('data-number', '20');
    await expect(page.getByTestId('committed-total')).toHaveText('21');
    await expect(page.getByTestId('committed-total')).toHaveAttribute('data-state', 'value');
    await expect(page.getByTestId('committed-total')).toHaveAttribute('data-error', '');
    await expect(page.getByTestId('saved-subtotal')).toHaveText('prop("price") * 2');
    await expect(page.getByTestId('saved-total')).toHaveText('prop("subtotal") + 1');
    await expect(page.getByTestId('row-price')).toHaveText('10');
    await page.getByRole('button', { name: 'Redo deletion', exact: true }).click();
    await expect(page.getByTestId('field-present')).toHaveText('false');
    await expect(page.getByTestId('field-orders')).toHaveText(afterDeletion);
    await expect(page.getByTestId('committed-total')).toHaveAttribute('data-state', 'not-ready');
    await expect(page.getByTestId('committed-total')).toHaveText('');
    await expect(page.getByTestId('committed-unrelated')).toHaveText('42');
    await expect(page.getByTestId('saved-total')).toHaveText('prop("subtotal") + 1');
    await expect(page.getByTestId('row-price')).toHaveText('10');
  });
}

test('serialized deletion reloads into fresh documents without rebinding the missing ID to a reused name', async ({
  page,
  formulaURL,
}) => {
  await page.goto(new URL('/native-formula-deletion-fixture?history=1', formulaURL).href);
  await expect(page.getByTestId('committed-base')).toHaveText('20');
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('field-present')).toHaveText('false');
  await page.evaluate(() => {
    const fixture = (window as unknown as { deletionFixture: Fixture }).deletionFixture;

    fixture.fields.get('other')!.set('name', 'Price');
  });
  await expect(page.getByTestId('committed-base')).toHaveAttribute('data-state', 'not-ready');
  await page.getByRole('button', { name: 'Serialize documents', exact: true }).click();
  const saved = await page.evaluate(() =>
    (window as unknown as { deletionFixture: Fixture }).deletionFixture.documentState()
  );

  await page.goto(new URL('/native-formula-deletion-fixture?history=1&restore=1', formulaURL).href);
  await expect(page.getByTestId('field-present')).toHaveText('false');
  await expect(page.getByTestId('committed-base')).toHaveAttribute('data-state', 'not-ready');
  await expect(page.getByTestId('committed-total')).toHaveAttribute('data-state', 'not-ready');
  await expect(page.getByTestId('committed-unrelated')).toHaveText('42');
  await expect(page.getByTestId('saved-subtotal')).toHaveText('prop("price") * 2');
  await expect(page.getByTestId('saved-total')).toHaveText('prop("subtotal") + 1');
  await expect(page.getByTestId('row-price')).toHaveText('10');
  await expect(page.getByTestId('history-undo')).toBeDisabled();
  expect(
    await page.evaluate(() => (window as unknown as { deletionFixture: Fixture }).deletionFixture.documentState())
  ).toEqual(saved);
  expect(saved.otherName).toBe('Price');
});

test('native deletion warning follows stable IDs through rename and confirms actual deletion', async ({ page }) => {
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveCount(6);
  await page.evaluate(() => {
    const fixture = (window as unknown as { deletionFixture: Fixture }).deletionFixture;

    fixture.databaseDoc.transact(() => {
      fixture.fields.get('price')!.set('name', '单价😀');
      fixture.fields.get('other')!.set('name', 'Price');
      fixture.fields.get('subtotal')!.set('name', '合计😀');
    });
  });
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveText([
    '合计😀',
    'Total',
    'Invalid type',
    'Missing input',
    'Cycle A',
    'Cycle B',
  ]);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('field-present')).toHaveText('false');
  expect(
    await page.evaluate(() => {
      const fields = (window as unknown as { deletionFixture: Fixture }).deletionFixture.fields;
      const options = fields.get('subtotal')!.get('type_option') as Map<string, Map<string, unknown>>;

      return options.get('19')!.get('expression');
    })
  ).toBe('prop("price") * 2');
});

test('new schema and target supersede held deletion replies and cancellation closes private Workers', async ({
  page,
}) => {
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveCount(6);
  await page.evaluate(() => {
    const fixture = (window as unknown as { deletionFixture: Fixture }).deletionFixture;

    fixture.setHold('engine.remove');
    fixture.fields.get('price')!.set('name', 'Updated Price');
  });
  await expect.poll(async () => (await evidence(page)).held).toBe(true);
  await expect(page.getByTestId('formula-deletion-pending')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    const fixture = (window as unknown as { deletionFixture: Fixture }).deletionFixture;

    fixture.databaseDoc.transact(() => {
      for (const id of ['subtotal', 'total', 'invalid-type', 'missing', 'cycle-a', 'cycle-b']) {
        const options = fixture.fields.get(id)!.get('type_option') as Map<string, Map<string, unknown>>;

        options.get('19')!.set('expression', '0');
      }
    });
  });
  await expect(page.getByTestId('formula-deletion-pending')).toHaveCount(0);
  await expect(page.getByTestId('formula-deletion-warning')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { deletionFixture: Fixture }).deletionFixture.selectTarget('links'));
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveText([
    'Rolled formula',
    'Rolled summary',
  ]);
  await page.evaluate(() => (window as unknown as { deletionFixture: Fixture }).deletionFixture.release());
  await expect.poll(async () => (await evidence(page)).held).toBe(false);
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveText([
    'Rolled formula',
    'Rolled summary',
  ]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('field-present')).toHaveText('true');
  await expect
    .poll(async () => {
      const current = await evidence(page);

      return current.terminated === current.workers - 1;
    })
    .toBe(true);
});

test('private native dependency Worker failure is visible and Cancel remains safe', async ({ page, formulaURL }) => {
  await page.goto(new URL('/native-formula-deletion-fixture?fail=1', formulaURL).href);
  await expect(page.getByTestId('committed-total')).toHaveText('21');
  await expect(page.getByTestId('formula-deletion-error')).toContainText('Native dependency Worker failed');
  await expect(page.getByTestId('formula-deletion-pending')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('field-present')).toHaveText('true');
  const current = await evidence(page);

  expect(current.workers).toBeGreaterThanOrEqual(2);
  expect(current.terminated).toBe(current.workers - 1);
  expect(current.attemptedWorkers).toBe(current.workers);
  expect(current.pageErrors).toEqual([]);
});

test('Cancel while checking detaches the old warning before a new confirmation opens', async ({ page }) => {
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveCount(6);
  await page.evaluate(() => {
    const fixture = (window as unknown as { deletionFixture: Fixture }).deletionFixture;

    fixture.setHold('engine.remove');
    fixture.fields.get('price')!.set('name', 'Changed while checking');
  });
  await expect.poll(async () => (await evidence(page)).held).toBe(true);
  await expect(page.getByTestId('formula-deletion-pending')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('field-present')).toHaveText('true');
  await page.evaluate(() => (window as unknown as { deletionFixture: Fixture }).deletionFixture.selectTarget('links'));
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveText([
    'Rolled formula',
    'Rolled summary',
  ]);
  await page.evaluate(() => (window as unknown as { deletionFixture: Fixture }).deletionFixture.release());
  await expect.poll(async () => (await evidence(page)).held).toBe(false);
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveText([
    'Rolled formula',
    'Rolled summary',
  ]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('committed-total')).toHaveText('21');
  await expect
    .poll(async () => {
      const current = await evidence(page);

      return current.terminated === current.workers - 1;
    })
    .toBe(true);
});

test('deleting a configured relation leaves its Rollup and dependent formulas in an explicit failure state', async ({
  page,
  formulaURL,
}) => {
  await page.goto(new URL('/native-formula-deletion-fixture?rollup=1&target=links', formulaURL).href);
  await expect(page.getByTestId('committed-rollup-input')).toHaveText('6');
  await expect(page.getByTestId('committed-rollup')).toHaveText('12');
  await expect(page.getByTestId('committed-rollup-summary')).toHaveText('12');
  await expect(page.getByTestId('formula-deletion-warning').locator('li')).toHaveText([
    'Rolled formula',
    'Rolled summary',
  ]);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('field-present')).toHaveText('false');
  await expect(page.getByTestId('committed-rollup-input')).toHaveAttribute('data-error', /links/);
  for (const id of ['committed-rollup', 'committed-rollup-summary']) {
    await expect(page.getByTestId(id)).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId(id)).toHaveAttribute('data-error', /links/);
    await expect(page.getByTestId(id)).toHaveText('');
  }

  await expect(page.getByTestId('committed-total')).toHaveText('21');
});
