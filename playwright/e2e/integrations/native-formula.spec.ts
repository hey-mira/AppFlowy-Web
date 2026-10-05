import { expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import { test } from '../../support/native-formula-server';

test.use({ timezoneId: 'Asia/Singapore' });

async function attachArtifact(page: Page, testInfo: TestInfo, name: string, artifact: unknown) {
  const json = testInfo.outputPath(`${name}.json`);
  const screenshot = testInfo.outputPath(`${name}.png`);

  await writeFile(
    json,
    JSON.stringify(
      {
        ...(artifact && typeof artifact === 'object' ? artifact : { artifact }),
        profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
        browserVersion: page.context().browser()?.version(),
      },
      (_key, value: unknown) => {
        if (typeof value === 'bigint') return String(value);
        return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
      },
      2
    )
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach(`${name}.json`, { path: json, contentType: 'application/json' });
  await testInfo.attach(`${name}.png`, { path: screenshot, contentType: 'image/png' });
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => console.error('Native formula fixture:', error.message));
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const evidence = await page.evaluate(
    () => (window as unknown as { formulaEvidence?: Record<string, unknown> }).formulaEvidence
  );

  const body = JSON.stringify(
    evidence ?? {},
    (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
    2
  );
  const path = testInfo.outputPath('native-formula-failure.json');

  console.error('Native formula failure evidence:', path);
  await writeFile(path, body);
  await testInfo.attach('native-formula-failure.json', { path, contentType: 'application/json' });
  const error = page.locator('[data-testid^="formula-cell-error-"]').first();

  if (await error.count()) {
    await error.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    console.error('Native formula failure:', await page.getByRole('tooltip').textContent());
  }
});

// Failure modes at this isolated browser seam: JS silently evaluates instead
// of Rust; a Worker is created per cell/row; transitive formula updates or a
// rename are missed; offscreen rows are absent from sort/filter; an old row or
// schema response is published; pending/error/NotReady masquerades as null;
// native number NaN is erased; closing retains subscriptions or the Worker.
test('shared Rust results drive cells and offscreen formula conditions', async ({
  page,
  formulaURL,
  formulaHTML,
}, testInfo) => {
  const errors: string[] = [];
  const wasmResponses: Array<{ url: string; status: number; contentType?: string }> = [];

  page.on('pageerror', (error) => errors.push(error.message));
  page.context().on('response', (response) => {
    if (!new URL(response.url()).pathname.endsWith('.wasm')) return;
    wasmResponses.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()['content-type'],
    });
  });
  await page.route('**/native-formula-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/native-formula-fixture', formulaURL).href);
  const subtotal = page.getByTestId('formula-cell-alpha-subtotal');
  const total = page.getByTestId('formula-cell-alpha-total');
  const order = page.getByTestId('row-order');
  const evidence = () =>
    page.evaluate(() => (window as unknown as { formulaEvidence: Record<string, unknown> }).formulaEvidence);

  await expect(total).toHaveAttribute('data-evaluation-state', 'value');
  await expect(subtotal).toHaveText('20');
  await expect(total).toHaveText('25');
  await expect(total).toHaveAttribute('data-result-type', 'number');
  await expect(order).toHaveText('alpha,gamma');
  expect((await evidence()).workers).toBe(1);
  expect(wasmResponses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: 200, contentType: expect.stringContaining('application/wasm') }),
    ])
  );
  if (process.env.FORMULA_FIXTURE_PRODUCTION === '1') {
    const workerURLs = (await evidence()).workerURLs as string[];

    expect(workerURLs).toHaveLength(1);
    expect(workerURLs[0]).toMatch(/\/assets\/worker-[^/]+\.js(?:\?|$)/);
    expect(wasmResponses[0].url).toMatch(/\/assets\/analyzer_wasm_bg-[^/]+\.wasm(?:\?|$)/);
  }

  const initialRequests = (await evidence()).requests as Array<{ runtime?: { now: string; timeZone: string } }>;

  expect(initialRequests.filter((request) => request.runtime).map((request) => request.runtime!.timeZone)).toEqual([
    '+08:00',
  ]);

  await page.getByRole('button', { name: 'Set Price to 15', exact: true }).click();
  await expect(subtotal).toHaveText('30');
  await expect(total).toHaveText('35');
  await expect(order).toHaveText('alpha,gamma');
  await page.getByRole('button', { name: 'Rename Price', exact: true }).click();
  await expect(total).toHaveText('35');

  await page.getByRole('button', { name: 'Hold Price 7 result', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { formulaEvidence: { held: boolean } }).formulaEvidence.held);
  await expect(total).toHaveAttribute('data-evaluation-state', 'pending');
  await expect(order).toHaveText('alpha,gamma');
  await page.getByRole('button', { name: 'Remove Gamma', exact: true }).click();
  await expect(order).toHaveText('alpha');
  await page.getByRole('button', { name: 'Restore Gamma', exact: true }).click();
  const observedBefore = ((await evidence()).observed as unknown[]).length;

  await page.getByRole('button', { name: 'Set Price to 11', exact: true }).click();
  await expect(total).toHaveText('27');
  expect(
    ((await evidence()).observed as { total?: number }[]).slice(observedBefore).map((value) => value.total)
  ).not.toContain(19);
  await page.getByRole('button', { name: 'Change Total formula', exact: true }).click();
  await expect(total).toHaveText('32');
  await expect(order).toHaveText('beta,alpha,gamma');

  await page.getByRole('button', { name: 'Missing input', exact: true }).click();
  await expect(total).toHaveAttribute('data-evaluation-state', 'not-ready');
  await expect(page.getByTestId('formula-cell-error-alpha-total')).toBeVisible();
  await expect(total).toHaveAttribute('data-result-type', 'any');
  await page.getByRole('button', { name: 'Cycle', exact: true }).click();
  await expect(total).toHaveAttribute('data-evaluation-state', 'not-ready');

  await page.getByRole('button', { name: 'Row error', exact: true }).click();
  await expect(total).toHaveAttribute('data-evaluation-state', 'error');
  await expect(total).toHaveAttribute('data-error-source', 'runtime');
  await expect(page.getByTestId('formula-cell-error-alpha-total')).toBeVisible();

  await page.getByRole('button', { name: 'Numeric NaN', exact: true }).click();
  await expect(total).toHaveAttribute('data-evaluation-state', 'value');
  await expect(total).toHaveText('NaN');
  await page.getByRole('button', { name: 'Show Price', exact: true }).click();
  await expect(total).toHaveText('11');
  await page.getByRole('button', { name: 'Clear Price', exact: true }).click();
  await expect(total).toHaveAttribute('data-evaluation-state', 'null');
  await expect(total).toHaveText('');

  const beforeClose = await evidence();

  await page.getByRole('button', { name: 'Close database', exact: true }).click();
  await expect.poll(async () => (await evidence()).terminated).toBe(1);
  await page.getByRole('button', { name: 'Set Price to 15', exact: true }).click();
  expect((await evidence()).evaluations).toBe(beforeClose.evaluations);
  await page.getByRole('button', { name: 'Open database', exact: true }).click();
  await expect(total).toHaveText('15');
  expect((await evidence()).workers).toBe(2);
  expect(errors).toEqual([]);
  const artifact = {
    scenario: 'Price × Quantity → Subtotal → Total; shared formula cells/filter/sort',
    profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
    browser: await page.evaluate(() => navigator.userAgent),
    timezone: 'Asia/Singapore',
    timezoneContract: {
      observedBeforeFix: {
        code: 'EVALUATE_INPUT',
        message: 'Invalid evaluation input',
        payload: { error: { InvalidTimeZone: { time_zone: 'Asia/Singapore' } } },
      },
      correctedOffset: '+08:00',
      callerNow: initialRequests.find((request) => request.runtime)?.runtime?.now,
    },
    evidence: await evidence(),
    wasmResponses,
    errors,
    total: await total.textContent(),
    order: await order.textContent(),
  };

  await attachArtifact(page, testInfo, 'native-formula-evidence', artifact);
});

// Native errors may contain multiple failures per row. Keeping only the first
// message would lose their dependency origins and their structured payloads.
test('every native row error retains its dependency origin and payload', async ({
  page,
  formulaURL,
  formulaHTML,
}, testInfo) => {
  await page.route('**/native-formula-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/native-formula-fixture', formulaURL).href);
  const total = page.getByTestId('formula-cell-alpha-total');

  await expect(total).toHaveText('25');
  await page.getByRole('button', { name: 'Multiple dependency errors', exact: true }).click();
  await expect(total).toHaveAttribute('data-error-source', 'runtime');
  const evidence = await page.evaluate(
    () =>
      (
        window as unknown as {
          formulaEvidence: {
            cellErrors: Array<{ errors?: Array<{ origin_formula_id: string; error: unknown }> }>;
            nativeResults: unknown[];
          };
        }
      ).formulaEvidence
  );
  const errors = evidence.cellErrors.at(-1)?.errors;

  expect(errors).toHaveLength(2);
  expect(errors?.map((error) => error.origin_formula_id)).toEqual(['failure_one', 'failure_two']);
  expect(errors?.map((error) => error.error)).toEqual([
    expect.objectContaining({ InvalidRegex: expect.objectContaining({ pattern: '[' }) }),
    expect.objectContaining({ InvalidRegex: expect.objectContaining({ pattern: '[' }) }),
  ]);
  await attachArtifact(page, testInfo, 'native-formula-row-errors', evidence);
});

// A valid native i64 Date can exceed the host display's integer/date range.
// Projection must expose a host error without throwing through React or
// changing the native value into a real null.
test('native dates outside the host display range become projection errors', async ({
  page,
  formulaURL,
  formulaHTML,
}, testInfo) => {
  const pageErrors: string[] = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/native-formula-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/native-formula-fixture', formulaURL).href);
  const total = page.getByTestId('formula-cell-alpha-total');

  await expect(total).toHaveText('25');
  await page.getByRole('button', { name: 'Show huge date', exact: true }).click();
  await expect(total).toHaveAttribute('data-evaluation-state', 'error');
  await expect(total).toHaveAttribute('data-error-source', 'host-projection');
  await expect(page.getByTestId('formula-cell-alpha-subtotal')).toHaveText('20');
  await page.getByRole('button', { name: 'Clear huge date', exact: true }).click();
  await expect(total).toHaveAttribute('data-evaluation-state', 'null');
  expect(pageErrors).toEqual([]);
  const evidence = await page.evaluate(() => (window as unknown as { formulaEvidence: unknown }).formulaEvidence);

  await attachArtifact(page, testInfo, 'native-formula-date-projection', { evidence, pageErrors });
});

// A pending or failed host dependency must block only the native targets whose
// complete Ready dependency closure includes that Input. A host cycle is a
// permanent error; it must not keep all independent formulas pending forever.
test('independent Ready formulas continue through host loading, errors and cycles', async ({
  page,
  formulaURL,
  formulaHTML,
}, testInfo) => {
  await page.route('**/native-formula-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/native-formula-fixture', formulaURL).href);
  const total = page.getByTestId('formula-cell-alpha-total');
  const subtotal = page.getByTestId('formula-cell-alpha-subtotal');
  const external = page.getByTestId('formula-cell-alpha-external');
  const order = page.getByTestId('row-order');

  await expect(total).toHaveText('25');
  await page.getByRole('button', { name: 'Show external formula', exact: true }).click();
  await expect(external).toHaveAttribute('data-evaluation-state', 'pending');
  await expect(total).toHaveAttribute('data-evaluation-state', 'value');
  await expect(total).toHaveText('25');
  await expect(subtotal).toHaveText('20');
  await expect(order).toHaveText('alpha,gamma');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { formulaEvidence: { relationLoads: number } }).formulaEvidence.relationLoads
      )
    )
    .toBe(1);

  await page.getByRole('button', { name: 'Fail related database', exact: true }).click();
  await expect(external).toHaveAttribute('data-evaluation-state', 'error');
  await expect(external).toHaveAttribute('data-error-source', 'host');
  await expect(total).toHaveText('25');
  await expect(subtotal).toHaveText('20');
  await expect(order).toHaveText('alpha,gamma');

  await page.getByRole('button', { name: 'Host cycle', exact: true }).click();
  await expect(external).toHaveAttribute('data-evaluation-state', 'error');
  await expect(external).toHaveAttribute('data-error-source', 'host-cycle');
  await expect(total).toHaveText('25');
  await expect(order).toHaveText('alpha,gamma');
  const evidence = await page.evaluate(
    () => (window as unknown as { formulaEvidence: Record<string, unknown> }).formulaEvidence
  );

  expect(evidence.workers).toBe(1);
  await attachArtifact(page, testInfo, 'native-formula-host-dependencies', {
    evidence,
    external: await external.getAttribute('data-error-source'),
    total: await total.textContent(),
    order: await order.textContent(),
  });
});
