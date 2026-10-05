import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { createNativeFormulaTest } from '../../support/native-formula-server';

import type coverage from '../../fixtures/native-formula-values.coverage.json';
import type authoredDataset from '../../fixtures/native-formula-values.dataset.json';
import type { ValuesReport } from '../../support/native-formula-values.fixture';

const test = createNativeFormulaTest('playwright/support/native-formula-values.fixture.ts');

test.use({ timezoneId: 'UTC' });
const originalBytes = readFileSync(new URL('../../fixtures/native-formula-values.dataset.json', import.meta.url));
const dataset = JSON.parse(originalBytes.toString('utf8')) as typeof authoredDataset;
const migration = JSON.parse(
  readFileSync(new URL('../../fixtures/native-formula-values.coverage.json', import.meta.url), 'utf8')
) as typeof coverage;

function expectedRaw(contract: (typeof dataset.contracts)[number], value: { expected: { normalized: string } }) {
  const expected = value.expected as {
    normalized: string;
    number?: number | null;
    boolean?: boolean;
    items?: string[];
    start_ms?: number | null;
    end_ms?: number | null;
    include_time?: boolean;
  };

  switch (contract.kind) {
    case 'number':
      return expected.number === null ? { type: 'empty' } : { type: 'number', value: expected.number };
    case 'boolean':
      return { type: 'boolean', value: expected.boolean };
    case 'list':
      return { type: 'list', items: expected.items!.map((value) => ({ type: 'text', value })) };
    case 'date':
      return expected.start_ms === null
        ? { type: 'empty' }
        : {
            type: 'date',
            value: { start: expected.start_ms, end: expected.end_ms ?? undefined, includeTime: expected.include_time },
          };
    default:
      return { type: 'text', value: expected.normalized };
  }
}

// Retain every authored stored value, both Formula references, missing/zero
// distinctions, member and relation names, range endpoints, and Yjs reload.
// Worker packaging or host projection failures must remain visible in evidence.
test('all 187 authored field values survive native Formula chains and Yjs reload', async ({
  page,
  formulaURL,
  formulaHTML,
}, testInfo) => {
  await page.route('**/formula-values-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: formulaHTML })
  );
  await page.goto(new URL('/formula-values-fixture', formulaURL).href);
  await page.waitForFunction(() => Boolean((window as unknown as { nativeValuesReport?: unknown }).nativeValuesReport));
  const report = await page.evaluate(
    () => (window as unknown as { nativeValuesReport: ValuesReport }).nativeValuesReport
  );
  const json = testInfo.outputPath('native-formula-values.json');
  const screenshot = testInfo.outputPath('native-formula-values.png');

  await writeFile(
    json,
    JSON.stringify(
      {
        ...report,
        authoredDataset: dataset,
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
  await testInfo.attach('native-formula-values.json', { path: json, contentType: 'application/json' });
  await testInfo.attach('native-formula-values.png', { path: screenshot, contentType: 'image/png' });

  expect(report.failures).toEqual([]);
  expect(report.workers).toBeGreaterThan(0);
  expect(report.evaluations).toBeGreaterThan(50);
  expect(report.serialization.bytes).toBeGreaterThan(0);
  expect(createHash('sha256').update(originalBytes).digest('hex')).toBe(migration.provenance.sha256);
  expect(dataset.contracts).toHaveLength(26);
  expect(new Set(dataset.contracts.map((contract) => contract.field_type)).size).toBe(20);
  expect(migration.overrides).toHaveLength(16);

  for (const phase of ['source', 'restored'] as const) {
    const states = report.states.filter((state) => state.phase === phase);

    expect(states).toHaveLength(187);
    for (const contract of dataset.contracts) {
      const values = dataset.value_sets[contract.value_set as keyof typeof dataset.value_sets];

      expect(states.filter((state) => state.contractId === contract.id)).toHaveLength(values.length);
      for (const value of values) {
        const id = `${phase}/${contract.id}/${value.id}`;
        const state = states.find((state) => state.contractId === contract.id && state.valueId === value.id);

        expect.soft(state, id).toBeDefined();
        if (!state) continue;
        expect.soft(state.result.error, id).toBeUndefined();
        expect.soft(state.result.evaluationState, id).toBe('value');
        const result = state.result.value;

        expect.soft(result.type, id).toBe('list');
        if (result.type !== 'list') continue;
        const override = migration.overrides.find((entry) => entry.state === `${contract.id}/${value.id}`);
        let raw = expectedRaw(contract, value);
        const predicate = override && 'predicate' in override ? override.predicate : value.expected.truth;

        if (override && 'rawNumber' in override)
          raw = { type: 'number', value: override.rawNumber === 'NaN' ? Number.NaN : -0 };

        expect.soft(result.items, id).toHaveLength(6);
        expect.soft(result.items[0], `${id}/raw`).toEqual(raw);
        expect.soft(result.items[1], `${id}/two-formula-chain`).toEqual(raw);
        expect
          .soft(result.items[2], `${id}/predicate`)
          .toEqual(predicate === null ? { type: 'empty' } : { type: 'boolean', value: predicate });
        expect.soft(result.items[3], `${id}/normalizer`).toEqual({
          type: 'text',
          value: override && 'normalized' in override ? override.normalized : value.expected.normalized,
        });
        expect.soft(result.items[4], `${id}/empty`).toEqual({
          type: 'boolean',
          value: override && 'empty' in override ? override.empty : value.expected.empty,
        });
        expect.soft(result.items[5], `${id}/guarded-branch`).toEqual(predicate ? raw : { type: 'empty' });
      }
    }
  }

  // Independent subset oracles from the retained Campaign dataset: the zero
  // rate counts in Average's denominator; the unsent campaign contributes null.
  const averages = [null, 20, 40, 30, 0, 10, 20, 20, null, 20, 40, 30, 0, 10, 20, 20];

  expect(report.campaign).toHaveLength(32);
  for (const phase of ['source', 'restored'] as const) {
    for (const [index, row] of report.campaignRates.filter((row) => row.phase === phase).entries()) {
      expect.soft(row.result.error, `${phase}/${row.rowId}/source-rate`).toBeUndefined();
      expect.soft(row.result.evaluationState, `${phase}/${row.rowId}/source-rate`).toBe(index === 3 ? 'null' : 'value');
    }

    expect(report.campaignRates.filter((row) => row.phase === phase).map((row) => row.result.value)).toEqual([
      { type: 'number', value: 20 },
      { type: 'number', value: 40 },
      { type: 'number', value: 0 },
      { type: 'empty' },
    ]);
    for (const [mask, average] of averages.entries()) {
      const id = `${phase}/campaign/${mask}`;
      const state = report.campaign.find((state) => state.phase === phase && state.mask === mask);

      expect.soft(state, id).toBeDefined();
      if (!state) continue;
      expect.soft(state.result.error, id).toBeUndefined();
      expect.soft(state.rollup?.error, id).toBeUndefined();
      expect.soft(state.rollup?.rawNumeric, `${id}/production-average`).toBe(average ?? undefined);
      expect.soft(state.result.value, `${id}/downstream-formula`).toEqual({
        type: 'list',
        items: [
          average === null ? { type: 'empty' } : { type: 'number', value: average },
          { type: 'text', value: average ? `${average}% average` : 'No positive rate' },
        ],
      });
    }
  }
});
