import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import type { FormulaCell as FormulaCellValue, RollupCell as RollupCellValue } from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { CalculationType, FieldType, RollupDisplayMode } from '@/application/database-yjs/database.type';
import { TimelineRowValuesProvider } from '@/application/database-yjs/hooks/TimelineRowValuesProvider';
import { getRowKey } from '@/application/database-yjs/row_meta';
import { useCellSelector, useFormulaResultType } from '@/application/database-yjs/selector';
import {
  YDatabase, YDatabaseCalculation, YDatabaseCalculations, YDatabaseCell, YDatabaseCells, YDatabaseField,
  YDatabaseFields, YDatabaseRow, YDatabaseView, YDatabaseViews, YDoc, YjsDatabaseKey as K, YjsEditorKey as E,
} from '@/application/types';
import { FormulaCell } from '@/components/database/components/cell/formula/FormulaCell';
import { RollupCell } from '@/components/database/components/cell/rollup/RollupCell';
import { GridCalculateRowCell } from '@/components/database/components/grid/grid-cell/GridCalculateRowCell';
import { TimelineCalculation } from '@/components/database/timeline/TimelineCalculation';
import '@/i18n/config';

const query = new URLSearchParams(window.location.search);
const inputs = JSON.parse(query.get('values') ?? '[]') as (string | null)[];
const evidence = {
  scenario: query.get('scenario'), inputs, workers: 0, evaluations: 0, errors: [] as string[],
  cells: {} as Record<string, unknown>, rollup: undefined as unknown,
};

(window as unknown as { nativeAggregateEvidence: typeof evidence }).nativeAggregateEvidence = evidence;
const RealWorker = window.Worker;

// Count actual SDK work without altering messages or results.
window.Worker = class extends RealWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    evidence.workers += 1;
  }

  postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []) {
    if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'engine.evaluate')
      evidence.evaluations += 1;
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }
};
window.addEventListener('error', (event) => evidence.errors.push(event.message));

const doc = new Y.Doc({ guid: 'native-aggregates-database' }) as YDoc;
const database = new Y.Map() as YDatabase;
const fields = new Y.Map() as YDatabaseFields;
const views = new Y.Map() as YDatabaseViews;
const view = new Y.Map() as YDatabaseView;
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

function addField(id: string, type: FieldType, settings?: Record<string, unknown>) {
  const field = new Y.Map() as YDatabaseField;

  field.set(K.id, id);
  field.set(K.database_id, doc.guid);
  field.set(K.name, id);
  field.set(K.type, type);
  if (settings) {
    const options = new Y.Map();
    const option = new Y.Map();

    Object.entries(settings).forEach(([key, value]) => option.set(key, value));
    options.set(String(type), option);
    field.set(K.type_option, options);
  }

  fields.set(id, field);
}

addField('input', FieldType.Number);
addField('formula', FieldType.Formula, { expression: 'prop("input")' });
addField('members', FieldType.Relation, { database_id: doc.guid });
addField('median', FieldType.Rollup, {
  relation_field_id: 'members', target_field_id: 'formula',
  calculation_type: CalculationType.Median, show_as: RollupDisplayMode.Calculated,
});

inputs.forEach((value, index) => {
  const id = `row-${index}`;
  const rowDoc = new Y.Doc({ guid: getRowKey(doc.guid, id) }) as YDoc;
  const row = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;

  rowDoc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, id);
  row.set(K.database_id, doc.guid);
  row.set(K.cells, cells);
  if (value !== null) {
    const cell = new Y.Map() as YDatabaseCell;

    cell.set(K.field_type, FieldType.Number);
    cell.set(K.data, value);
    cells.set('input', cell);
  }

  rows[id] = rowDoc;
});
const orders = Object.keys(rows).map((id) => ({ id, height: 44 }));
const relation = new Y.Map() as YDatabaseCell;

relation.set(K.field_type, FieldType.Relation);
relation.set(K.data, Y.Array.from(orders.map(({ id }) => id)));
(rows['row-0'].getMap(E.data_section).get(E.database_row) as YDatabaseRow).get(K.cells).set('members', relation);
view.set(K.row_orders, Y.Array.from(orders));
const calculation = new Y.Map() as YDatabaseCalculation;
const calculations = new Y.Array() as YDatabaseCalculations;

calculation.set(K.id, 'median');
calculation.set(K.field_id, 'formula');
calculation.set(K.type, CalculationType.Median);
calculation.set(K.calculation_value, 'pending');
calculations.push([calculation]);
view.set(K.calculations, calculations);

const context: DatabaseContextState = {
  databaseDoc: doc, databasePageId: 'view', activeViewId: 'view', readOnly: false,
  workspaceId: 'workspace', rowMap: rows, seedsReady: true, blobPrefetchComplete: true,
  peekRowDocFromSeed: (id) => rows[id], loadRowFromSeed: async (id) => rows[id], ensureRow: async (id) => rows[id],
  getViewIdFromDatabaseId: async (id) => id,
  loadView: async (id) => {
    if (id !== doc.guid) throw new Error(`Unknown aggregate database ${id}`);
    return doc;
  },
  createRow: async (key) => {
    const rowDoc = Object.values(rows).find((candidate) => candidate.guid === key);

    if (!rowDoc) throw new Error(`Unknown aggregate row ${key}`);
    return rowDoc;
  },
};

function SourceCell({ id }: { id: string }) {
  const cell = useCellSelector({ rowId: id, fieldId: 'formula' }) as FormulaCellValue | undefined;

  useEffect(() => {
    evidence.cells[id] = {
      resultType: cell?.resultType, evaluationState: cell?.evaluationState,
      rawNumeric: cell?.rawNumeric, nativeValue: cell?.nativeValue, error: cell?.error,
    };
  }, [cell, id]);
  return <div>{id}: <FormulaCell cell={cell} rowId={id} fieldId='formula' readOnly wrap /></div>;
}

function MedianRollup() {
  const cell = useCellSelector({ rowId: 'row-0', fieldId: 'median' }) as RollupCellValue | undefined;

  useEffect(() => {
    evidence.rollup = { value: cell?.data, rawNumeric: cell?.rawNumeric, targetFieldType: cell?.targetFieldType, error: cell?.error };
  }, [cell]);
  return <section>
    <h2>Numeric Rollup</h2>
    <RollupCell cell={cell} rowId='row-0' fieldId='median' readOnly wrap />
    <output data-testid='aggregate-rollup-raw' data-loaded={String(cell?.targetFieldType !== undefined)}>
      {cell?.rawNumeric === undefined ? 'null' : Object.is(cell.rawNumeric, -0) ? '-0' : String(cell.rawNumeric)}
    </output>
  </section>;
}

function Aggregates() {
  const type = useFormulaResultType('formula');

  return <main style={{ padding: 24, maxWidth: 720 }}>
    <h1>Native median: {query.get('scenario')}</h1>
    <p>Input order: {inputs.map((value) => value ?? 'null').join(', ')}</p>
    <output data-testid='aggregate-native-type'>{String(type)}</output>
    {orders.map(({ id }) => <SourceCell id={id} key={id} />)}
    <section data-testid='aggregate-grid-footer'>
      <h2>Grid footer</h2><GridCalculateRowCell fieldId='formula' rowOrders={orders} />
    </section>
    <section data-testid='aggregate-timeline-footer'>
      <h2>Timeline footer</h2><TimelineRowValuesProvider rowOrders={orders}><TimelineCalculation fieldId='formula' /></TimelineRowValuesProvider>
    </section>
    <MedianRollup />
  </main>;
}

createRoot(document.getElementById('root')!).render(<DatabaseContext.Provider value={context}><Aggregates /></DatabaseContext.Provider>);
