import { renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import * as Y from 'yjs';

import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import { FieldType, FilterType } from '@/application/database-yjs/database.type';
import { DateFilterCondition } from '@/application/database-yjs/fields';
import { createFields } from '@/application/database-yjs/fields/formula/__tests__/fixture';
import {
  useAdvancedFilterSelector,
  useAdvancedFiltersSelector,
  useFilterSelector,
} from '@/application/database-yjs/selector';
import {
  YDatabase,
  YDatabaseFields,
  YDatabaseFilter,
  YDatabaseFilters,
  YDatabaseView,
  YDatabaseViews,
  YDoc,
  YjsDatabaseKey,
  YjsEditorKey,
} from '@/application/types';

function fixture() {
  const databaseDoc = new Y.Doc() as YDoc;
  const database = new Y.Map() as YDatabase;
  const fields = createFields([{ id: 'due', name: 'Due', type: FieldType.DateTime }]).clone() as YDatabaseFields;
  const view = new Y.Map() as YDatabaseView;
  const views = new Y.Map() as YDatabaseViews;
  const filters = new Y.Array() as YDatabaseFilters;

  databaseDoc.getMap(YjsEditorKey.data_section).set(YjsEditorKey.database, database);
  database.set(YjsDatabaseKey.fields, fields);
  database.set(YjsDatabaseKey.views, views);
  view.set(YjsDatabaseKey.id, 'view');
  view.set(YjsDatabaseKey.filters, filters);
  views.set('view', view);
  const context: DatabaseContextState = {
    databaseDoc,
    databasePageId: 'view',
    activeViewId: 'view',
    rowMap: {},
    readOnly: false,
    workspaceId: 'workspace',
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DatabaseContext.Provider value={context}>{children}</DatabaseContext.Provider>
  );

  return { filters, wrapper };
}

// Retained from formula-regressions: stored selection decoding belongs to the
// host. Native formula metadata arriving later is covered in Chrome conditions.
describe('saved date filter selectors', () => {
  it.each([
    [DateFilterCondition.DateStartsOn, { timestamp: 1700000000 }],
    [DateFilterCondition.DateStartsBetween, { start: 1700000000, end: 1700086400 }],
  ])('preserves saved date selections for condition %s', (condition, selection) => {
    const f = fixture();
    const filter = new Y.Map() as YDatabaseFilter;

    filter.set(YjsDatabaseKey.id, 'filter');
    filter.set(YjsDatabaseKey.field_id, 'due');
    filter.set(YjsDatabaseKey.filter_type, FilterType.Data);
    filter.set(YjsDatabaseKey.condition, condition);
    filter.set(YjsDatabaseKey.content, JSON.stringify(selection));
    filter.set(YjsDatabaseKey.type, FieldType.DateTime);
    f.filters.push([filter]);
    const simple = renderHook(() => useFilterSelector('filter'), { wrapper: f.wrapper });

    expect(simple.result.current).toMatchObject(selection);
    simple.unmount();
    const root = new Y.Map() as YDatabaseFilter;

    root.set(YjsDatabaseKey.id, 'root');
    root.set(YjsDatabaseKey.filter_type, FilterType.And);
    root.set(YjsDatabaseKey.children, Y.Array.from([filter.clone()]));
    f.filters.delete(0, 1);
    f.filters.push([root]);
    const advanced = renderHook(
      () => ({ one: useAdvancedFilterSelector('filter'), all: useAdvancedFiltersSelector() }),
      { wrapper: f.wrapper }
    );

    expect(advanced.result.current.one).toMatchObject(selection);
    expect(advanced.result.current.all[0]).toMatchObject(selection);
  });
});
