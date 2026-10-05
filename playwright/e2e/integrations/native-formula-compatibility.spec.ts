import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

import type { CompatibilityReport } from '../../support/native-formula-compatibility.fixture';
import type { Column, Value } from '@notion-formula/sdk';

const test = createNativeFormulaTest('playwright/support/native-formula-compatibility.fixture.ts');

function decode(value: Value | null): unknown {
  if (value === null) return null;
  if ('List' in value) return value.List.map(decode);
  return Object.values(value)[0];
}

function rowValue(column: Column, row = 0): unknown {
  if ('List' in column) return column.List.validity[row] ? column.List.values[row].map(decode) : null;
  if ('Union' in column) return column.Union.validity[row] ? decode(column.Union.values[row]) : null;
  const values = Object.values(column)[0];

  return values.validity[row] ? values.values[row] : null;
}

// Keep the existing user-facing examples honest after replacing the language:
// unsupported calls, required arity, wrong result values, packaging failures,
// and a JavaScript-only documentation path must be observable through the SDK.
test('documented formula examples execute through the packaged native engine', async ({
  page,
  formulaURL,
  formulaHTML,
}, testInfo) => {
  await page.route('**/formula-compatibility-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/formula-compatibility-fixture', formulaURL).href);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { nativeCompatibilityReport?: unknown }).nativeCompatibilityReport)
  );
  const report = await page.evaluate(
    () => (window as unknown as { nativeCompatibilityReport: CompatibilityReport }).nativeCompatibilityReport
  );
  const json = testInfo.outputPath('native-formula-compatibility.json');
  const screenshot = testInfo.outputPath('native-formula-compatibility.png');

  await writeFile(
    json,
    JSON.stringify(
      {
        ...report,
        profile: process.env.FORMULA_FIXTURE_PRODUCTION === '1' ? 'production' : 'development',
        browserVersion: page.context().browser()?.version(),
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
      2
    )
  );
  await page.screenshot({ path: screenshot });
  await testInfo.attach('native-formula-compatibility.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-compatibility.png', { path: screenshot, contentType: 'image/png' });

  expect(report.failure).toBeUndefined();
  expect(report.examples.length).toBeGreaterThan(100);
  let compared = 0;

  for (const example of report.examples) {
    if (example.status === 'requires-properties') continue;
    expect.soft(example.status, `${example.expression}: ${example.diagnostics.join('; ')}`).toBe('ready');
    if (!example.column || example.status !== 'ready') continue;
    // Date example prose describes formatting, not a JSON representation of
    // the underlying timestamp. Temporal functions still must execute above.
    if ('Date' in example.column || 'DateValue' in example.column) continue;
    let expected: unknown;

    try {
      expected = example.expected === 'empty' ? null : JSON.parse(example.expected);
    } catch {
      continue;
    }

    if (example.name === 'id') expected = report.rowId;
    expect.soft(rowValue(example.column), example.expression).toEqual(expected);
    compared += 1;
  }

  expect(compared).toBeGreaterThan(75);
  expect(report.workflows?.rows).toHaveLength(21);

  for (const formula of report.workflows?.formulas ?? []) {
    expect.soft(formula.output, `${formula.id}: ${formula.diagnostics.join('; ')}`).toBeDefined();
  }

  for (const [index, row] of (report.workflows?.rows ?? []).entries()) {
    const output = report.workflows?.formulas.find((formula) => formula.id === row.formulaId)?.output;

    if (!output) continue;
    expect
      .soft(
        output.errors.filter((error) => error.row_index === index),
        row.id
      )
      .toEqual([]);
    expect.soft(rowValue(output.column, index), row.id).toBe(row.expected);
  }

  expect(report.business?.map((scenario) => scenario.rows.length)).toEqual([16, 768, 256]);
  for (const scenario of report.business ?? []) {
    expect(scenario.rows).toHaveLength(scenario.caseCount);
    for (const [index, row] of scenario.rows.entries()) {
      for (const [id, expected] of Object.entries(row.expected)) {
        const output = scenario.outputs.find((formula) => formula.id === id)?.output;

        expect.soft(output, `${row.id}/${id}`).toBeDefined();
        if (!output) continue;
        expect
          .soft(
            output.errors.filter((error) => error.row_index === index),
            `${row.id}/${id}`
          )
          .toEqual([]);
        const actual = rowValue(output.column, index);

        if (typeof expected === 'number') expect.soft(actual, `${row.id}/${id}`).toBeCloseTo(expected, 10);
        else expect.soft(actual, `${row.id}/${id}`).toEqual(expected);
      }
    }
  }
});
