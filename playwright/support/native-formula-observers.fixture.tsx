import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import { FormulaCell, RollupCell } from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import {
  CalculationType,
  FieldType,
  FilterType,
  RollupDisplayMode,
  SortCondition,
} from '@/application/database-yjs/database.type';
import { parseFormulaTypeOption } from '@/application/database-yjs/fields/formula/parse';
import { NumberFilterCondition } from '@/application/database-yjs/fields/number/number.type';
import { invalidateDatabaseDependenciesAfterRestore } from '@/application/database-yjs/restore-dependencies';
import { evaluateRollupCell, RollupComputeContext } from '@/application/database-yjs/rollup/cache';
import { observeRollupCell } from '@/application/database-yjs/rollup/observe';
import { useCellSelector, useRowOrdersSelector } from '@/application/database-yjs/selector';
import { subscribeSharedYjsDeep } from '@/application/database-yjs/shared-yjs-observer';
import { SyncContext } from '@/application/services/js-services/sync-protocol';
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
import { TargetFieldOption, useRollupData } from '@/components/database/components/property/rollup/useRollupData';
import '@/i18n/config';

const evidence = {
  workers: 0,
  terminated: 0,
  requests: [] as string[],
  bindings: 0,
  releases: 0,
  owners: 0,
  restores: 0,
  metadataLoads: [] as unknown[],
  errors: [] as string[],
};
const RealWorker = window.Worker;

window.Worker = class extends RealWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    evidence.workers += 1;
  }

  postMessage(request: { method: string }) {
    evidence.requests.push(request.method);
    super.postMessage(request);
  }

  terminate() {
    evidence.terminated += 1;
    super.terminate();
  }
};
window.addEventListener('error', (event) => evidence.errors.push(event.message));

function createDatabase(id: string) {
  const doc = new Y.Doc({ guid: id }) as YDoc;
  const database = new Y.Map() as YDatabase;
  const fields = new Y.Map() as YDatabaseFields;
  const views = new Y.Map() as YDatabaseViews;
  const view = new Y.Map() as YDatabaseView;

  doc.getMap(E.data_section).set(E.database, database);
  database.set(K.id, id);
  database.set(K.fields, fields);
  database.set(K.views, views);
  view.set(K.id, id);
  view.set(K.row_orders, new Y.Array());
  view.set(K.sorts, new Y.Array());
  view.set(K.filters, new Y.Array());
  views.set(id, view);
  return { doc, database, fields, view };
}

function addField(fields: YDatabaseFields, id: string, type: FieldType, values?: Record<string, unknown>) {
  const field = new Y.Map() as YDatabaseField;

  field.set(K.id, id);
  field.set(K.name, id);
  field.set(K.type, type);
  if (values) {
    const options = new Y.Map();
    const option = new Y.Map();

    Object.entries(values).forEach(([key, value]) => option.set(key, value));
    options.set(String(type), option);
    field.set(K.type_option, options);
  }

  fields.set(id, field);
  return field;
}

function createRow(id: string, values: Record<string, { type: FieldType; data: string | string[] }>) {
  const doc = new Y.Doc() as YDoc;
  const row = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;

  doc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, id);
  row.set(K.cells, cells);
  Object.entries(values).forEach(([fieldId, value]) => {
    const cell = new Y.Map() as YDatabaseCell;

    cell.set(K.field_type, value.type);
    cell.set(K.data, Array.isArray(value.data) ? Y.Array.from(value.data) : value.data);
    cells.set(fieldId, cell);
  });
  return doc;
}

const base = createDatabase('native-observer-owner');
let related = createDatabase('native-observer-related');

addField(related.fields, 'completed', FieldType.Formula, { expression: 'prop("amount")' });
addField(related.fields, 'amount', FieldType.Number);
addField(related.fields, 'title', FieldType.RichText).set(K.is_primary, true);
let relatedRows: Record<string, YDoc> = {
  'task-one': createRow('task-one', { amount: { type: FieldType.Number, data: '10' } }),
  'task-two': createRow('task-two', { amount: { type: FieldType.Number, data: '20' } }),
};

related.view.get(K.row_orders).push(Object.keys(relatedRows).map((id) => ({ id, height: 44 })));

addField(base.fields, 'links', FieldType.Relation, { database_id: related.doc.guid });
const rollupField = addField(base.fields, 'rollup', FieldType.Rollup, {
  relation_field_id: 'links',
  target_field_id: 'completed',
  calculation_type: CalculationType.Sum,
  show_as: RollupDisplayMode.Calculated,
});

addField(base.fields, 'twice', FieldType.Formula, { expression: 'prop("rollup") * 2' });
addField(base.fields, 'summary', FieldType.Formula, { expression: '"Hours: " + format(prop("rollup"))' });
const rows = {
  alpha: createRow('alpha', { links: { type: FieldType.Relation, data: ['task-one'] } }),
  beta: createRow('beta', { links: { type: FieldType.Relation, data: ['task-two'] } }),
};

base.view.get(K.row_orders).push(Object.keys(rows).map((id) => ({ id, height: 44 })));
const cached = new Y.Doc({ guid: related.doc.guid }) as YDoc;

Y.applyUpdate(cached, Y.encodeStateAsUpdate(related.doc));
type Mode = 'none' | 'zero' | 'zero-summary' | 'restore' | 'sync' | 'settings' | 'settings-dynamic';
let currentMode: Mode = 'none';
const forwardRemoteSchema = (update: Uint8Array) => Y.applyUpdate(cached, update);
const context: DatabaseContextState = {
  databaseDoc: base.doc,
  databasePageId: base.doc.guid,
  activeViewId: base.doc.guid,
  workspaceId: 'workspace',
  readOnly: false,
  rowMap: rows,
  getViewIdFromDatabaseId: async (id) => id,
  loadView: async (...args) => {
    evidence.metadataLoads.push(args);
    return currentMode === 'sync' ? cached : related.doc;
  },
  createRow: async (key) => relatedRows[key.split('_rows_').pop()!],
};

function setExpression(value: string) {
  related.fields.get('completed').get(K.type_option).get(String(FieldType.Formula)).set('expression', value);
}

function setAmount(id: string, value: string) {
  (relatedRows[id].getMap(E.data_section).get(E.database_row) as YDatabaseRow)
    .get(K.cells)
    .get('amount')
    .set(K.data, value);
}

function setRelation(ids: string[]) {
  (rows.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow)
    .get(K.cells)
    .get('links')
    .set(K.data, Y.Array.from(ids));
}

function clone(doc: YDoc) {
  const next = new Y.Doc({ guid: doc.guid }) as YDoc;

  Y.applyUpdate(next, Y.encodeStateAsUpdate(doc));
  return next;
}

function restoreAmounts(values: [number, number]) {
  const nextDoc = clone(related.doc);
  const nextDatabase = nextDoc.getMap(E.data_section).get(E.database) as YDatabase;
  const nextRows = Object.fromEntries(Object.entries(relatedRows).map(([id, doc]) => [id, clone(doc)]));

  related.doc.destroy();
  Object.values(relatedRows).forEach((doc) => doc.destroy());
  related = {
    doc: nextDoc,
    database: nextDatabase,
    fields: nextDatabase.get(K.fields),
    view: nextDatabase.get(K.views).get(nextDoc.guid),
  };
  relatedRows = nextRows;
  values.forEach((value, index) => setAmount(index === 0 ? 'task-one' : 'task-two', String(value)));
  evidence.restores += 1;
  invalidateDatabaseDependenciesAfterRestore();
}

function configure(mode: Mode) {
  currentMode = mode;
  if (mode.startsWith('zero')) setExpression('0');
  if (mode === 'restore') {
    const filter = new Y.Map() as YDatabaseFilter;
    const sort = new Y.Map() as YDatabaseSort;

    filter.set(K.id, 'formula-filter');
    filter.set(K.field_id, 'twice');
    filter.set(K.type, FieldType.Formula);
    filter.set(K.filter_type, FilterType.Data);
    filter.set(K.condition, NumberFilterCondition.GreaterThan);
    filter.set(K.content, '30');
    sort.set(K.id, 'formula-sort');
    sort.set(K.field_id, 'twice');
    sort.set(K.condition, SortCondition.Ascending);
    base.view.get(K.filters).push([filter]);
    base.view.get(K.sorts).push([sort]);
  }

  if (mode === 'settings') {
    setExpression('1 + 2');
    rollupField.get(K.type_option).get(String(FieldType.Rollup)).set(K.relation_field_id, '');
    rollupField.get(K.type_option).get(String(FieldType.Rollup)).set(K.target_field_id, '');
    const filter = new Y.Map() as YDatabaseFilter;

    filter.set(K.id, 'settings-filter');
    filter.set(K.field_id, 'rollup');
    filter.set(K.type, FieldType.Rollup);
    filter.set(K.filter_type, FilterType.Data);
    filter.set(K.condition, NumberFilterCondition.GreaterThan);
    filter.set(K.content, '0');
    base.view.get(K.filters).push([filter]);
  }

  if (mode === 'settings-dynamic') {
    setExpression('if(empty(prop("amount")), empty(), prop("amount"))');
    rollupField.get(K.type_option).get(String(FieldType.Rollup)).set(K.calculation_type, CalculationType.Average);
  }
}

function OwnerRollup() {
  const cell = useCellSelector({ rowId: 'alpha', fieldId: 'rollup' }) as RollupCell | undefined;

  return (
    <output
      data-testid='owner-alpha-rollup'
      data-evaluation-state={cell?.error ? 'error' : cell?.data === '' ? 'null' : 'value'}
    >
      {cell?.error ?? cell?.data ?? ''}
    </output>
  );
}

function OwnerFormula({ id, testId }: { id: string; testId: string }) {
  const cell = useCellSelector({ rowId: 'alpha', fieldId: id }) as FormulaCell | undefined;

  return (
    <output data-testid={testId} data-evaluation-state={cell?.evaluationState ?? 'pending'}>
      {cell?.error ?? cell?.data ?? ''}
    </output>
  );
}

function Conditions() {
  const orders = useRowOrdersSelector();

  return <output data-testid='observer-orders'>{orders?.map(({ id }) => id).join(',')}</output>;
}

function RemoteObservers() {
  const [values, setValues] = useState(['', '']);
  const [revision, setRevision] = useState(0);
  const stops = useRef<Array<() => void>>([]);
  const stopped = useRef(new Set<number>());

  useEffect(() => {
    const computeContext: RollupComputeContext = {
      ...context,
      baseDoc: base.doc,
      database: base.database,
      rollupField,
      row: rows.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow,
      rowId: 'alpha',
      fieldId: 'rollup',
      bindViewSync: (doc, options) => {
        if (doc !== cached || !options?.retain) throw new Error('Related schema sync was not retained');
        evidence.bindings += 1;
        if (evidence.owners++ === 0) related.doc.on('update', forwardRemoteSchema);
        setRevision((value) => value + 1);
        return { doc } as SyncContext;
      },
      scheduleDeferredCleanup: (id) => {
        if (id !== cached.guid) throw new Error(`Unexpected sync release ${id}`);
        evidence.releases += 1;
        if (--evidence.owners === 0) related.doc.off('update', forwardRemoteSchema);
        setRevision((value) => value + 1);
      },
    };

    stops.current = [0, 1].map((index) =>
      observeRollupCell(computeContext, () => {
        void evaluateRollupCell(computeContext).then((result) => {
          if (stopped.current.has(index)) return;
          setValues((current) => current.map((value, at) => (at === index ? result.error ?? result.value : value)));
        });
      })
    );
    return () => stops.current.forEach((stop) => stop());
  }, []);

  const remoteEdit = (multiple: number) => {
    setExpression(`prop("amount") * ${multiple}`);
    setRevision((value) => value + 1);
  };

  const dispose = (index: number) => {
    stopped.current.add(index);
    stops.current[index]?.();
    setRevision((value) => value + 1);
  };

  void revision;

  return (
    <>
      <output data-testid='sync-first'>{values[0]}</output>
      <output data-testid='sync-second'>{values[1]}</output>
      <output data-testid='sync-owners'>{evidence.owners}</output>
      <output data-testid='cached-expression'>
        {
          parseFormulaTypeOption(
            (cached.getMap(E.data_section).get(E.database) as YDatabase).get(K.fields).get('completed')
          ).formula
        }
      </output>
      <button onClick={() => remoteEdit(2)}>Remote Formula times two</button>
      <button onClick={() => remoteEdit(3)}>Remote Formula times three</button>
      <button onClick={() => remoteEdit(4)}>Remote Formula times four</button>
      <button onClick={() => dispose(0)}>Dispose first observer</button>
      <button onClick={() => dispose(1)}>Dispose second observer</button>
    </>
  );
}

function TargetSettings() {
  const data = useRollupData('rollup');
  const remembered = useRef<TargetFieldOption>();
  const storedType = useSyncExternalStore(
    (notify) => subscribeSharedYjsDeep(base.view, notify),
    () => {
      const filter = base.view.get(K.filters).toArray()[0] as Y.Map<unknown> | undefined;

      return (filter?.get(K.rollup_meta) as { target_field_type?: number } | undefined)?.target_field_type;
    }
  );

  return (
    <>
      <output data-testid='settings-targets'>{data.relatedFields.map(({ id }) => id).join(',')}</output>
      <output data-testid='settings-target'>
        {data.targetField ? `${data.targetField.id}:${FieldType[data.targetField.effectiveType]}` : ''}
      </output>
      <output data-testid='settings-calculation'>{CalculationType[data.rollupOption.calculation_type]}</output>
      <output data-testid='settings-stored-target-type'>
        {storedType === undefined ? '' : FieldType[Number(storedType)]}
      </output>
      <button onClick={() => void data.selectRelationField(data.relationFields[0])}>Select related database</button>
      <button
        onClick={() => {
          remembered.current = data.targetField;
        }}
      >
        Remember target selection
      </button>
      <button
        onClick={() => {
          if (remembered.current) data.selectTargetField(remembered.current);
        }}
      >
        Select remembered target
      </button>
      <button onClick={() => setExpression('true')}>Change settings Formula to boolean</button>
      <button onClick={() => setAmount('task-one', '')}>Clear saved dynamic amount</button>
    </>
  );
}

function Fixture() {
  const [mode, setMode] = useState<Mode>('none');
  const open = (value: Mode) => {
    configure(value);
    setMode(value);
  };

  return (
    <DatabaseContext.Provider value={context}>
      <main>
        <button onClick={() => open('zero')}>Open zero Sum</button>
        <button onClick={() => open('zero-summary')}>Open zero Sum and summary</button>
        <button onClick={() => open('restore')}>Open restored conditions</button>
        <button onClick={() => open('sync')}>Open remote schema observers</button>
        <button onClick={() => open('settings')}>Open native target settings</button>
        <button onClick={() => open('settings-dynamic')}>Open saved dynamic Average settings</button>
        <button onClick={() => setRelation([])}>Clear first relation</button>
        <button onClick={() => setRelation(['task-one'])}>Restore first relation</button>
        <button onClick={() => setExpression('7')}>Change target Formula to seven</button>
        <button onClick={() => restoreAmounts([30, 5])}>Restore older source</button>
        <button onClick={() => restoreAmounts([50, 40])}>Restore newer source</button>
        <button onClick={() => setAmount('task-one', '35')}>Edit restored first amount</button>
        {(mode.startsWith('zero') || mode === 'settings-dynamic') && <OwnerRollup />}
        {mode === 'zero-summary' && <OwnerFormula id='summary' testId='owner-summary' />}
        {mode === 'restore' && (
          <>
            <OwnerFormula id='twice' testId='owner-alpha-formula' />
            <Conditions />
          </>
        )}
        {mode === 'sync' && <RemoteObservers />}
        {mode.startsWith('settings') && <TargetSettings />}
      </main>
    </DatabaseContext.Provider>
  );
}

Object.assign(window, { formulaObserverEvidence: evidence });
createRoot(document.getElementById('root')!).render(<Fixture />);
