import { StrictMode, Suspense, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { quoteFormulaString } from '@notion-formula/sdk';
import * as Y from 'yjs';

import { FormulaCell } from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { CalculationType, FieldType, RollupDisplayMode } from '@/application/database-yjs/database.type';
import { parseFormulaTypeOption } from '@/application/database-yjs/fields/formula/parse';
import { readFormulaSchema } from '@/application/database-yjs/fields/formula/schema';
import { markDatabaseHistoryDocumentImmutable } from '@/application/database-yjs/immutable';
import { useCellSelector } from '@/application/database-yjs/selector';
import { db } from '@/application/db';
import { SyncContext } from '@/application/services/js-services/sync-protocol';
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
import {
  displayNativePropertyNames,
  NativeFormulaEditorSession,
  nativeEditorProperties,
} from '@/components/database/components/property/formula/native-editor';
import { findPropReferences } from '@/components/database/components/property/formula/property-references';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import '@/i18n/config';
import '@/styles/global.css';

// Match index.html: Tailwind utilities are scoped below this application root.
document.body.id = 'body';

const evidence = {
  workers: 0,
  terminated: 0,
  held: false,
  holdNext: null as string | null,
  requests: [] as Array<{ worker: number; method: string; args: unknown[] }>,
  replies: [] as Array<{ worker: number; method: string; value: unknown }>,
  observed: [] as Array<{ source: string; preview: string; diagnostics: string }>,
  pageErrors: [] as string[],
  clockOwners: 0,
  external: {
    bindings: 0,
    releases: 0,
    owners: 0,
    metadataLoads: 0,
    rowLoads: 0,
    metadataObservers: 0,
    rowObservers: 0,
    pendingSources: 0,
    sourceReturns: 0,
  },
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

function field(id: string, name: string, type: FieldType, expression?: string, target = fields) {
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

  target.set(id, value);
  return value;
}

field('title', 'Name', FieldType.RichText).set(K.is_primary, true);
field('price', 'Price', FieldType.Number);
field('other', 'Other', FieldType.Number);
field('quantity', 'Quantity', FieldType.Number);
field('subtotal', 'Subtotal', FieldType.Formula, 'prop("price") * prop("quantity")');
field('total', 'Total', FieldType.Formula, 'prop("subtotal") + 5');

const peoplePreview = new URLSearchParams(location.search).has('people');

if (peoplePreview) {
  const person = field('person', 'Person', FieldType.Person);
  const options = new Y.Map();
  const option = new Y.Map();

  option.set(K.persons, JSON.stringify([{ id: 'person-ada', name: 'Saved Ada' }]));
  options.set(String(FieldType.Person), option);
  person.set(K.type_option, options);
  field('creator', 'Created by', FieldType.CreatedBy);
  field('editor', 'Last edited by', FieldType.LastEditedBy);
}

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
  if (peoplePreview) {
    const cell = new Y.Map() as YDatabaseCell;

    cell.set(K.field_type, FieldType.Person);
    cell.set(K.data, JSON.stringify(['person-ada']));
    cells.set('person', cell);
    row.set(K.created_by, '9007199254740993');
    row.set(K.last_edited_by, '9007199254740993');
  }

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

const relatedDoc = new Y.Doc({ guid: 'preview-related' }) as YDoc;
const relatedDatabase = new Y.Map() as YDatabase;
const relatedFields = new Y.Map() as YDatabaseFields;
const relatedViews = new Y.Map() as YDatabaseViews;
const relatedView = new Y.Map() as YDatabaseView;
const relatedRow = new Y.Doc() as YDoc;
const relatedRowData = new Y.Map() as YDatabaseRow;
const relatedCells = new Y.Map() as YDatabaseCells;

relatedDoc.getMap(E.data_section).set(E.database, relatedDatabase);
relatedDatabase.set(K.id, relatedDoc.guid);
relatedDatabase.set(K.fields, relatedFields);
relatedDatabase.set(K.views, relatedViews);
relatedView.set(K.id, relatedDoc.guid);
relatedView.set(K.row_orders, Y.Array.from([{ id: 'task', height: 44 }]));
relatedViews.set(relatedDoc.guid, relatedView);
field('title', 'Task', FieldType.RichText, undefined, relatedFields).set(K.is_primary, true);
field('amount', 'Amount', FieldType.Number, undefined, relatedFields);
field('result', 'Result', FieldType.Formula, 'prop("amount")', relatedFields);
relatedRow.getMap(E.data_section).set(E.database_row, relatedRowData);
relatedRowData.set(K.id, 'task');
relatedRowData.set(K.cells, relatedCells);
for (const [id, type, data] of [
  ['title', FieldType.RichText, 'Task'],
  ['amount', FieldType.Number, '6'],
] as const) {
  const cell = new Y.Map() as YDatabaseCell;

  cell.set(K.field_type, type);
  cell.set(K.data, data);
  relatedCells.set(id, cell);
}

// Instrument the public Yjs subscription boundary, so a late provider reply
// cannot silently reopen update listeners after Cancel or a newer edit.
function trackSourceUpdates(doc: YDoc, key: 'metadataObservers' | 'rowObservers') {
  const on = doc.on.bind(doc);
  const off = doc.off.bind(doc);
  const listeners = new Set<unknown>();

  doc.on = (name, listener) => {
    if (name === 'update') {
      listeners.add(listener);
      evidence.external[key] = listeners.size;
    }

    return on(name, listener);
  };

  doc.off = (name, listener) => {
    if (name === 'update') {
      listeners.delete(listener);
      evidence.external[key] = listeners.size;
    }

    return off(name, listener);
  };
}

let cachedRelated = new Y.Doc({ guid: relatedDoc.guid }) as YDoc;
let holdNextSource: 'metadata' | 'row' | undefined;
const pendingSources: Array<() => void> = [];
const forwardMetadata = (update: Uint8Array) => Y.applyUpdate(cachedRelated, update);

trackSourceUpdates(relatedRow, 'rowObservers');
function sourceReply(kind: 'metadata' | 'row', doc: YDoc) {
  return new Promise<YDoc>((resolve) => {
    const reply = () => {
      evidence.external.sourceReturns += 1;
      resolve(doc);
    };

    if (holdNextSource === kind) {
      holdNextSource = undefined;
      pendingSources.push(reply);
      evidence.external.pendingSources = pendingSources.length;
    } else reply();
  });
}

const externalLoaders: Partial<DatabaseContextState> = {
  getViewIdFromDatabaseId: async (id) => id,
  loadView: async () => {
    evidence.external.metadataLoads += 1;
    return sourceReply('metadata', cachedRelated);
  },
  createRow: async () => {
    evidence.external.rowLoads += 1;
    return sourceReply('row', relatedRow);
  },
  bindViewSync: (doc, options) => {
    if (doc !== cachedRelated || !options?.retain) throw new Error('Preview metadata sync was not retained');
    evidence.external.bindings += 1;
    if (evidence.external.owners++ === 0) relatedDoc.on('update', forwardMetadata);
    // A cold metadata-only document becomes hydrated by its retained sync.
    Y.applyUpdate(cachedRelated, Y.encodeStateAsUpdate(relatedDoc));
    return { doc } as SyncContext;
  },
  scheduleDeferredCleanup: (id) => {
    if (id !== cachedRelated.guid || evidence.external.owners <= 0) throw new Error(`Unexpected preview release ${id}`);
    evidence.external.releases += 1;
    if (--evidence.external.owners === 0) relatedDoc.off('update', forwardMetadata);
  },
};

function enableExternalSources({
  cold = false,
  clock = false,
  people = false,
}: { cold?: boolean; clock?: boolean; people?: boolean } = {}) {
  relatedFields
    .get('result')
    .get(K.type_option)
    .get(String(FieldType.Formula))
    .set(K.expression, clock ? 'timestamp(now())' : 'prop("amount")');
  if (people) {
    field('person', 'Person', FieldType.Person, undefined, relatedFields);
    const person = new Y.Map() as YDatabaseCell;

    person.set(K.field_type, FieldType.Person);
    person.set(K.data, JSON.stringify(['person-ada']));
    relatedCells.set('person', person);
  }

  cachedRelated = new Y.Doc({ guid: relatedDoc.guid }) as YDoc;
  if (!cold) Y.applyUpdate(cachedRelated, Y.encodeStateAsUpdate(relatedDoc));
  trackSourceUpdates(cachedRelated, 'metadataObservers');
  const links = field('links', 'Links', FieldType.Relation);
  const rollup = field('rollup', 'Rollup', FieldType.Rollup);

  for (const [target, type, values] of [
    [links, FieldType.Relation, { database_id: relatedDoc.guid }],
    [
      rollup,
      FieldType.Rollup,
      {
        relation_field_id: 'links',
        target_field_id: people ? 'person' : 'result',
        calculation_type: people ? CalculationType.Count : CalculationType.Sum,
        show_as: people ? RollupDisplayMode.OriginalList : RollupDisplayMode.Calculated,
      },
    ],
  ] as const) {
    const options = new Y.Map();
    const option = new Y.Map();

    Object.entries(values).forEach(([key, value]) => option.set(key, value));
    options.set(String(type), option);
    target.set(K.type_option, options);
  }

  const cell = new Y.Map() as YDatabaseCell;

  cell.set(K.field_type, FieldType.Relation);
  cell.set(K.data, Y.Array.from(['task']));
  (rowDocs.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow).get(K.cells).set('links', cell);
}

function Committed() {
  const cell = useCellSelector({ rowId: 'alpha', fieldId: 'total' }) as FormulaCell | undefined;

  return (
    <output data-testid='committed-total' data-status={cell?.evaluationState}>
      {cell?.data ?? ''}
    </output>
  );
}

async function inspectExpression(expression: string, source = expression) {
  const schema = readFormulaSchema(fields);
  const native = new NativeFormulaEditorSession('token-inspection');

  try {
    const state = await native.state(nativeEditorProperties(schema), expression);

    return snapshot({
      references: findPropReferences(source, state.tokens),
      tokens: state.tokens,
      diagnostics: state.diagnostics,
      display: displayNativePropertyNames(state, schema),
    });
  } finally {
    native.close();
  }
}

function addTextProperty(id: string, name: string, value: string) {
  databaseDoc.transact(() => {
    field(id, name, FieldType.RichText);
    for (const doc of Object.values(rowDocs)) {
      const cell = new Y.Map() as YDatabaseCell;

      cell.set(K.field_type, FieldType.RichText);
      cell.set(K.data, value);
      (doc.getMap(E.data_section).get(E.database_row) as YDatabaseRow).get(K.cells).set(id, cell);
    }
  });
}

async function setMemberName(name: string) {
  await db.workspace_member_profiles.put({
    workspace_id: 'workspace',
    user_uuid: 'person-ada',
    person_id: 'person-ada',
    uid: '9007199254740993',
    name,
    updated_at: Date.now(),
    avatar_url: null,
    cover_image_url: null,
    custom_image_url: null,
    description: null,
    email: '',
    role: 1,
    invited: false,
    last_mentioned_at: null,
  });
}

// Observe ownership through the shared clock's public browser focus hook.
// All formula consumers are closed before these preview-only scenarios.
function trackClockSubscriptions() {
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  const listeners = new Set<EventListenerOrEventListenerObject>();

  window.addEventListener = ((
    name: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (name === 'focus' && listener) {
      listeners.add(listener);
      evidence.clockOwners = listeners.size;
    }

    add(name, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((
    name: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) => {
    if (name === 'focus' && listener) {
      listeners.delete(listener);
      evidence.clockOwners = listeners.size;
    }

    remove(name, listener, options);
  }) as typeof window.removeEventListener;
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
      ...(!history ? externalLoaders : {}),
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

Object.assign(window, {
  editorEvidence: evidence,
  editorFixture: {
    databaseDoc,
    historyDoc,
    rowDocs,
    fields,
    inspectExpression,
    quoteFormulaString,
    addTextProperty,
    holdNextReply: (method: string) => {
      evidence.holdNext = method;
    },
    setSavedExpression: (expression: string) =>
      fields.get('total').get(K.type_option).get(String(FieldType.Formula)).set(K.expression, expression),
    addClockFormula: () => field('clock', 'Clock', FieldType.Formula, 'timestamp(now())'),
    enableExternalSources,
    setMemberName,
    trackClockSubscriptions,
    holdSource: (kind: 'metadata' | 'row') => {
      holdNextSource = kind;
    },
    releaseSource: () => {
      pendingSources.shift()?.();
      evidence.external.pendingSources = pendingSources.length;
    },
    setRemoteExpression: (expression: string) =>
      relatedFields.get('result').get(K.type_option).get(String(FieldType.Formula)).set(K.expression, expression),
  },
});
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
