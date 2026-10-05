import { StrictMode, Suspense, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import { FormulaCell } from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { FieldType } from '@/application/database-yjs/database.type';
import { parseFormulaTypeOption } from '@/application/database-yjs/fields/formula/parse';
import { markDatabaseHistoryDocumentImmutable } from '@/application/database-yjs/immutable';
import { useCellSelector } from '@/application/database-yjs/selector';
import {
  YDatabase,
  YDatabaseCell,
  YDatabaseCells,
  YDatabaseField,
  YDatabaseFields,
  YDatabaseRow,
  YDatabaseView,
  YDatabaseViews,
  YDoc,
  YjsDatabaseKey as K,
  YjsEditorKey as E,
} from '@/application/types';
import { FormulaEditorDialog } from '@/components/database/components/property/formula/FormulaEditorDialog';
import { FormulaEditorPanel } from '@/components/database/components/property/formula/FormulaEditorPanel';
import { FormulaEditorPopover } from '@/components/database/components/property/formula/FormulaEditorPopover';
import { FormulaPropertyMenuContent } from '@/components/database/components/property/formula/FormulaPropertyMenuContent';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import '@/i18n/config';
import '@/styles/global.css';

const evidence = {
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
let releaseHeldReply: (() => void) | undefined;

window.Worker = class extends BrowserWorker {
  private readonly workerId = ++evidence.workers;
  private readonly requests = new Map<number, string>();

  constructor(url: string | URL, options?: WorkerOptions) {
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

databaseDoc.getMap(E.data_section).set(E.database, database);
database.set(K.id, 'database');
database.set(K.fields, fields);

function field(id: string, name: string, type: FieldType, expression?: string) {
  const value = new Y.Map() as YDatabaseField;

  value.set(K.id, id);
  value.set(K.name, name);
  value.set(K.type, type);
  if (expression !== undefined) {
    const options = new Y.Map();
    const formula = new Y.Map();

    formula.set(K.expression, expression);
    options.set(String(FieldType.Formula), formula);
    value.set(K.type_option, options);
  }

  fields.set(id, value);
  return value;
}

field('title', 'Name', FieldType.RichText).set(K.is_primary, true);
field('price', 'Price', FieldType.Number);
field('other', 'Other', FieldType.Number);
field('quantity', 'Quantity', FieldType.Number);
field('subtotal', 'Subtotal', FieldType.Formula, 'prop("price") * prop("quantity")');
field('total', 'Total', FieldType.Formula, 'prop("subtotal") + 5');

const rowDocs: Record<string, YDoc> = {};

for (const [id, title, price, quantity] of [
  ['alpha', 'Alpha', 10, 2],
  ['beta', 'Beta', 5, 3],
] as const) {
  const doc = new Y.Doc() as YDoc;
  const row = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;

  doc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, id);
  row.set(K.cells, cells);
  for (const [id, type, data] of [
    ['title', FieldType.RichText, title],
    ['price', FieldType.Number, String(price)],
    ['quantity', FieldType.Number, String(quantity)],
    ['other', FieldType.Number, '100'],
  ] as const) {
    const cell = new Y.Map() as YDatabaseCell;

    cell.set(K.field_type, type);
    cell.set(K.data, data);
    cells.set(id, cell);
  }

  rowDocs[id] = doc;
}

const view = new Y.Map() as YDatabaseView;
const views = new Y.Map() as YDatabaseViews;

view.set(K.id, 'view');
view.set(K.row_orders, Y.Array.from(Object.keys(rowDocs).map((id) => ({ id, height: 44 }))));
view.set(K.field_orders, Y.Array.from(Array.from(fields.keys(), (id) => ({ id }))));
views.set('view', view);
database.set(K.views, views);

const historyDoc = new Y.Doc() as YDoc;
const historyRows = Object.fromEntries(
  Object.entries(rowDocs).map(([id, doc]) => {
    const copy = new Y.Doc() as YDoc;

    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    markDatabaseHistoryDocumentImmutable(copy);
    return [id, copy];
  })
);

Y.applyUpdate(historyDoc, Y.encodeStateAsUpdate(databaseDoc));
markDatabaseHistoryDocumentImmutable(historyDoc);

function Committed() {
  const cell = useCellSelector({ rowId: 'alpha', fieldId: 'total' }) as FormulaCell | undefined;

  return (
    <output data-testid='committed-total' data-status={cell?.evaluationState}>
      {cell?.data ?? ''}
    </output>
  );
}

function Fixture() {
  const host = new URLSearchParams(location.search).get('host');
  const [open, setOpen] = useState(true);
  const [consumers, setConsumers] = useState(true);
  const [history, setHistory] = useState(false);
  const [revision, setRevision] = useState(0);
  const context = useMemo<DatabaseContextState>(
    () => ({
      databaseDoc: history ? historyDoc : databaseDoc,
      databasePageId: 'view',
      activeViewId: 'view',
      readOnly: history,
      workspaceId: 'workspace',
      rowMap: history ? historyRows : rowDocs,
      ...(history ? { dataSource: { type: 'history' as const, id: 'snapshot' } } : {}),
    }),
    [history]
  );

  useEffect(() => {
    const update = () => setRevision((value) => value + 1);

    fields.observeDeep(update);
    return () => fields.unobserveDeep(update);
  }, []);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      evidence.observed.push({
        source: document.querySelector('[data-testid="formula-editor-input"]')?.getAttribute('data-value') ?? '',
        preview: document.querySelector('[data-testid="formula-preview-value"]')?.textContent ?? '',
        diagnostics: document.querySelector('[data-testid="formula-editor-error"]')?.textContent ?? '',
      });
    });

    observer.observe(document.getElementById('root')!, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  void revision;
  const saved = fields.has('total') ? parseFormulaTypeOption(fields.get('total')) : undefined;

  return (
    <main className='flex h-screen flex-col gap-3 p-4'>
      <div className='flex flex-wrap gap-2'>
        <button onClick={() => setOpen(true)}>Open editor</button>
        <button onClick={() => setConsumers(false)}>Close consumers</button>
        <button onClick={() => (evidence.holdNext = 'draft.help')}>Hold next help</button>
        <button onClick={() => (evidence.holdNext = 'engine.evaluate')}>Hold next preview</button>
        <button onClick={() => (evidence.holdNext = 'draft.formatEdits')}>Hold next format</button>
        <button onClick={() => (evidence.holdNext = 'draft.intoDefinition')}>Hold next save</button>
        <button onClick={() => releaseHeldReply?.()}>Release reply</button>
        <button
          onClick={() => {
            const row = rowDocs.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow;

            row.get(K.cells).get('price').set(K.data, '15');
          }}
        >
          Set Price to 15
        </button>
        <button
          onClick={() =>
            databaseDoc.transact(() => {
              fields.get('price').set(K.name, '金额💰');
              fields.get('other').set(K.name, 'Price');
            })
          }
        >
          Rename and reuse Price
        </button>
        <button onClick={() => fields.delete('price')}>Remove Price</button>
        <button onClick={() => fields.get('other').set(K.name, 'Price')}>Duplicate Price name</button>
        <button onClick={() => fields.get('price').set(K.type, FieldType.RichText)}>Retype Price as text</button>
        <button onClick={() => fields.get('total').set(K.type, FieldType.RichText)}>Retype Total as text</button>
        <button
          onClick={() =>
            databaseDoc.transact(() => {
              const options = fields.get('total').get(K.type_option).get(String(FieldType.Formula));

              options.set(K.expression, '100');
              options.set(K.format, 2);
            })
          }
        >
          Remote formula and format
        </button>
        <button onClick={() => setHistory(true)}>Switch to history</button>
      </div>
      <output data-testid='saved-expression'>{saved?.formula}</output>
      <output data-testid='saved-format'>{saved?.format}</output>
      <DatabaseContext.Provider value={context}>
        {consumers && <Committed />}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button>Property menu</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <FormulaPropertyMenuContent fieldId='total' onRequestEditor={() => setOpen(true)} />
          </DropdownMenuContent>
        </DropdownMenu>
        {host === 'popover' ? (
          <div className='relative mt-8 h-10 w-40' data-testid='editor-host-cell' onClick={() => setOpen(true)}>
            Cell editor
            <FormulaEditorPopover fieldId='total' rowId='alpha' open={open} onOpenChange={setOpen} />
          </div>
        ) : host === 'dialog' ? (
          <FormulaEditorDialog fieldId='total' rowId='alpha' open={open} onOpenChange={setOpen} />
        ) : (
          open && (
            <FormulaEditorPanel
              fieldId='total'
              rowId='alpha'
              onClose={() => setOpen(false)}
              onAutocompleteOpenChange={() => undefined}
            />
          )
        )}
      </DatabaseContext.Provider>
    </main>
  );
}

Object.assign(window, { editorEvidence: evidence, editorFixture: { databaseDoc, historyDoc, rowDocs, fields } });
createRoot(document.getElementById('root')!).render(
  <Suspense fallback='Loading editor'>
    {new URLSearchParams(location.search).has('strict') ? (
      <StrictMode>
        <Fixture />
      </StrictMode>
    ) : (
      <Fixture />
    )}
  </Suspense>
);
