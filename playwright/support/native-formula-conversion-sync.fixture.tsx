import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { CalculationType, FieldType, RollupDisplayMode } from '@/application/database-yjs/database.type';
import { useSwitchPropertyType } from '@/application/database-yjs/dispatch';
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
import '@/i18n/config';

const evidence = {
  workers: 0,
  terminated: 0,
  owners: 0,
  bindings: 0,
  releases: 0,
  held: false,
  holdNext: false,
  metadataHeld: false,
  holdMetadata: false,
  metadataListeners: 0,
  metadataAttachments: 0,
  requests: [] as string[],
  errors: [] as string[],
};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const RealWorker = window.Worker;
let releaseEvaluation: (() => void) | undefined;

// Hold delivery of the owner's real native result, after nested target rows
// have evaluated. Every computation still runs in the actual SDK Worker/Wasm.
window.Worker = class extends RealWorker {
  private ownerEvaluations = new Set<number>();

  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    evidence.workers += 1;
    notify();
    super.addEventListener('message', (event: MessageEvent<{ id: number }>) => {
      if (!this.ownerEvaluations.delete(event.data.id) || !evidence.holdNext) return;
      evidence.holdNext = false;
      evidence.held = true;
      event.stopImmediatePropagation();
      releaseEvaluation = () => {
        evidence.held = false;
        this.dispatchEvent(new MessageEvent('message', { data: event.data }));
        releaseEvaluation = undefined;
        notify();
      };

      notify();
    });
  }

  postMessage(request: { id: number; method: string; args: Array<{ formula_ids?: string[] }> }) {
    evidence.requests.push(request.method);
    if (request.method === 'engine.evaluate' && request.args[0]?.formula_ids?.includes('formula'))
      this.ownerEvaluations.add(request.id);
    super.postMessage(request);
  }

  terminate() {
    evidence.terminated += 1;
    super.terminate();
    notify();
  }
};

function database(id: string) {
  const doc = new Y.Doc({ guid: id }) as YDoc;
  const value = new Y.Map() as YDatabase;
  const fields = new Y.Map() as YDatabaseFields;
  const views = new Y.Map() as YDatabaseViews;
  const view = new Y.Map() as YDatabaseView;

  doc.getMap(E.data_section).set(E.database, value);
  value.set(K.id, id);
  value.set(K.fields, fields);
  value.set(K.views, views);
  view.set(K.id, id);
  view.set(K.row_orders, new Y.Array());
  views.set(id, view);
  return { doc, value, fields, view };
}

function field(fields: YDatabaseFields, id: string, type: FieldType, values?: Record<string, unknown>) {
  const value = new Y.Map() as YDatabaseField;

  value.set(K.id, id);
  value.set(K.name, id);
  value.set(K.type, type);
  if (values) {
    const options = new Y.Map();
    const option = new Y.Map();

    Object.entries(values).forEach(([key, item]) => option.set(key, item));
    options.set(String(type), option);
    value.set(K.type_option, options);
  }

  fields.set(id, value);
}

function row(id: string, fieldId: string, type: FieldType, data: string | string[]) {
  const doc = new Y.Doc() as YDoc;
  const value = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;
  const cell = new Y.Map() as YDatabaseCell;

  doc.getMap(E.data_section).set(E.database_row, value);
  value.set(K.id, id);
  value.set(K.cells, cells);
  cell.set(K.field_type, type);
  cell.set(K.data, Array.isArray(data) ? Y.Array.from(data) : data);
  cells.set(fieldId, cell);
  return doc;
}

const base = database('conversion-owner');
const remote = database('conversion-related');

field(remote.fields, 'amount', FieldType.Number);
field(remote.fields, 'target', FieldType.Formula, { expression: 'prop("amount")' });
const relatedRows = {
  'child-one': row('child-one', 'amount', FieldType.Number, '6'),
  'child-two': row('child-two', 'amount', FieldType.Number, '8'),
};

remote.view.get(K.row_orders).push(Object.keys(relatedRows).map((id) => ({ id, height: 44 })));
const cached = new Y.Doc({ guid: remote.doc.guid }) as YDoc;

Y.applyUpdate(cached, Y.encodeStateAsUpdate(remote.doc));
const metadataCallbacks = new Set<unknown>();
const originalOn = cached.on.bind(cached);
const originalOff = cached.off.bind(cached);

cached.on = (event, listener) => {
  if (event === 'update') {
    metadataCallbacks.add(listener);
    evidence.metadataListeners = metadataCallbacks.size;
    evidence.metadataAttachments += 1;
    notify();
  }

  return originalOn(event, listener);
};

cached.off = (event, listener) => {
  if (event === 'update') {
    metadataCallbacks.delete(listener);
    evidence.metadataListeners = metadataCallbacks.size;
    notify();
  }

  return originalOff(event, listener);
};

field(base.fields, 'links', FieldType.Relation, { database_id: remote.doc.guid });
field(base.fields, 'rollup', FieldType.Rollup, {
  relation_field_id: 'links',
  target_field_id: 'target',
  calculation_type: CalculationType.Sum,
  show_as: RollupDisplayMode.Calculated,
});
field(base.fields, 'formula', FieldType.Formula, { expression: 'prop("rollup") * 2' });
const rows = {
  alpha: row('alpha', 'links', FieldType.Relation, ['child-one']),
  beta: row('beta', 'links', FieldType.Relation, ['child-two']),
};

base.view.get(K.row_orders).push(Object.keys(rows).map((id) => ({ id, height: 44 })));
const forward = (update: Uint8Array) => Y.applyUpdate(cached, update);
const pendingMetadata: Array<(doc: YDoc) => void> = [];
const context: DatabaseContextState = {
  databaseDoc: base.doc,
  databasePageId: base.doc.guid,
  activeViewId: base.doc.guid,
  workspaceId: 'workspace',
  readOnly: false,
  rowMap: { alpha: rows.alpha },
  ensureRow: async (id) => rows[id as keyof typeof rows],
  getViewIdFromDatabaseId: async (id) => id,
  loadView: async () => {
    if (evidence.holdMetadata) {
      evidence.metadataHeld = true;
      notify();
      return new Promise<YDoc>((resolve) => pendingMetadata.push(resolve));
    }

    return cached;
  },
  createRow: async (key) => relatedRows[key.split('_rows_').pop() as keyof typeof relatedRows],
  bindViewSync: (doc, options) => {
    if (doc !== cached || !options?.retain) throw new Error('Conversion did not retain related metadata');
    evidence.bindings += 1;
    if (evidence.owners++ === 0) remote.doc.on('update', forward);
    // Canonical server/IndexedDB snapshots catch up only once a sync owner
    // binds them; later remote updates use the same real Yjs transport.
    Y.applyUpdate(cached, Y.encodeStateAsUpdate(remote.doc));
    notify();
    return { doc } as SyncContext;
  },
  scheduleDeferredCleanup: (id) => {
    if (id !== cached.guid) throw new Error(`Unexpected conversion sync release ${id}`);
    evidence.releases += 1;
    if (--evidence.owners === 0) remote.doc.off('update', forward);
    notify();
  },
};

function raw(id: keyof typeof rows) {
  return String(
    (rows[id].getMap(E.data_section).get(E.database_row) as YDatabaseRow).get(K.cells).get('formula')?.get(K.data) ?? ''
  );
}

function Fixture() {
  const switchType = useSwitchPropertyType();
  const [state, setState] = useState('idle');
  const [oldState, setOldState] = useState('idle');

  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => JSON.stringify(evidence)
  );
  const convert = (hold: boolean) => {
    evidence.holdNext = hold;
    setState('pending');
    setOldState('pending');
    void switchType('formula', FieldType.Number).then(
      () => {
        setState('converted');
        setOldState('converted');
      },
      (error: Error) => {
        evidence.errors.push(error.message);
        setOldState(`error:${error.message}`);
      }
    );
  };

  return (
    <main>
      <button onClick={() => convert(false)}>Convert Formula to Number</button>
      <button onClick={() => convert(true)}>Hold native conversion</button>
      <button onClick={() => releaseEvaluation?.()}>Release native conversion</button>
      <button
        onClick={() => {
          remote.fields
            .get('target')
            .get(K.type_option)
            .get(String(FieldType.Formula))
            .set('expression', 'prop("amount") * 3');
        }}
      >
        Remote metadata times three
      </button>
      <button
        onClick={() => {
          void switchType('formula', FieldType.Formula).then(() => setState('cancelled'));
        }}
      >
        Cancel conversion
      </button>
      <button
        onClick={() => {
          evidence.holdMetadata = true;
        }}
      >
        Hold metadata load
      </button>
      <button
        onClick={() => {
          evidence.holdMetadata = false;
          evidence.metadataHeld = false;
          pendingMetadata.splice(0).forEach((resolve) => resolve(cached));
          notify();
        }}
      >
        Release metadata load
      </button>
      <output data-testid='conversion-state'>{state}</output>
      <output data-testid='old-conversion-state'>{oldState}</output>
      <output data-testid='conversion-held'>{String(evidence.held)}</output>
      <output data-testid='metadata-held'>{String(evidence.metadataHeld)}</output>
      <output data-testid='conversion-owners'>{evidence.owners}</output>
      <output data-testid='conversion-workers'>{evidence.workers}</output>
      <output data-testid='metadata-listeners'>{evidence.metadataListeners}</output>
      <output data-testid='metadata-attachments'>{evidence.metadataAttachments}</output>
      <output data-testid='stored-type'>{FieldType[Number(base.fields.get('formula').get(K.type))]}</output>
      <output data-testid='converted-alpha'>{raw('alpha')}</output>
      <output data-testid='converted-beta'>{raw('beta')}</output>
    </main>
  );
}

Object.assign(window, { conversionSyncEvidence: evidence });
createRoot(document.getElementById('root')!).render(
  <DatabaseContext.Provider value={context}>
    <Fixture />
  </DatabaseContext.Provider>
);
