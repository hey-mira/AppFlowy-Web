import { Suspense, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import { FormulaCell } from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { FieldType } from '@/application/database-yjs/database.type';
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
    const attempt = ++evidence.attemptedWorkers;

    if (query.has('fail') && attempt > 1) throw new Error('Native dependency Worker could not start');
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
  }

  terminate() {
    evidence.terminated += 1;
    super.terminate();
  }
};

window.addEventListener('error', (event) => evidence.pageErrors.push(event.message));

const databaseDoc = new Y.Doc() as YDoc;
const database = new Y.Map() as YDatabase;
const fields = new Y.Map() as YDatabaseFields;
const rowDoc = new Y.Doc() as YDoc;
const row = new Y.Map() as YDatabaseRow;
const view = new Y.Map() as YDatabaseView;
const views = new Y.Map() as YDatabaseViews;

databaseDoc.getMap(E.data_section).set(E.database, database);
database.set(K.id, 'database');
database.set(K.fields, fields);
rowDoc.getMap(E.data_section).set(E.database_row, row);
row.set(K.id, 'alpha');
const cells = new Y.Map();

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

function field(id: string, name: string, type: FieldType, option?: Record<string, unknown>) {
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

  fields.set(id, value);
  return value;
}

const formula = (id: string, name: string, expression: string) => field(id, name, FieldType.Formula, { expression });

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
field('links', 'Links', FieldType.Relation);
field('rollup', 'Rolled up', FieldType.Rollup, { relation_field_id: 'links', target_field_id: 'amount' });
formula('rolled-total', 'Rolled formula', 'prop("rollup")');
formula('rolled-summary', 'Rolled summary', 'format(prop("rolled-total"))');
view.set(K.id, 'view');
view.set(K.row_orders, Y.Array.from([{ id: 'alpha', height: 44 }]));
view.set(K.field_orders, Y.Array.from(Array.from(fields.keys(), (id) => ({ id }))));
views.set('view', view);
database.set(K.views, views);

function Committed() {
  const cell = useCellSelector({ rowId: 'alpha', fieldId: 'total' }) as FormulaCell | undefined;

  return <output data-testid='committed-total'>{cell?.data ?? ''}</output>;
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
    setHold: (method: string) => {
      evidence.holdNext = method;
    },
    release: () => releaseHeldReply?.(),
  },
});
createRoot(document.getElementById('root')!).render(<Fixture />);
