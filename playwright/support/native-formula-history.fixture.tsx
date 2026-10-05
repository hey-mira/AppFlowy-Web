import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import type {
  FormulaCell as FormulaCellValue,
  RollupCell as RollupCellValue,
} from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { CalculationType, FieldType, FilterType, SortCondition } from '@/application/database-yjs/database.type';
import { TextFilterCondition } from '@/application/database-yjs/fields';
import { markDatabaseHistoryDocumentImmutable } from '@/application/database-yjs/immutable';
import { useCellSelector, useFieldCellsByRowsSelector, useRowOrdersSelector } from '@/application/database-yjs/selector';
import { db } from '@/application/db';
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
import { loadMentionableUsers } from '@/components/database/components/cell/person/useMentionableUsers';
import { RollupCell } from '@/components/database/components/cell/rollup/RollupCell';
import '@/i18n/config';

const query = new URLSearchParams(window.location.search);
const consumer = query.get('consumer') ?? 'cell';
const people = query.get('source') === 'people';
const markerOnly = query.get('marker') === '1';
const expression = people
  ? 'prop("person").join(",") + "|" + prop("creator").join(",")'
  : 'format(prop("rollup")) + "|" + prop("relation").join(",")';
const first = people ? 'Saved Zed|User 42' : '9|external-z';
const doc = new Y.Doc({ guid: 'historical-native-database' }) as YDoc;
const database = new Y.Map() as YDatabase;
const fields = new Y.Map() as YDatabaseFields;
const view = new Y.Map() as YDatabaseView;
const views = new Y.Map() as YDatabaseViews;
const rows: Record<string, YDoc> = {};
const orders = [
  { id: 'row-z', height: 44 },
  { id: 'row-a', height: 44 },
];
const evidence = { liveLoads: 0, warmedCurrentMembers: false, unchanged: true };

doc.getMap(E.data_section).set(E.database, database);
database.set(K.id, doc.guid);
database.set(K.fields, fields);
database.set(K.views, views);
view.set(K.id, 'saved-view');
view.set(K.row_orders, Y.Array.from(orders));
view.set(K.filters, new Y.Array());
view.set(K.sorts, new Y.Array());
views.set('saved-view', view);

function field(id: string, name: string, type: FieldType, values?: Record<string, unknown>) {
  const value = new Y.Map() as YDatabaseField;

  value.set(K.id, id);
  value.set(K.name, name);
  value.set(K.type, type);
  if (values) {
    const options = new Y.Map();
    const option = new Y.Map();

    Object.entries(values).forEach(([key, content]) => option.set(key, content));
    options.set(String(type), option);
    value.set(K.type_option, options);
  }

  fields.set(id, value);
}

field('formula', 'Formula', FieldType.Formula, { expression });
field('creator', 'Creator', FieldType.CreatedBy);
field('person', 'Owner', FieldType.Person, {
  persons: JSON.stringify([
    { id: 'person-z', name: 'Saved Zed' },
    { id: 'person-a', name: 'Saved Ada' },
  ]),
});
field('relation', 'Related', FieldType.Relation, { database_id: 'external-database' });
field('rollup', 'Rollup', FieldType.Rollup, {
  relation_field_id: 'relation',
  target_field_id: 'amount',
  calculation_type: CalculationType.Sum,
  show_as: 0,
});

for (const [index, { id }] of orders.entries()) {
  const suffix = index === 0 ? 'z' : 'a';
  const rowDoc = new Y.Doc() as YDoc;
  const row = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;

  rowDoc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, id);
  row.set(K.created_by, index === 0 ? '42' : '43');
  row.set(K.cells, cells);
  for (const [fieldId, type, data] of [
    ['person', FieldType.Person, JSON.stringify([`person-${suffix}`])],
    ['relation', FieldType.Relation, Y.Array.from([`external-${suffix}`])],
    ['rollup', FieldType.Rollup, index === 0 ? 9 : 2],
  ] as const) {
    const cell = new Y.Map() as YDatabaseCell;

    cell.set(K.field_type, type);
    cell.set(K.data, data);
    cells.set(fieldId, cell);
  }

  rows[id] = rowDoc;
  markDatabaseHistoryDocumentImmutable(rowDoc);
}

if (consumer === 'filter') {
  const filter = new Y.Map() as YDatabaseFilter;

  filter.set(K.id, 'formula-filter');
  filter.set(K.field_id, 'formula');
  filter.set(K.filter_type, FilterType.Data);
  filter.set(K.condition, TextFilterCondition.TextIs);
  filter.set(K.content, first);
  filter.set(K.type, FieldType.Formula);
  view.get(K.filters).push([filter]);
}

if (consumer === 'sort') {
  const sort = new Y.Map() as YDatabaseSort;

  sort.set(K.id, 'formula-sort');
  sort.set(K.field_id, 'formula');
  sort.set(K.condition, SortCondition.Ascending);
  view.get(K.sorts).push([sort]);
}

markDatabaseHistoryDocumentImmutable(doc);
const documents = [doc, ...Object.values(rows)];
const before = documents.map((document) => Array.from(Y.encodeStateAsUpdate(document)));
const context: DatabaseContextState = {
  databaseDoc: doc,
  databasePageId: 'saved-view',
  activeViewId: 'saved-view',
  dataSource: markerOnly ? undefined : { type: 'history', id: 'history-formulas' },
  readOnly: true,
  workspaceId: 'historical-workspace',
  rowMap: rows,
  blobPrefetchComplete: true,
  seedsReady: true,
  getViewIdFromDatabaseId: async () => {
    evidence.liveLoads += 1;
    return 'live-view';
  },
  loadView: async () => {
    evidence.liveLoads += 1;
    throw new Error('A historical formula opened current data');
  },
  createRow: async () => {
    evidence.liveLoads += 1;
    throw new Error('A historical formula opened a current row');
  },
};

function CellConsumer() {
  const cell = useCellSelector({ rowId: 'row-z', fieldId: 'formula' }) as FormulaCellValue | undefined;
  const rollup = useCellSelector({ rowId: 'row-z', fieldId: 'rollup' }) as RollupCellValue | undefined;

  return (
    <>
      <FormulaCell cell={cell} rowId='row-z' fieldId='formula' readOnly wrap />
      <RollupCell cell={rollup} rowId='row-z' fieldId='rollup' readOnly wrap />
    </>
  );
}

function FooterConsumer() {
  const { cells, ready } = useFieldCellsByRowsSelector('formula', orders);

  return (
    <output data-testid='history-footer' data-ready={String(ready)}>
      {orders.map(({ id }) => String(cells?.get(id) ?? '')).join(';')}
    </output>
  );
}

function ViewConsumer() {
  const rowOrders = useRowOrdersSelector();

  return <output data-testid='history-orders'>{rowOrders?.map(({ id }) => id).join(',')}</output>;
}

Object.assign(window, {
  formulaHistoryEvidence: evidence,
  verifyFormulaHistory: () => {
    evidence.unchanged =
      JSON.stringify(documents.map((document) => Array.from(Y.encodeStateAsUpdate(document)))) ===
      JSON.stringify(before);
    return evidence;
  },
});

async function render() {
  await db.workspace_member_profiles.bulkPut([
    {
      workspace_id: 'historical-workspace',
      user_uuid: 'person-z',
      person_id: 'person-z',
      uid: '42',
      name: 'Current Alice',
      updated_at: Date.now(),
      avatar_url: null,
      cover_image_url: null,
      custom_image_url: null,
      description: null,
      email: '',
      role: 1,
      invited: false,
      last_mentioned_at: null,
    },
    {
      workspace_id: 'historical-workspace',
      user_uuid: 'person-a',
      person_id: 'person-a',
      uid: '43',
      name: 'Current Zoe',
      updated_at: Date.now(),
      avatar_url: null,
      cover_image_url: null,
      custom_image_url: null,
      description: null,
      email: '',
      role: 1,
      invited: false,
      last_mentioned_at: null,
    },
  ]);
  evidence.warmedCurrentMembers = (await loadMentionableUsers('historical-workspace')).length === 2;
  createRoot(document.getElementById('root')!).render(
    <DatabaseContext.Provider value={context}>
      <h1>Historical formula consumers</h1>
      {consumer === 'cell' ? <CellConsumer /> : consumer === 'footer' ? <FooterConsumer /> : <ViewConsumer />}
    </DatabaseContext.Provider>
  );
}

void render();
