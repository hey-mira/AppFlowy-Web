import * as Y from 'yjs';

import { CalculationType as C, FieldType as F, RollupDisplayMode as D } from '@/application/database-yjs/database.type';
import {
  CellSpec,
  createFields,
  createRow,
  FieldSpec,
} from '@/application/database-yjs/fields/formula/__tests__/fixture';
import { createRelationField } from '@/application/database-yjs/fields/relation/utils';
import { readRollupCondition, writeRollupCondition } from '@/application/database-yjs/fields/rollup/condition';
import { createRollupField } from '@/application/database-yjs/fields/rollup/utils';
import { getNativeFormulaPropertyState } from '@/application/database-yjs/formula/native-values';
import { evaluateRollupCell, readRollupCell, RollupCellValue } from '@/application/database-yjs/rollup/cache';
import { observeRollupCell } from '@/application/database-yjs/rollup/observe';
import { getRowKey } from '@/application/database-yjs/row_meta';
import {
  YDatabase,
  YDatabaseCell,
  YDatabaseField,
  YDatabaseRow,
  YDatabaseView,
  YDatabaseViews,
  YDoc,
  YjsDatabaseKey as K,
  YjsEditorKey as E,
} from '@/application/types';
import '@/i18n/config';

import type { ValueType } from '@notion-formula/sdk';

type Snapshot = Pick<
  RollupCellValue,
  'value' | 'error' | 'rawNumeric' | 'rawDate' | 'filterCells' | 'list' | 'targetFieldType'
>;
type Result = { id: string; expression: string; result: Snapshot; nativeType?: ValueType };

export interface RollupReport {
  mode: string;
  workers: number;
  terminated: number;
  evaluations: number;
  notifications: number;
  rowLoads: number;
  metadataLoads: number;
  failure?: string;
  results: Result[];
  snapshots: Result[];
  wire: Array<{ raw: string; decoded: string[]; roundTrip: string[] }>;
}

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'matrix';
const report: RollupReport = {
  mode,
  workers: 0,
  terminated: 0,
  evaluations: 0,
  notifications: 0,
  rowLoads: 0,
  metadataLoads: 0,
  results: [],
  snapshots: [],
  wire: [],
};

(window as unknown as { nativeRollupReport: RollupReport }).nativeRollupReport = report;
const RealWorker = window.Worker;

// Count the packaged Workers without replacing their computation or delivery.
window.Worker = class extends RealWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    report.workers += 1;
  }

  postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
    if (message && typeof message === 'object' && 'method' in message && message.method === 'engine.evaluate')
      report.evaluations += 1;
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }

  terminate() {
    report.terminated += 1;
    super.terminate();
  }
};

const root = document.getElementById('root')!;

root.innerHTML =
  '<h1>Native Formula Rollups</h1><p data-testid="rollup-ready">loading</p><output data-testid="rollup-value"></output><output data-testid="rollup-native-type"></output><p data-testid="rollup-phase">loading</p><p>Observer notifications: <output data-testid="rollup-notifications">0</output>; row loads: <output data-testid="rollup-row-loads">0</output></p><div id="actions"></div><pre id="evidence"></pre>';
const text = (id: string, value: string) => {
  root.querySelector(`[data-testid="${id}"]`)!.textContent = value;
};

const docs: YDoc[] = [];
let sequence = 0;
let stop: (() => void) | undefined;

function button(label: string, action: () => void | Promise<void>) {
  const element = document.createElement('button');

  element.textContent = label;
  element.onclick = () => {
    void action();
  };

  root.querySelector('#actions')!.append(element);
}

function database(id: string, specs: FieldSpec[] = []) {
  const doc = new Y.Doc({ guid: id }) as YDoc;
  const db = new Y.Map() as YDatabase;
  const fields = createFields(specs);
  const views = new Y.Map() as YDatabaseViews;
  const view = new Y.Map() as YDatabaseView;

  doc.getMap(E.data_section).set(E.database, db);
  db.set(K.id, id);
  db.set(K.fields, fields.clone());
  db.set(K.views, views);
  views.set('inline', view);
  view.set(K.id, 'inline');
  view.set(K.is_inline, true);
  view.set(K.row_orders, new Y.Array());
  fields.doc?.destroy();
  docs.push(doc);
  return { doc, db, fields: db.get(K.fields), view };
}

function field(id: string, type: F, expression = ''): YDatabaseField {
  const fields = createFields([
    {
      id,
      name: id,
      type,
      typeOption: {
        expression,
        format: 0,
        content: JSON.stringify({
          options: [
            { id: 'done', name: 'Done', color: 0 },
            { id: 'progress', name: 'In progress', color: 1 },
          ],
        }),
      },
    },
  ]);
  const value = fields.get(id).clone() as YDatabaseField;

  fields.doc?.destroy();
  return value;
}

function option(field: YDatabaseField, type: F): Y.Map<unknown> {
  return field.get(K.type_option).get(String(type)) as unknown as Y.Map<unknown>;
}

function row(id: string, databaseId: string, values: Record<string, [F, unknown]>) {
  const cells: Record<string, CellSpec> = {};

  for (const [id, [type, data]] of Object.entries(values))
    cells[id] = { type, data: Array.isArray(data) ? { yArray: data.map(String) } : String(data) };
  const value = createRow(id, cells);

  value.row.set(K.database_id, databaseId);
  docs.push(value.doc);
  return value;
}

function setCell(row: YDatabaseRow, id: string, type: F, data: string | string[]) {
  const cells = row.get(K.cells);
  const cell = cells.get(id) ?? (new Y.Map() as YDatabaseCell);

  if (!cells.has(id)) cells.set(id, cell);
  cell.set(K.field_type, type);
  cell.set(K.data, Array.isArray(data) ? Y.Array.from(data) : data);
}

function membership(db: ReturnType<typeof database>, rows: Array<{ row: YDatabaseRow }>) {
  db.view.set(K.row_orders, Y.Array.from(rows.map(({ row }) => ({ id: row.get(K.id), height: 44 }))));
}

function fixture(type: F, expression: string, inputs: readonly unknown[], calculation: C, showAs = D.Calculated) {
  const suffix = ++sequence;
  const base = database(`rollup-base-${suffix}`);
  const target = database(`rollup-target-${suffix}`);

  target.fields.set('source', field('source', type));
  target.fields.set('formula', field('formula', F.Formula, expression));
  base.fields.set('relation', createRelationField('relation', { database_id: target.doc.guid }));
  const rollup = createRollupField('rollup');

  base.fields.set('rollup', rollup);
  const settings = option(rollup, F.Rollup);

  settings.set(K.relation_field_id, 'relation');
  settings.set(K.target_field_id, 'formula');
  settings.set(K.calculation_type, calculation);
  settings.set(K.show_as, showAs);
  const targetRows = inputs.map((value, index) =>
    row(`target-${suffix}-${index}`, target.doc.guid, value === undefined ? {} : { source: [type, value] })
  );
  const owner = row(`owner-${suffix}`, base.doc.guid, {
    relation: [F.Relation, targetRows.map(({ row }) => row.get(K.id))],
  });
  const databases = new Map([
    [base.doc.guid, base.doc],
    [target.doc.guid, target.doc],
  ]);
  const rows = new Map([
    ...targetRows.map(({ doc, row }) => [getRowKey(target.doc.guid, row.get(K.id)), doc] as const),
    [getRowKey(base.doc.guid, owner.row.get(K.id)), owner.doc],
  ]);

  membership(target, targetRows);
  membership(base, [owner]);
  const context = {
    baseDoc: base.doc,
    database: base.db,
    rollupField: rollup,
    row: owner.row,
    rowId: owner.row.get(K.id),
    fieldId: 'rollup',
    getViewIdFromDatabaseId: async (id: string) => id,
    loadView: async (id: string) => databases.get(id) ?? null,
    createRow: async (id: string) => {
      const doc = rows.get(id);

      if (!doc) throw new Error(`Missing authored row ${id}`);
      return doc;
    },
  };

  return { base, target, targetRows, owner, settings, context, databases, rows };
}

type Fixture = ReturnType<typeof fixture>;

function result(f: Fixture, id: string, value: RollupCellValue): Result {
  const state = getNativeFormulaPropertyState(f.target.fields.get('formula'));
  const nativeType =
    state && 'Formula' in state && state.Formula.status !== 'NotReady'
      ? state.Formula.status.Ready.output_type
      : undefined;
  const { value: display, error, rawNumeric, rawDate, filterCells, list, targetFieldType } = value;

  return {
    id,
    expression: String(option(f.target.fields.get('formula'), F.Formula).get(K.expression)),
    nativeType,
    result: { value: display, error, rawNumeric, rawDate, filterCells, list, targetFieldType },
  };
}

async function capture(f: Fixture, id: string) {
  report.results.push(result(f, id, await evaluateRollupCell(f.context)));
}

async function matrix() {
  const range = 'dateRange(parseDate(prop("source")), dateAdd(parseDate(prop("source")), 5, "days"))';
  const timed = ['2026-09-24T18:45:00', '2026-09-26T09:15:00'];
  const cases: Array<[string, F, string, unknown[], C, D?]> = [
    ['number-sum', F.Number, 'prop("source") * 2', ['2', '5'], C.Sum],
    ['number-average', F.Number, 'prop("source") * 2', ['2', '5'], C.Average],
    ['boolean-checked', F.SingleSelect, 'prop("source") == "Done"', ['done', 'progress', undefined], C.CountChecked],
    [
      'boolean-percent',
      F.MultiSelect,
      'includes(prop("source"), "Done")',
      ['done,progress', 'progress', undefined, 'done'],
      C.PercentChecked,
    ],
    ['boolean-unchecked', F.Checkbox, 'prop("source")', ['Yes', 'No', 'No'], C.CountUnchecked],
    ['text-unique', F.RichText, 'upper(prop("source"))', ['a', 'A', 'b'], C.CountUnique],
    ['division-infinity', F.RichText, '1 / 0', ['x', 'y'], C.CountEmpty],
    ['blank-formula', F.RichText, '', ['x', 'y'], C.CountNonEmpty],
    ['percent-display', F.Number, 'prop("source")', ['0.25', '0.5'], C.Sum],
    [
      'date-original-list',
      F.RichText,
      'dateRange(parseDate("2026-09-24T18:00:00Z"), parseDate("2026-09-26T09:00:00Z"))',
      ['x'],
      C.Count,
      D.OriginalList,
    ],
    ['date-earliest', F.RichText, 'parseDate(prop("source"))', ['2026-09-26', '2026-09-24'], C.DateEarliest],
    ['range-earliest', F.RichText, range, timed, C.DateEarliest],
    ['range-latest', F.RichText, range, timed, C.DateLatest],
    ['range-span', F.RichText, range, timed, C.DateRange],
    ['list-formula', F.MultiSelect, 'prop("source")', ['done,progress', 'progress'], C.Count, D.OriginalList],
    ['formula-chain', F.Number, 'prop("other") + 1', ['3', '8'], C.Sum],
    ['invalid-regex', F.RichText, 'match("text", "[")', ['x', 'y'], C.CountEmpty],
  ];

  for (const [id, type, expression, inputs, calculation, showAs] of cases) {
    const f = fixture(type, expression, inputs, calculation, showAs);

    if (id === 'percent-display') option(f.target.fields.get('formula'), F.Formula).set(K.format, 1);
    if (id === 'formula-chain') f.target.fields.set('other', field('other', F.Formula, 'prop("source") * 2'));
    await capture(f, id);
  }

  for (const [name, type] of [
    ['single', F.SingleSelect],
    ['multi', F.MultiSelect],
  ] as const) {
    const f = fixture(type, '', ['done,progress', 'done', 'progress', undefined], C.CountValue);

    f.settings.set(K.target_field_id, 'source');
    f.settings.set(K.condition_value, '["done","progress"]');
    await capture(f, `${name}-count`);
    f.settings.set(K.calculation_type, C.PercentValue);
    await capture(f, `${name}-any`);
    f.settings.set(K.condition_value, 'done');
    await capture(f, `${name}-done`);
    f.settings.set(K.condition_value, 'deleted-option');
    await capture(f, `${name}-deleted`);
  }

  const empty = fixture(F.MultiSelect, '', [], C.PercentValue);

  empty.settings.set(K.target_field_id, 'source');
  empty.settings.set(K.condition_value, 'done');
  await capture(empty, 'empty-relation');
  const unconfigured = fixture(F.MultiSelect, '', ['done'], C.PercentValue);

  unconfigured.settings.set(K.target_field_id, 'source');
  await capture(unconfigured, 'unconfigured-condition');
  for (const raw of ['', 'done', '["done","progress","done"]', '["done",1]', '[malformed']) {
    const decoded = readRollupCondition(raw);

    report.wire.push({ raw, decoded, roundTrip: readRollupCondition(writeRollupCondition(decoded)) });
  }
}

function watch(f: Fixture, context = f.context) {
  const refresh = async () => {
    const snapshot = result(f, String(report.snapshots.length), await readRollupCell(context));

    report.snapshots.push(snapshot);
    text('rollup-value', snapshot.result.error ? `Error: ${snapshot.result.error}` : snapshot.result.value);
    text(
      'rollup-native-type',
      typeof snapshot.nativeType === 'string' ? snapshot.nativeType : JSON.stringify(snapshot.nativeType)
    );
    root.querySelector('#evidence')!.textContent = JSON.stringify(snapshot, null, 2);
  };

  stop = observeRollupCell(context, () => {
    report.notifications += 1;
    text('rollup-notifications', String(report.notifications));
    void refresh().catch((error) => {
      report.failure = String(error);
    });
  });
  button('Stop observer', () => {
    stop?.();
    text('rollup-phase', 'disposed');
  });
}

function links(f: Fixture, indexes: number[]) {
  setCell(
    f.owner.row,
    'relation',
    F.Relation,
    indexes.map((index) => f.targetRows[index].row.get(K.id))
  );
}

function tasks(hours: string[], stages: string[], priorities: string[]) {
  const f = fixture(F.Number, 'if(prop("stage") == "Done", prop("source"), 0)', hours, C.Sum);

  f.target.fields.set('stage', field('stage', F.SingleSelect));
  f.target.fields.set('priority', field('priority', F.SingleSelect));
  option(f.target.fields.get('priority'), F.SingleSelect).set(
    'content',
    JSON.stringify({
      options: [
        { id: 'High', name: 'High', color: 0 },
        { id: 'Low', name: 'Low', color: 1 },
      ],
    })
  );
  f.targetRows.forEach(({ row }, index) => {
    setCell(row, 'stage', F.SingleSelect, stages[index]);
    setCell(row, 'priority', F.SingleSelect, priorities[index]);
  });
  return f;
}

function project(completion: boolean) {
  const f = completion
    ? tasks(['8', '20', '6', '0', '100'], ['done', 'done', 'progress', '', 'done'], ['High', 'Low', 'High', '', 'High'])
    : tasks(['8', '16', '100'], ['done', 'progress', 'done'], ['High', 'Low', 'High']);
  const formula = option(f.target.fields.get('formula'), F.Formula);

  links(f, completion ? [0, 1, 2] : [0, 1]);
  if (completion) {
    button('Count completed tasks', () => {
      formula.set(K.expression, 'if(prop("stage") == "Done", 1, 0)');
    });
    button('Count unfinished high priority', () => {
      formula.set(K.expression, 'if(prop("priority") == "High" and prop("stage") != "Done", 1, 0)');
    });
    button('Use completion percentage', () => {
      formula.set(K.expression, 'prop("stage") == "Done"');
      f.settings.set(K.calculation_type, C.PercentChecked);
    });
    button('Add blank task', () => links(f, [0, 1, 2, 3]));
    button('Only unfinished task', () => links(f, [2]));
    button('Only blank task', () => links(f, [3]));
    button('Unlink completion', () => links(f, []));
    button('Restore completion links', () => links(f, [0, 1, 2]));
  } else {
    button('Edit hours', () => setCell(f.targetRows[0].row, 'source', F.Number, '12'));
    button('Complete second task', () => setCell(f.targetRows[1].row, 'stage', F.SingleSelect, 'done'));
    button('Double completed hours', () => {
      formula.set(K.expression, 'if(prop("stage") == "Done", prop("source") * 2, 0)');
    });
    button('Only second task', () => links(f, [1]));
    button('Restore effort links', () => links(f, [0, 1]));
    button('Zero first task', () => setCell(f.targetRows[0].row, 'source', F.Number, '0'));
    button('Unlink effort', () => links(f, []));
  }

  watch(f);
}

function expenses() {
  const f = fixture(F.Number, 'prop("source") * prop("quantity")', ['250', '80', '300', '9999'], C.Sum);

  f.target.fields.set('quantity', field('quantity', F.Number));
  f.targetRows.forEach(({ row }, index) => setCell(row, 'quantity', F.Number, ['4', '10', '1', '100'][index]));
  links(f, [0, 1, 2]);
  button('Double third quantity', () => setCell(f.targetRows[2].row, 'quantity', F.Number, '2'));
  watch(f);
}

function nested() {
  const f = fixture(F.Number, 'prop("nested") * 2', ['1', '2'], C.Sum);
  const child = database(`rollup-child-${sequence}`);
  const childRow = row(`child-row-${sequence}`, child.doc.guid, { amount: [F.Number, '3'] });

  child.fields.set('amount', field('amount', F.Number));
  membership(child, [childRow]);
  f.databases.set(child.doc.guid, child.doc);
  f.rows.set(getRowKey(child.doc.guid, childRow.row.get(K.id)), childRow.doc);
  f.target.fields.set('nestedRelation', createRelationField('nestedRelation', { database_id: child.doc.guid }));
  const nested = createRollupField('nested');

  f.target.fields.set('nested', nested);
  const settings = option(nested, F.Rollup);

  settings.set(K.relation_field_id, 'nestedRelation');
  settings.set(K.target_field_id, 'amount');
  settings.set(K.calculation_type, C.Sum);
  f.targetRows.forEach(({ row }) => setCell(row, 'nestedRelation', F.Relation, [childRow.row.get(K.id)]));
  return { ...f, child, childRow };
}

function nestedObserver() {
  const f = nested();

  button('Edit child amount', () => setCell(f.childRow.row, 'amount', F.Number, '5'));
  button('Use nested checked percentage', () => {
    option(f.target.fields.get('formula'), F.Formula).set(K.expression, 'prop("nested") > 4');
    f.settings.set(K.calculation_type, C.PercentChecked);
  });
  button('Edit disposed child', async () => {
    setCell(f.childRow.row, 'amount', F.Number, '9');
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    text('rollup-phase', 'disposed edit settled');
  });
  watch(f);
}

function pendingRow() {
  const f = nested();
  let release: ((doc: YDoc) => void) | undefined;
  const context = {
    ...f.context,
    createRow: () => {
      report.rowLoads += 1;
      text('rollup-row-loads', String(report.rowLoads));
      return new Promise<YDoc>((resolve) => {
        release = resolve;
      });
    },
  };

  button('Release pending row', () => {
    release?.(f.targetRows[0].doc);
  });
  watch(f, context);
}

function retry(failure: string) {
  const f = fixture(F.Number, 'prop("source") * 2', ['3'], C.Sum);
  let first = true;
  const context = {
    ...f.context,
    loadView: async (id: string) => {
      report.metadataLoads += 1;
      if (first) {
        first = false;
        if (failure === 'rejected') throw new Error('Transient source error');
        return null;
      }

      return f.context.loadView(id);
    },
    getViewIdFromDatabaseId: async (id: string) => {
      if (first && failure === 'unresolved') {
        first = false;
        return null;
      }

      return id;
    },
  };

  button('Edit recovered source', () => setCell(f.targetRows[0].row, 'source', F.Number, '4'));
  watch(f, context as typeof f.context);
}

async function materialization() {
  for (const missing of ['missing-database', 'title-property', 'row-payload']) {
    const f = fixture(F.Number, 'join(prop("names"), ", ")', ['1'], C.Count);
    let titleId = 'missing-database';

    if (missing !== 'missing-database') {
      const titles = database(`title-db-${sequence}`);

      titleId = titles.doc.guid;
      titles.view.set(K.row_orders, Y.Array.from([{ id: 'title-row', height: 44 }]));
      const empty = new Y.Doc() as YDoc;

      docs.push(empty);
      f.databases.set(titleId, titles.doc);
      f.rows.set(getRowKey(titleId, 'title-row'), empty);
      if (missing === 'row-payload') {
        const title = field('title', F.RichText);

        title.set(K.is_primary, true);
        titles.fields.set('title', title);
      }
    }

    f.target.fields.set('names', createRelationField('names', { database_id: titleId }));
    setCell(f.targetRows[0].row, 'names', F.Relation, ['title-row']);
    try {
      report.results.push(result(f, missing, await evaluateRollupCell({ ...f.context, requireLoadedSources: true })));
    } catch (error) {
      report.results.push(result(f, missing, { value: '', error: String(error) }));
    }
  }
}

async function depth(hops: number) {
  const f = fixture(F.Number, '1', ['1'], C.Sum);
  let currentDatabase = f.target;
  let currentRow = f.targetRows[0];

  for (let hop = 1; hop < hops; hop++) {
    const child = database(`depth-${sequence}-${hop}`);
    const childRow = row(`depth-row-${sequence}-${hop}`, child.doc.guid, {});

    child.fields.set('formula', field('formula', F.Formula, '1'));
    membership(child, [childRow]);
    f.databases.set(child.doc.guid, child.doc);
    f.rows.set(getRowKey(child.doc.guid, childRow.row.get(K.id)), childRow.doc);
    option(currentDatabase.fields.get('formula'), F.Formula).set(K.expression, 'prop("nested")');
    currentDatabase.fields.set('next', createRelationField('next', { database_id: child.doc.guid }));
    const nested = createRollupField('nested');

    currentDatabase.fields.set('nested', nested);
    const settings = option(nested, F.Rollup);

    settings.set(K.relation_field_id, 'next');
    settings.set(K.target_field_id, 'formula');
    settings.set(K.calculation_type, C.Sum);
    setCell(currentRow.row, 'next', F.Relation, [childRow.row.get(K.id)]);
    currentDatabase = child;
    currentRow = childRow;
  }

  await capture(f, String(hops));
}

async function run() {
  try {
    if (mode === 'matrix') await matrix();
    else if (mode === 'effort' || mode === 'completion') project(mode === 'completion');
    else if (mode === 'expenses') expenses();
    else if (mode === 'nested') nestedObserver();
    else if (mode === 'pending') pendingRow();
    else if (['rejected', 'missing', 'unresolved'].includes(mode)) retry(mode);
    else if (mode === 'materialization') await materialization();
    else await depth(Number(mode.split('-')[1]));
  } catch (error) {
    report.failure = String(error);
  }

  text('rollup-ready', 'ready');
  if (report.results.length) root.querySelector('#evidence')!.textContent = JSON.stringify(report.results, null, 2);
}

window.addEventListener('beforeunload', () => {
  stop?.();
  docs.forEach((doc) => doc.destroy());
});
void run();
