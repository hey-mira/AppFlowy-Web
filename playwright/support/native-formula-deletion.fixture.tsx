import { Suspense, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import { FormulaCell } from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { CalculationType, FieldType } from '@/application/database-yjs/database.type';
import { parseFormulaTypeOption } from '@/application/database-yjs/fields/formula/parse';
import { useDatabaseHistory } from '@/application/database-yjs/history';
import { getRowKey } from '@/application/database-yjs/row_meta';
import { useCellSelector } from '@/application/database-yjs/selector';
import {
  YDatabase,
  YDatabaseField,
  YDatabaseFields,
  YDatabaseRow,
  YDatabaseViews,
  YDatabaseView,
  YDoc,
  YjsDatabaseKey as K,
  YjsEditorKey as E,
} from '@/application/types';
import { DeletePropertyConfirm } from '@/components/database/components/property/DeletePropertyConfirm';
import '@/i18n/config';
import '@/styles/global.css';

const evidence = {
  attemptedWorkers: 0,
  workers: 0,
  terminated: 0,
  held: false,
  holdNext: null as string | null,
  requests: [] as Array<{ worker: number; method: string; args: unknown[] }>,
  replies: [] as Array<{ worker: number; method: string; value: unknown }>,
  observed: [] as Array<{ source: string; preview: string; diagnostics: string }>,
  pageErrors: [] as string[],
};

function snapshot(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return String(item);
      if (item instanceof Map) return Array.from(item);
      return typeof item === 'number' && !Number.isFinite(item) ? String(item) : item;
    })
  );
}

// Delayed replies still come from the real SDK Worker and Rust/WASM. Holding
// the transport exposes stale async UI state without mocking language rules.
const BrowserWorker = window.Worker;
const query = new URLSearchParams(location.search);
let releaseHeldReply: (() => void) | undefined;

if (query.has('hold')) evidence.holdNext = 'engine.remove';

window.Worker = class extends BrowserWorker {
  private readonly workerId = ++evidence.workers;
  private readonly requests = new Map<number, string>();

  constructor(url: string | URL, options?: WorkerOptions) {
    evidence.attemptedWorkers += 1;

    super(url, options);
    super.addEventListener('message', (event: MessageEvent<{ id: number; value?: unknown; error?: unknown }>) => {
      const method = this.requests.get(event.data.id);

      if (!method) return;
      this.requests.delete(event.data.id);
      evidence.replies.push({ worker: this.workerId, method, value: snapshot(event.data.value ?? event.data.error) });
      if (method !== evidence.holdNext) return;
      evidence.holdNext = null;
      evidence.held = true;
      event.stopImmediatePropagation();
      releaseHeldReply = () => {
        evidence.held = false;
        this.dispatchEvent(new MessageEvent('message', { data: event.data }));
        releaseHeldReply = undefined;
      };
    });
  }

  postMessage(request: { id: number; method: string; args: unknown[] }) {
    this.requests.set(request.id, request.method);
    evidence.requests.push({ worker: this.workerId, method: request.method, args: snapshot(request.args) as unknown[] });
    super.postMessage(request);
    // Inspection is identified by its private remove RPC, independent of which
    // asynchronous SDK initialization creates a Worker first.
    if (query.has('fail') && request.method === 'engine.remove') {
      queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { message: 'Native dependency Worker failed' })));
    }
  }

  terminate() {
    evidence.terminated += 1;
    super.terminate();
  }
};

window.addEventListener('error', (event) => evidence.pageErrors.push(event.message));

const serialized = query.has('restore') ? sessionStorage.getItem('native-formula-deletion-documents') : null;
const savedDocuments = serialized ? (JSON.parse(serialized) as { database: number[]; row: number[] }) : null;
const databaseDoc = new Y.Doc() as YDoc;
const rowDoc = new Y.Doc() as YDoc;

if (savedDocuments) {
  Y.applyUpdate(databaseDoc, Uint8Array.from(savedDocuments.database));
  Y.applyUpdate(rowDoc, Uint8Array.from(savedDocuments.row));
}

const database = savedDocuments
  ? (databaseDoc.getMap(E.data_section).get(E.database) as YDatabase)
  : (new Y.Map() as YDatabase);
const fields = savedDocuments ? database.get(K.fields) : (new Y.Map() as YDatabaseFields);
const row = savedDocuments
  ? (rowDoc.getMap(E.data_section).get(E.database_row) as YDatabaseRow)
  : (new Y.Map() as YDatabaseRow);
const views = savedDocuments ? database.get(K.views) : (new Y.Map() as YDatabaseViews);
const view = savedDocuments ? views.get('view') : (new Y.Map() as YDatabaseView);
const cells = savedDocuments ? row.get(K.cells) : new Y.Map();

if (!savedDocuments) {
  databaseDoc.getMap(E.data_section).set(E.database, database);
  database.set(K.id, 'database');
  database.set(K.fields, fields);
  rowDoc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, 'alpha');
  for (const [id, value] of [
    ['price', '10'],
    ['other', '100'],
  ]) {
    const cell = new Y.Map();

    cell.set(K.field_type, FieldType.Number);
    cell.set(K.data, value);
    cells.set(id, cell);
  }

  row.set(K.cells, cells);
}

function field(id: string, name: string, type: FieldType, option?: Record<string, unknown>, targetFields = fields) {
  const value = new Y.Map() as YDatabaseField;

  value.set(K.id, id);
  value.set(K.name, name);
  value.set(K.type, type);
  if (option) {
    const options = new Y.Map();
    const settings = new Y.Map();

    for (const [key, item] of Object.entries(option)) settings.set(key, item);
    options.set(String(type), settings);
    value.set(K.type_option, options);
  }

  targetFields.set(id, value);
  return value;
}

const formula = (id: string, name: string, expression: string) => field(id, name, FieldType.Formula, { expression });

if (!savedDocuments) {
  field('title', 'Name', FieldType.RichText).set(K.is_primary, true);
  field('price', 'Price', FieldType.Number);
  field('other', 'Other', FieldType.Number);
  formula('subtotal', 'Base', 'prop("price") * 2');
  formula('total', 'Total', 'prop("subtotal") + 1');
  formula('invalid-type', 'Invalid type', 'upper(prop("price"))');
  formula('missing', 'Missing input', 'prop("gone") + prop("price")');
  formula('cycle-a', 'Cycle A', 'prop("cycle-b") + prop("price")');
  formula('cycle-b', 'Cycle B', 'prop("cycle-a")');
  formula('unrelated', 'Literal', '"prop(\\"price\\")" /* prop("price") */');
  if (query.has('history')) formula('constant', 'Unrelated', '42');
  field('links', 'Links', FieldType.Relation, query.has('rollup') ? { database_id: 'related' } : undefined);
  field('rollup', 'Rolled up', FieldType.Rollup, {
    relation_field_id: 'links',
    target_field_id: 'amount',
    calculation_type: CalculationType.Sum,
  });
  formula('rolled-total', 'Rolled formula', query.has('rollup') ? 'prop("rollup") * 2' : 'prop("rollup")');
  formula('rolled-summary', 'Rolled summary', 'format(prop("rolled-total"))');
  view.set(K.id, 'view');
  view.set(K.row_orders, Y.Array.from([{ id: 'alpha', height: 44 }]));
  view.set(K.field_orders, Y.Array.from(Array.from(fields.keys(), (id) => ({ id }))));
  views.set('view', view);
  database.set(K.views, views);
}

const relatedDoc = new Y.Doc({ guid: 'related' }) as YDoc;
const relatedDatabase = new Y.Map() as YDatabase;
const relatedFields = new Y.Map() as YDatabaseFields;
const relatedViews = new Y.Map() as YDatabaseViews;
const relatedView = new Y.Map() as YDatabaseView;
const relatedRowDoc = new Y.Doc() as YDoc;
const relatedRow = new Y.Map() as YDatabaseRow;

relatedDoc.getMap(E.data_section).set(E.database, relatedDatabase);
relatedDatabase.set(K.id, relatedDoc.guid);
relatedDatabase.set(K.fields, relatedFields);
field('amount', 'Amount', FieldType.Number, undefined, relatedFields);
relatedView.set(K.id, relatedDoc.guid);
relatedView.set(K.row_orders, Y.Array.from([{ id: 'child', height: 44 }]));
relatedViews.set(relatedDoc.guid, relatedView);
relatedDatabase.set(K.views, relatedViews);
relatedRowDoc.getMap(E.data_section).set(E.database_row, relatedRow);
relatedRow.set(K.id, 'child');
const relatedCells = new Y.Map();
const amountCell = new Y.Map();

amountCell.set(K.field_type, FieldType.Number);
amountCell.set(K.data, '6');
relatedCells.set('amount', amountCell);
relatedRow.set(K.cells, relatedCells);
if (query.has('rollup')) {
  const relationCell = new Y.Map();

  relationCell.set(K.field_type, FieldType.Relation);
  relationCell.set(K.data, Y.Array.from(['child']));
  cells.set('links', relationCell);
}

function Committed({ fieldId = 'total', testId = 'committed-total' }: { fieldId?: string; testId?: string }) {
  const cell = useCellSelector({ rowId: 'alpha', fieldId }) as FormulaCell | undefined;

  return (
    <output
      data-testid={testId}
      data-state={cell?.evaluationState ?? 'pending'}
      data-error={cell?.error ?? ''}
      data-missing-ref={cell?.missingPropertyRef ?? ''}
      data-number={cell?.rawNumeric === undefined ? '' : String(cell.rawNumeric)}
    >
      {cell?.data ?? ''}
    </output>
  );
}

function HistoryControls() {
  const history = useDatabaseHistory('alpha');

  return (
    <>
      <button onClick={history.undo} disabled={!history.canUndo} data-testid='history-undo'>
        Undo deletion
      </button>
      <button onClick={history.redo} disabled={!history.canRedo} data-testid='history-redo'>
        Redo deletion
      </button>
    </>
  );
}

function source(id: string) {
  const current = fields.get(id);

  return current ? parseFormulaTypeOption(current).formula : '';
}

function documentState() {
  return {
    ids: Array.from(fields.keys()),
    orders: view
      .get(K.field_orders)
      .toArray()
      .map(({ id }) => id),
    subtotal: source('subtotal'),
    total: source('total'),
    rollupFormula: source('rolled-total'),
    priceCell: row.get(K.cells).get('price')?.get(K.data),
    otherName: fields.get('other')?.get(K.name),
  };
}

function Fixture() {
  const [open, setOpen] = useState(true);
  const [target, setTarget] = useState(new URLSearchParams(location.search).get('target') ?? 'price');
  const [revision, setRevision] = useState(0);
  const context = useMemo<DatabaseContextState>(
    () => ({
      databaseDoc,
      databasePageId: 'view',
      activeViewId: 'view',
      readOnly: false,
      workspaceId: 'workspace',
      rowMap: { alpha: rowDoc },
      ...(query.has('rollup')
        ? {
            getViewIdFromDatabaseId: async (id: string) => (id === relatedDoc.guid ? relatedDoc.guid : null),
            loadView: async () => relatedDoc,
            createRow: async (key: string) => {
              if (key !== getRowKey(relatedDoc.guid, 'child')) throw new Error(`Unknown fixture row ${key}`);
              return relatedRowDoc;
            },
          }
        : {}),
    }),
    []
  );

  useEffect(() => {
    const update = () => setRevision((value) => value + 1);

    fields.observeDeep(update);
    return () => fields.unobserveDeep(update);
  }, []);
  useEffect(() => {
    Object.assign((window as unknown as { deletionFixture: object }).deletionFixture, {
      selectTarget: (id: string) => {
        setTarget(id);
        setOpen(true);
      },
    });
  }, []);
  void revision;
  return (
    <Suspense fallback='Loading deletion warning'>
      <DatabaseContext.Provider value={context}>
        <main className='p-4'>
          <button onClick={() => setOpen(true)}>Open confirmation</button>
          <button
            onClick={() => {
              setTarget('links');
              setOpen(true);
            }}
          >
            Delete relation
          </button>
          <button
            onClick={() => {
              evidence.holdNext = 'engine.remove';
            }}
          >
            Hold next removal
          </button>
          <button onClick={() => releaseHeldReply?.()}>Release reply</button>
          <output data-testid='field-present'>{String(fields.has(target))}</output>
          <Committed />
          {query.has('history') && (
            <>
              <HistoryControls />
              <Committed fieldId='subtotal' testId='committed-base' />
              <Committed fieldId='constant' testId='committed-unrelated' />
              <output data-testid='field-orders'>{documentState().orders.join(',')}</output>
              <output data-testid='saved-subtotal'>{source('subtotal')}</output>
              <output data-testid='saved-total'>{source('total')}</output>
              <output data-testid='row-price'>{String(row.get(K.cells).get('price')?.get(K.data) ?? '')}</output>
              <button
                onClick={() =>
                  sessionStorage.setItem(
                    'native-formula-deletion-documents',
                    JSON.stringify({
                      database: Array.from(Y.encodeStateAsUpdate(databaseDoc)),
                      row: Array.from(Y.encodeStateAsUpdate(rowDoc)),
                    })
                  )
                }
              >
                Serialize documents
              </button>
            </>
          )}
          {query.has('rollup') && (
            <>
              <Committed fieldId='rollup' testId='committed-rollup-input' />
              <Committed fieldId='rolled-total' testId='committed-rollup' />
              <Committed fieldId='rolled-summary' testId='committed-rollup-summary' />
            </>
          )}
          <DeletePropertyConfirm open={open} fieldId={target} onClose={() => setOpen(false)} />
        </main>
      </DatabaseContext.Provider>
    </Suspense>
  );
}

Object.assign(window, {
  deletionEvidence: evidence,
  deletionFixture: {
    fields,
    databaseDoc,
    rowDoc,
    documentState,
    setHold: (method: string) => {
      evidence.holdNext = method;
    },
    release: () => releaseHeldReply?.(),
  },
});
createRoot(document.getElementById('root')!).render(<Fixture />);
