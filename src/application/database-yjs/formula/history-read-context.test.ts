import * as Y from 'yjs';

import { CalculationType, FieldType } from '@/application/database-yjs/database.type';
import { createFields, createRow } from '@/application/database-yjs/fields/formula/__tests__/fixture';
import { markDatabaseHistoryDocumentImmutable } from '@/application/database-yjs/immutable';
import { YDatabase, YDatabaseFields, YDoc, YjsDatabaseKey, YjsEditorKey } from '@/application/types';

import { historicalFormulaRowContext } from './read-context';

function fixture() {
  const databaseDoc = new Y.Doc() as YDoc;
  const database = new Y.Map() as YDatabase;
  const fields = createFields([
    { id: 'title', name: 'Title', type: FieldType.RichText },
    { id: 'relation', name: 'Relation', type: FieldType.Relation, typeOption: { database_id: 'database' } },
    { id: 'external', name: 'External', type: FieldType.Relation, typeOption: { database_id: 'other-database' } },
    {
      id: 'rollup',
      name: 'Total',
      type: FieldType.Rollup,
      typeOption: { relation_field_id: 'relation', target_field_id: 'number', calculation_type: CalculationType.Sum },
    },
  ]).clone() as YDatabaseFields;
  const { row, doc } = createRow('row', {
    relation: { type: FieldType.Relation, data: { yArray: ['related'] } },
    rollup: { type: FieldType.Rollup, data: '', extra: { data: 17 } },
  });
  const related = createRow('related', { title: { type: FieldType.RichText, data: 'Saved title' } });

  databaseDoc.getMap(YjsEditorKey.data_section).set(YjsEditorKey.database, database);
  database.set(YjsDatabaseKey.id, 'database');
  database.set(YjsDatabaseKey.fields, fields);
  fields.get('title').set(YjsDatabaseKey.is_primary, true);
  const rows = { row: doc, related: related.doc };

  [databaseDoc, ...Object.values(rows)].forEach(markDatabaseHistoryDocumentImmutable);
  return { databaseDoc, database, fields, row, rows };
}

afterEach(() => jest.restoreAllMocks());

it('reads snapshot relation titles and stored rollups without current member names', () => {
  const f = fixture();
  const context = historicalFormulaRowContext('row', f.row, {
    database: f.database,
    baseDoc: f.databaseDoc,
    rows: f.rows,
  });

  expect(context.getUserName).toBeUndefined();
  expect(context.getPersonName).toBeUndefined();
  expect(context.getRelatedRowTitle?.(f.fields.get('relation'), 'related')).toBe('Saved title');
  expect(context.getRelatedRowTitle?.(f.fields.get('relation'), 'missing')).toBe('missing');
  expect(context.getRelatedRowTitle?.(f.fields.get('external'), 'related')).toBe('related');
  expect(context.getRollupValue?.('rollup')).toEqual({ value: '17', rawNumeric: 17 });
});
