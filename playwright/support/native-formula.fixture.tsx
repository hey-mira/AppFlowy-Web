import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import { FormulaCell as FormulaCellValue } from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import {
  CalculationType,
  FieldType,
  FilterType,
  RollupDisplayMode,
  SortCondition,
} from '@/application/database-yjs/database.type';
import { NumberFilterCondition } from '@/application/database-yjs/fields/number/number.type';
import { useCellSelector, useRowOrdersSelector } from '@/application/database-yjs/selector';
import {
  YDatabase,
  YDatabaseCell,
  YDatabaseCells,
  YDatabaseField,
  YDatabaseFields,
  YDatabaseFilter,
  YDatabaseFilters,
  YDatabaseRow,
  YDatabaseSort,
  YDatabaseSorts,
  YDatabaseView,
  YDatabaseViews,
  YDoc,
  YjsDatabaseKey as K,
  YjsEditorKey as E,
} from '@/application/types';
import { FormulaCell } from '@/components/database/components/cell/formula/FormulaCell';
import '@/i18n/config';
import '@/styles/global.css';

// This fixture delays a real Worker response to exercise stale publication. All
// requests, values and errors still come from the SDK Worker and Rust/WASM.
const evidence = {
  workers: 0,
  workerURLs: [] as string[],
  terminated: 0,
  evaluations: 0,
  held: false,
  delayNext: false,
  relationLoads: 0,
  requests: [] as Array<{
    method: string;
    rowIds?: string[];
    formulaIds?: string[];
    runtime?: { now: string; timeZone: string };
  }>,
  observed: [] as Array<{ subtotal?: number; total?: number; state?: string }>,
  errors: [] as unknown[],
  nativeResults: [] as unknown[],
  cellErrors: [] as unknown[],
};
const BrowserWorker = window.Worker;
let releaseHeldResult: (() => void) | undefined;
let failRelatedLoad: (() => void) | undefined;

window.Worker = class extends BrowserWorker {
  private evaluationIds = new Set<number>();

  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    evidence.workers += 1;
    evidence.workerURLs.push(String(url));
    super.addEventListener(
      'message',
      (event: MessageEvent<{ id: number; error?: unknown; value?: { formulas?: Map<string, unknown> } }>) => {
        if (event.data.error) evidence.errors.push(event.data.error);
        if (event.data.value?.formulas instanceof Map) {
          evidence.nativeResults.push(
            JSON.parse(
              JSON.stringify(Array.from(event.data.value.formulas), (_key, value: unknown) =>
                typeof value === 'bigint'
                  ? String(value)
                  : typeof value === 'number' && !Number.isFinite(value)
                  ? String(value)
                  : value
              )
            )
          );
        }

        if (!this.evaluationIds.delete(event.data.id) || !evidence.delayNext) return;
        evidence.delayNext = false;
        evidence.held = true;
        event.stopImmediatePropagation();
        releaseHeldResult = () => {
          evidence.held = false;
          this.dispatchEvent(new MessageEvent('message', { data: event.data }));
          releaseHeldResult = undefined;
        };
      }
    );
  }

  postMessage(message: { id: number; method: string; args: unknown[] }) {
    const input = message.args?.[0] as
      | { row_ids?: string[]; formula_ids?: string[]; runtime?: { now: bigint; time_zone: string } }
      | undefined;

    evidence.requests.push({
      method: message.method,
      rowIds: input?.row_ids,
      formulaIds: input?.formula_ids,
      runtime: input?.runtime && { now: String(input.runtime.now), timeZone: input.runtime.time_zone },
    });
    if (message.method === 'engine.evaluate') {
      evidence.evaluations += 1;
      this.evaluationIds.add(message.id);
    }

    super.postMessage(message);
  }

  terminate() {
    evidence.terminated += 1;
    super.terminate();
  }
};

const databaseDoc = new Y.Doc() as YDoc;
const database = new Y.Map() as YDatabase;
const fields = new Y.Map() as YDatabaseFields;

databaseDoc.getMap(E.data_section).set(E.database, database);
database.set(K.fields, fields);

function field(id: string, name: string, type: FieldType, expression?: string) {
  const value = new Y.Map() as YDatabaseField;

  value.set(K.id, id);
  value.set(K.name, name);
  value.set(K.type, type);
  if (expression !== undefined) {
    const options = new Y.Map();
    const formula = new Y.Map();

    formula.set('expression', expression);
    options.set(String(FieldType.Formula), formula);
    value.set(K.type_option, options);
  }

  fields.set(id, value);
}

field('price', 'Price', FieldType.Number);
field('quantity', 'Quantity', FieldType.Number);
field('subtotal', 'Subtotal', FieldType.Formula, 'prop("price") * prop("quantity")');
field('total', 'Total', FieldType.Formula, 'prop("subtotal") + 5');
field('linked', 'Linked rows', FieldType.Relation);
field('rollup', 'Rollup', FieldType.Rollup);
field('external', 'External', FieldType.Formula, 'length(prop("linked"))');
field('huge_date', 'Huge date', FieldType.DateTime);
field('failure_one', 'Failure one', FieldType.Formula, 'test("x", "[")');
field('failure_two', 'Failure two', FieldType.Formula, 'test("y", "[")');

function typeOptions(id: string, type: FieldType, values: Record<string, unknown>) {
  const options = new Y.Map();
  const value = new Y.Map();

  Object.entries(values).forEach(([key, content]) => value.set(key, content));
  options.set(String(type), value);
  fields.get(id).set(K.type_option, options);
}

typeOptions('linked', FieldType.Relation, { database_id: 'unavailable' });
typeOptions('rollup', FieldType.Rollup, {
  relation_field_id: 'linked',
  target_field_id: 'external',
  calculation_type: CalculationType.Sum,
  show_as: RollupDisplayMode.Calculated,
});
const rowDocs: Record<string, YDoc> = {};

for (const [id, price, quantity] of [
  ['alpha', 10, 2],
  ['beta', 5, 3],
  ['gamma', 20, 2],
] as const) {
  const doc = new Y.Doc() as YDoc;
  const row = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;

  doc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, id);
  row.set(K.cells, cells);
  for (const [fieldId, data] of [
    ['price', price],
    ['quantity', quantity],
  ] as const) {
    const cell = new Y.Map() as YDatabaseCell;

    cell.set(K.field_type, FieldType.Number);
    cell.set(K.data, String(data));
    cells.set(fieldId, cell);
  }

  rowDocs[id] = doc;
}

const linkedCell = new Y.Map() as YDatabaseCell;
const linkedRows = Y.Array.from(['missing-row']);

linkedCell.set(K.field_type, FieldType.Relation);
linkedCell.set(K.data, linkedRows);
(rowDocs.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow).get(K.cells).set('linked', linkedCell);
const hugeDate = new Y.Map() as YDatabaseCell;

hugeDate.set(K.field_type, FieldType.DateTime);
hugeDate.set(K.data, '9007199254740993');
(rowDocs.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow).get(K.cells).set('huge_date', hugeDate);

const view = new Y.Map() as YDatabaseView;
const views = new Y.Map() as YDatabaseViews;
const sorts = new Y.Array() as YDatabaseSorts;
const sort = new Y.Map() as YDatabaseSort;
const filters = new Y.Array() as YDatabaseFilters;
const filter = new Y.Map() as YDatabaseFilter;

sort.set(K.id, 'sort');
sort.set(K.field_id, 'total');
sort.set(K.condition, SortCondition.Ascending);
sorts.push([sort]);
filter.set(K.id, 'filter');
filter.set(K.field_id, 'total');
filter.set(K.filter_type, FilterType.Data);
filter.set(K.condition, NumberFilterCondition.GreaterThan);
filter.set(K.content, '24');
filter.set(K.type, FieldType.Formula);
filters.push([filter]);
view.set(K.id, 'view');
view.set(K.row_orders, Y.Array.from(Object.keys(rowDocs).map((id) => ({ id, height: 44 }))));
view.set(K.sorts, sorts);
view.set(K.filters, filters);
views.set('view', view);
database.set(K.id, 'database');
database.set(K.views, views);

const context: DatabaseContextState = {
  databaseDoc,
  databasePageId: 'view',
  activeViewId: 'view',
  readOnly: true,
  workspaceId: 'workspace',
  // Only alpha has mounted cells. Other rows are the host's offscreen seeds.
  rowMap: { alpha: rowDocs.alpha },
  seedsReady: true,
  peekRowDocFromSeed: (id) => rowDocs[id] ?? null,
  loadRowFromSeed: async (id) => rowDocs[id],
  getViewIdFromDatabaseId: async (id) => (id === 'database' ? 'view' : 'unavailable-view'),
  loadView: async (id) => {
    if (id === 'view') return databaseDoc;
    evidence.relationLoads += 1;
    return new Promise<YDoc>((_resolve, reject) => {
      failRelatedLoad = () => reject(new Error('Related database unavailable'));
    });
  },
  createRow: async (key) => rowDocs[key.split('_rows_').pop()!],
};

function setPrice(price: string) {
  const row = rowDocs.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow;

  row.get(K.cells).get('price').set(K.data, price);
}

function setExpression(expression: string) {
  fields.get('total').get(K.type_option).get(String(FieldType.Formula)).set('expression', expression);
}

function ExternalCell() {
  const cell = useCellSelector({ rowId: 'alpha', fieldId: 'external' }) as FormulaCellValue | undefined;

  return <FormulaCell cell={cell} rowId='alpha' fieldId='external' wrap readOnly />;
}

function Consumers({ external }: { external: boolean }) {
  const subtotal = useCellSelector({ rowId: 'alpha', fieldId: 'subtotal' }) as FormulaCellValue | undefined;
  const total = useCellSelector({ rowId: 'alpha', fieldId: 'total' }) as FormulaCellValue | undefined;
  const rows = useRowOrdersSelector();

  useEffect(() => {
    evidence.observed.push({
      subtotal: subtotal?.rawNumeric,
      total: total?.rawNumeric,
      state: (total as (FormulaCellValue & { evaluationState?: string }) | undefined)?.evaluationState,
    });
    if (total?.error)
      evidence.cellErrors.push({
        source: total.errorSource,
        errors: (total as FormulaCellValue & { nativeErrors?: unknown[] }).nativeErrors,
      });
  }, [subtotal, total]);

  return (
    <>
      <table>
        <tbody>
          <tr>
            <th>Subtotal</th>
            <td>
              <FormulaCell cell={subtotal} rowId='alpha' fieldId='subtotal' wrap readOnly />
            </td>
          </tr>
          <tr>
            <th>Total</th>
            <td>
              <FormulaCell cell={total} rowId='alpha' fieldId='total' wrap readOnly />
            </td>
          </tr>
          {external && (
            <tr>
              <th>External</th>
              <td>
                <ExternalCell />
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <output data-testid='row-order'>{rows ? rows.map(({ id }) => id).join(',') : 'pending'}</output>
    </>
  );
}

function Fixture() {
  const [opened, setOpened] = useState(true);
  const [external, setExternal] = useState(false);

  return (
    <main className='p-8'>
      <h1>Rust formula database</h1>
      <button onClick={() => setPrice('15')}>Set Price to 15</button>
      <button onClick={() => fields.get('price').set(K.name, 'Unit price')}>Rename Price</button>
      <button
        onClick={() => {
          evidence.delayNext = true;
          setPrice('7');
        }}
      >
        Hold Price 7 result
      </button>
      <button
        onClick={() => {
          setPrice('11');
          releaseHeldResult?.();
        }}
      >
        Set Price to 11
      </button>
      <button onClick={() => setExpression('prop("subtotal") + 10')}>Change Total formula</button>
      <button onClick={() => setExpression('prop("deleted") + 1')}>Missing input</button>
      <button onClick={() => setExpression('prop("total") + 1')}>Cycle</button>
      <button onClick={() => setExpression('toNumber("not a number")')}>Row error</button>
      <button onClick={() => setExpression('0 / 0')}>Numeric NaN</button>
      <button onClick={() => setExpression('equal(prop("failure_one"), prop("failure_two"))')}>
        Multiple dependency errors
      </button>
      <button onClick={() => setExpression('prop("huge_date")')}>Show huge date</button>
      <button onClick={() => hugeDate.set(K.data, '')}>Clear huge date</button>
      <button onClick={() => view.get(K.row_orders).delete(2, 1)}>Remove Gamma</button>
      <button onClick={() => view.get(K.row_orders).push([{ id: 'gamma', height: 44 }])}>Restore Gamma</button>
      <button onClick={() => setExpression('prop("price")')}>Show Price</button>
      <button onClick={() => setPrice('')}>Clear Price</button>
      <button onClick={() => setExternal(true)}>Show external formula</button>
      <button onClick={() => failRelatedLoad?.()}>Fail related database</button>
      <button
        onClick={() => {
          databaseDoc.transact(() => {
            fields.get('linked').get(K.type_option).get(String(FieldType.Relation)).set('database_id', 'database');
            fields.get('external').get(K.type_option).get(String(FieldType.Formula)).set('expression', 'prop("rollup")');
          });
          rowDocs.alpha.transact(() => {
            linkedRows.delete(0, linkedRows.length);
            linkedRows.push(['alpha']);
          });
        }}
      >
        Host cycle
      </button>
      <button onClick={() => setOpened((value) => !value)}>{opened ? 'Close database' : 'Open database'}</button>
      {opened && (
        <DatabaseContext.Provider value={context}>
          <Consumers external={external} />
        </DatabaseContext.Provider>
      )}
    </main>
  );
}

Object.assign(window, { formulaEvidence: evidence, formulaFixture: { databaseDoc, rowDocs } });
createRoot(document.getElementById('root')!).render(<Fixture />);
