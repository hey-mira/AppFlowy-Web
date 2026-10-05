import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import { FormulaCell as FormulaCellValue } from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { CalculationType, FieldType, FilterType, RollupDisplayMode, SortCondition } from '@/application/database-yjs/database.type';
import { filterBy } from '@/application/database-yjs/filter';
import { evaluateRollupCell } from '@/application/database-yjs/rollup/cache';
import { getRowKey } from '@/application/database-yjs/row_meta';
import {
  useAdvancedFilterSelector,
  useAdvancedFiltersSelector,
  useCellSelector,
  useFilterSelector,
  useFormulaResultType,
  useRowOrdersSelector,
} from '@/application/database-yjs/selector';
import { sortBy } from '@/application/database-yjs/sort';
import {
  YDatabase,
  YDatabaseCell,
  YDatabaseCells,
  YDatabaseField,
  YDatabaseFields,
  YDatabaseFilter,
  YDatabaseRow,
  YDatabaseSort,
  YDatabaseView,
  YDatabaseViews,
  YDoc,
  YjsDatabaseKey as K,
  YjsEditorKey as E,
} from '@/application/types';
import { FormulaCell } from '@/components/database/components/cell/formula/FormulaCell';
import '@/i18n/config';

const query = new URLSearchParams(window.location.search);
const mode = query.get('mode') ?? 'types';
const fieldId = query.get('field') ?? 'formula';
const numericEvidence = { workers: 0, errors: [] as string[], cells: {} as Record<string, unknown> };

if (mode === 'numbers') {
  (window as unknown as { nativeNumericEvidence: typeof numericEvidence }).nativeNumericEvidence = numericEvidence;
  const RealWorker = window.Worker;

  window.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      numericEvidence.workers += 1;
    }
  };
  window.addEventListener('error', (event) => numericEvidence.errors.push(event.message));
}

const doc = new Y.Doc({ guid: 'native-conditions-database' }) as YDoc;
const database = new Y.Map() as YDatabase;
const fields = new Y.Map() as YDatabaseFields;
const view = new Y.Map() as YDatabaseView;
const views = new Y.Map() as YDatabaseViews;
const rows: Record<string, YDoc> = {};

doc.getMap(E.data_section).set(E.database, database);
database.set(K.id, doc.guid);
database.set(K.fields, fields);
database.set(K.views, views);
view.set(K.id, 'view');
view.set(K.is_inline, true);
view.set(K.filters, new Y.Array());
view.set(K.sorts, new Y.Array());
views.set('view', view);

function field(id: string, type: FieldType, expression?: string) {
  const value = new Y.Map() as YDatabaseField;

  value.set(K.id, id);
  value.set(K.database_id, doc.guid);
  value.set(K.name, id);
  value.set(K.type, type);
  if (expression !== undefined) {
    const options = new Y.Map();
    const option = new Y.Map();

    option.set('expression', expression);
    options.set(String(type), option);
    value.set(K.type_option, options);
  }

  fields.set(id, value);
}

function row(id: string, inputs: Record<string, { type: FieldType; data: unknown; end?: string }>) {
  const rowDoc = new Y.Doc() as YDoc;
  const value = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;

  rowDoc.getMap(E.data_section).set(E.database_row, value);
  value.set(K.id, id);
  value.set(K.cells, cells);
  for (const [fieldId, input] of Object.entries(inputs)) {
    const cell = new Y.Map() as YDatabaseCell;

    cell.set(K.field_type, input.type);
    cell.set(K.data, input.data);
    if (input.type === FieldType.DateTime) {
      cell.set(K.include_time, false);
      if (input.end !== undefined) {
        cell.set(K.is_range, true);
        cell.set(K.end_timestamp, input.end);
      }
    }

    cells.set(fieldId, cell);
  }

  rows[id] = rowDoc;
}

field('due', FieldType.DateTime);
field('price', FieldType.Number);
field('done', FieldType.Checkbox);
field('formula', FieldType.Formula, 'prop("due")');
field('double', FieldType.Formula, 'prop("price") * 2');
field('label', FieldType.Formula, 'if(prop("done"), "done", "open")');
field('flag', FieldType.Formula, 'prop("price") > 5');
field('next', FieldType.Formula, 'dateAdd(prop("due"), 1, "days")');

if (mode === 'numbers') {
  field('bad', FieldType.Checkbox);
  field('numeric', FieldType.Formula, 'if(prop("bad"), length(match("x", "[")), prop("price"))');
  field('self', FieldType.Relation);
  field('rolled', FieldType.Rollup);
  for (const [id, type, settings] of [
    ['self', FieldType.Relation, { database_id: doc.guid }],
    ['rolled', FieldType.Rollup, { relation_field_id: 'self', target_field_id: 'numeric', calculation_type: CalculationType.Sum, show_as: RollupDisplayMode.Calculated }],
  ] as const) {
    const options = new Y.Map();
    const option = new Y.Map();

    Object.entries(settings).forEach(([key, value]) => option.set(key, value));
    options.set(String(type), option);
    fields.get(id).set(K.type_option, options);
  }

  for (const [id, value] of [
    ['empty', null], ['nan', 'NaN'], ['positive-infinity', 'Infinity'], ['positive', '8'], ['zero', '0'],
    ['error', '42'], ['negative-infinity', '-Infinity'], ['negative-zero', '-0'], ['negative', '-3.5'],
    ['fraction', '0.000001'], ['large', '9007199254740991'], ['nan-second', 'NaN'],
  ] as const) {
    row(id, {
      ...(value === null ? {} : { price: { type: FieldType.Number, data: value } }),
      bad: { type: FieldType.Checkbox, data: id === 'error' ? 'Yes' : 'No' },
      self: { type: FieldType.Relation, data: Y.Array.from([id]) },
    });
  }
} else if (mode === 'epoch') {
  row('epoch', { due: { type: FieldType.DateTime, data: '0' } });
  row('empty', {});
} else if (mode === 'range') {
  for (const [id, end] of Object.entries({
    before: '1710201600',
    on: '1710288000',
    after: '1710374400',
    'last-week': '1709596800',
    'next-week': '1710892800',
    single: '',
    empty: '',
  })) {
    row(
      id,
      id === 'empty'
        ? {}
        : {
            due: {
              type: FieldType.DateTime,
              data: id === 'single' ? '1710288000' : '1709251200',
              end: end || undefined,
            },
          }
    );
  }
} else {
  for (const [id, price, done, due] of [
    ['row-a', '3', 'Yes', '1709424000'],
    ['row-b', '10', 'No', '1709251200'],
    ['row-c', '7', 'No', '1709337600'],
  ] as const) {
    row(id, {
      price: { type: FieldType.Number, data: price },
      done: { type: FieldType.Checkbox, data: done },
      due: { type: FieldType.DateTime, data: due },
    });
  }
}

view.set(K.row_orders, Y.Array.from(Object.keys(rows).map((id) => ({ id, height: 44 }))));
if (query.has('sort')) {
  const sort = new Y.Map() as YDatabaseSort;

  sort.set(K.id, 'formula-sort');
  sort.set(K.field_id, fieldId);
  sort.set(K.condition, query.get('sort') === 'desc' ? SortCondition.Descending : SortCondition.Ascending);
  view.get(K.sorts).push([sort]);
} else {
  const filter = new Y.Map() as YDatabaseFilter;

  filter.set(K.id, 'formula-filter');
  filter.set(K.field_id, fieldId);
  filter.set(K.filter_type, FilterType.Data);
  filter.set(K.type, fieldId === 'rolled' ? FieldType.Rollup : FieldType.Formula);
  filter.set(K.condition, Number(query.get('condition')));
  filter.set(K.content, query.get('content') ?? '');
  if (fieldId === 'rolled') {
    filter.set(K.rollup_target_type, FieldType.Number);
    filter.set(K.rollup_meta, {
      target_field_type: FieldType.Number, rollup_show_as: RollupDisplayMode.Calculated,
      rollup_calculation_type: CalculationType.Sum, relation_field_id: 'self', target_field_id: 'numeric',
    });
  }

  if (query.get('selection') === 'advanced') {
    const root = new Y.Map() as YDatabaseFilter;

    root.set(K.id, 'root');
    root.set(K.filter_type, FilterType.And);
    root.set(K.children, Y.Array.from([filter]));
    view.get(K.filters).push([root]);
  } else view.get(K.filters).push([filter]);
}

const context: DatabaseContextState = {
  databaseDoc: doc,
  databasePageId: 'view',
  activeViewId: 'view',
  readOnly: false,
  workspaceId: 'workspace',
  rowMap: rows,
  seedsReady: true,
  blobPrefetchComplete: true,
  ...(mode === 'numbers' ? {
    getViewIdFromDatabaseId: async (id: string) => id,
    loadView: async (id: string) => {
      if (id !== doc.guid) throw new Error(`Missing fixture database ${id}`);
      return doc;
    },
    createRow: async (key: string) => {
      const entry = Object.entries(rows).find(([id]) => getRowKey(doc.guid, id) === key);

      if (!entry) throw new Error(`Missing fixture row ${key}`);
      return entry[1];
    },
  } : {}),
};

function Conditions() {
  const orders = useRowOrdersSelector();
  const resultType = useFormulaResultType(fieldId);

  return (
    <>
      <h1>Native formula conditions</h1>
      <output data-testid='condition-orders' data-result-type={String(resultType)}>
        {orders?.map(({ id }) => id).join(',')}
      </output>
      {query.has('selection') && <Selections />}
      {mode === 'numbers' && <NumericRows />}
    </>
  );
}

function NumericRows() {
  const type = useFormulaResultType('numeric');

  return <><output data-testid='numeric-native-type'>{String(type)}</output>{Object.keys(rows).map((id) => <NumericRow key={id} id={id} />)}</>;
}

function NumericRow({ id }: { id: string }) {
  const cell = useCellSelector({ rowId: id, fieldId: 'numeric' }) as FormulaCellValue | undefined;

  useEffect(() => {
    numericEvidence.cells[id] = {
      resultType: cell?.resultType, evaluationState: cell?.evaluationState, rawNumeric: cell?.rawNumeric,
      nativeValue: cell?.nativeValue, error: cell?.error,
    };
  }, [cell, id]);
  return <div><span>{id}: </span><FormulaCell cell={cell} rowId={id} fieldId='numeric' readOnly wrap /></div>;
}

function Selections() {
  const simple = useFilterSelector('formula-filter');
  const advanced = useAdvancedFilterSelector('formula-filter');
  const all = useAdvancedFiltersSelector();

  return (
    <>
      <output data-testid='simple-selection'>{JSON.stringify(simple)}</output>
      <output data-testid='advanced-selection'>{JSON.stringify(advanced)}</output>
      <output data-testid='all-selections'>{JSON.stringify(all)}</output>
    </>
  );
}

async function mount() {
  if (mode === 'numbers' && fieldId === 'rolled') {
    // Public host conditions consume the actual production Rollup results.
    const values = new Map(await Promise.all(Object.entries(rows).map(async ([id, rowDoc]) => [id,
      await evaluateRollupCell({ baseDoc: doc, database, rollupField: fields.get('rolled'), fieldId: 'rolled',
        row: rowDoc.getMap(E.data_section).get(E.database_row) as YDatabaseRow, rowId: id,
        getViewIdFromDatabaseId: context.getViewIdFromDatabaseId, loadView: context.loadView, createRow: context.createRow,
      }),
    ] as const)));
    const options = { getRollupCellValue: (id: string) => values.get(id)! };
    const filtered = filterBy(view.get(K.row_orders).toArray(), view.get(K.filters), fields, rows, options);
    const ordered = sortBy(filtered, view.get(K.sorts), fields, rows, options);

    createRoot(document.getElementById('root')!).render(<DatabaseContext.Provider value={context}>
      <h1>Native numeric Rollup conditions</h1><output data-testid='condition-orders'>{ordered.map(({ id }) => id).join(',')}</output><NumericRows />
    </DatabaseContext.Provider>);
    return;
  }

  createRoot(document.getElementById('root')!).render(
    <DatabaseContext.Provider value={context}>
      <Conditions />
    </DatabaseContext.Provider>
  );
}

void mount();
