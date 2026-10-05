import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';

import type {
  DateTimeCell,
  FormulaCell as FormulaCellValue,
  RollupCell as RollupCellValue,
  SelectOptionCell as SelectOptionCellValue,
} from '@/application/database-yjs/cell.type';
import { DatabaseContext, DatabaseContextState } from '@/application/database-yjs/context';
import {
  CalculationType,
  FieldType,
  FilterType,
  RollupDisplayMode,
  SortCondition,
} from '@/application/database-yjs/database.type';
import { useSwitchPropertyType } from '@/application/database-yjs/dispatch';
import { NumberFormat, NumberFilterCondition } from '@/application/database-yjs/fields/number/number.type';
import { TimelineRowValuesProvider } from '@/application/database-yjs/hooks/TimelineRowValuesProvider';
import { useCellSelector, useFieldSelector, useRowOrdersSelector } from '@/application/database-yjs/selector';
import { db } from '@/application/db';
import {
  DateFormat,
  TimeFormat,
  YDatabase,
  YDatabaseCalculation,
  YDatabaseCalculations,
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
import { MetadataKey } from '@/application/user-metadata';
import { FormulaCell } from '@/components/database/components/cell/formula/FormulaCell';
import { loadMentionableUsers } from '@/components/database/components/cell/person/useMentionableUsers';
import { RollupCell } from '@/components/database/components/cell/rollup/RollupCell';
import { SelectOptionCell } from '@/components/database/components/cell/select-option/SelectOptionCell';
import { GridCalculateRowCell } from '@/components/database/components/grid/grid-cell/GridCalculateRowCell';
import { TimelineCalculation } from '@/components/database/timeline/TimelineCalculation';
import { AFConfigContext } from '@/components/main/app.hooks';
import '@/i18n/config';

const evidence = {
  workers: 0,
  terminated: 0,
  held: false,
  holdNext: false,
  liveLoads: 0,
  requests: [] as unknown[],
  errors: [] as string[],
};
const RealWorker = window.Worker;
let release: (() => void) | undefined;

// Only delivery is delayed; the SDK Worker and Rust/WASM produce every result.
window.Worker = class extends RealWorker {
  private evaluations = new Set<number>();

  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    evidence.workers += 1;
    super.addEventListener('message', (event: MessageEvent<{ id: number }>) => {
      if (!this.evaluations.delete(event.data.id) || !evidence.holdNext) return;
      evidence.holdNext = false;
      evidence.held = true;
      event.stopImmediatePropagation();
      release = () => {
        evidence.held = false;
        this.dispatchEvent(new MessageEvent('message', { data: event.data }));
        release = undefined;
      };
    });
  }

  postMessage(message: { id: number; method: string; args: unknown[] }) {
    evidence.requests.push(message);
    if (message.method === 'engine.evaluate') this.evaluations.add(message.id);
    super.postMessage(message);
  }

  terminate() {
    evidence.terminated += 1;
    super.terminate();
  }
};

const doc = new Y.Doc({ guid: 'consumers-database' }) as YDoc;
const database = new Y.Map() as YDatabase;
const fields = new Y.Map() as YDatabaseFields;

doc.getMap(E.data_section).set(E.database, database);
database.set(K.id, doc.guid);
database.set(K.fields, fields);

function addField(id: string, type: FieldType, expression?: string, targetFields = fields) {
  const field = new Y.Map() as YDatabaseField;

  field.set(K.id, id);
  field.set(K.name, id);
  field.set(K.type, type);
  if (expression !== undefined) {
    const options = new Y.Map();
    const formula = new Y.Map();

    formula.set('expression', expression);
    options.set(String(type), formula);
    field.set(K.type_option, options);
  }

  targetFields.set(id, field);
}

addField('input', FieldType.Number);
addField('formula', FieldType.Formula, 'prop("input") * 2');
addField('period', FieldType.DateTime);
addField('edited', FieldType.LastEditedTime);
addField('linked', FieldType.Relation);
addField('checked', FieldType.Rollup);
addField('rollup_formula', FieldType.Formula, 'prop("checked") + 10');

function setTypeOptions(id: string, type: FieldType, values: Record<string, unknown>) {
  const options = new Y.Map();
  const value = new Y.Map();

  Object.entries(values).forEach(([key, content]) => value.set(key, content));
  options.set(String(type), value);
  fields.get(id).set(K.type_option, options);
}

setTypeOptions('linked', FieldType.Relation, { database_id: 'native-related' });
setTypeOptions('checked', FieldType.Rollup, {
  relation_field_id: 'linked',
  target_field_id: 'flag',
  calculation_type: CalculationType.CountChecked,
  show_as: RollupDisplayMode.Calculated,
});
const rows: Record<string, YDoc> = {};

for (const [id, value] of [
  ['alpha', '2'],
  ['beta', '4'],
] as const) {
  const rowDoc = new Y.Doc() as YDoc;
  const row = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;
  const cell = new Y.Map() as YDatabaseCell;

  rowDoc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, id);
  row.set(K.last_modified, '2');
  row.set(K.cells, cells);
  cell.set(K.field_type, FieldType.Number);
  cell.set(K.data, value);
  cells.set('input', cell);
  rows[id] = rowDoc;
}

const linkedCell = new Y.Map() as YDatabaseCell;

linkedCell.set(K.field_type, FieldType.Relation);
linkedCell.set(K.data, Y.Array.from(['child-one', 'child-two']));
(rows.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow).get(K.cells).set('linked', linkedCell);
const relatedDoc = new Y.Doc({ guid: 'native-related' }) as YDoc;
const relatedDatabase = new Y.Map() as YDatabase;
const relatedFields = new Y.Map() as YDatabaseFields;
const relatedRows: Record<string, YDoc> = {};

relatedDoc.getMap(E.data_section).set(E.database, relatedDatabase);
relatedDatabase.set(K.id, relatedDoc.guid);
relatedDatabase.set(K.fields, relatedFields);
addField('amount', FieldType.Number, undefined, relatedFields);
addField('empty', FieldType.Number, undefined, relatedFields);
addField('flag', FieldType.Formula, 'prop("amount") > 3', relatedFields);
addField('owner', FieldType.Person, undefined, relatedFields);
addField('creator', FieldType.CreatedBy, undefined, relatedFields);
addField('editor', FieldType.LastEditedBy, undefined, relatedFields);
addField('title', FieldType.RichText, undefined, relatedFields);
relatedFields.get('title').set(K.is_primary, true);
for (const [id, value] of [
  ['child-one', '2'],
  ['child-two', '4'],
] as const) {
  const rowDoc = new Y.Doc() as YDoc;
  const row = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;
  const cell = new Y.Map() as YDatabaseCell;

  rowDoc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, id);
  row.set(K.cells, cells);
  row.set(K.created_by, '9007199254740993');
  row.set(K.last_edited_by, '9007199254740993');
  cell.set(K.field_type, FieldType.Number);
  cell.set(K.data, value);
  cells.set('amount', cell);
  const owner = new Y.Map() as YDatabaseCell;

  owner.set(K.field_type, FieldType.Person);
  owner.set(K.data, '["person-ada"]');
  cells.set('owner', owner);
  const title = new Y.Map() as YDatabaseCell;

  title.set(K.field_type, FieldType.RichText);
  title.set(K.data, `Title ${id}`);
  cells.set('title', title);
  relatedRows[id] = rowDoc;
}

const relatedView = new Y.Map() as YDatabaseView;
const relatedViews = new Y.Map() as YDatabaseViews;

relatedView.set(K.id, relatedDoc.guid);
relatedView.set(K.row_orders, Y.Array.from(Object.keys(relatedRows).map((id) => ({ id, height: 44 }))));
relatedViews.set(relatedDoc.guid, relatedView);
relatedDatabase.set(K.views, relatedViews);

const orders = Object.keys(rows).map((id) => ({ id, height: 44 }));
const view = new Y.Map() as YDatabaseView;
const views = new Y.Map() as YDatabaseViews;
const calculations = new Y.Array() as YDatabaseCalculations;
const calculation = new Y.Map() as YDatabaseCalculation;

calculation.set(K.id, 'sum');
calculation.set(K.field_id, 'formula');
calculation.set(K.type, CalculationType.Sum);
calculation.set(K.calculation_value, '99');
calculations.push([calculation]);
view.set(K.id, 'view');
view.set(K.row_orders, Y.Array.from(orders));
view.set(K.calculations, calculations);
view.set(K.sorts, new Y.Array());
view.set(K.filters, new Y.Array());
views.set('view', view);
database.set(K.views, views);

const context: DatabaseContextState = {
  databaseDoc: doc,
  databasePageId: 'view',
  activeViewId: 'view',
  readOnly: false,
  workspaceId: 'workspace',
  rowMap: { alpha: rows.alpha },
  seedsReady: true,
  peekRowDocFromSeed: (id) => rows[id] ?? null,
  loadRowFromSeed: async (id) => rows[id],
  ensureRow: async (id) => rows[id],
  getViewIdFromDatabaseId: async (id) => id,
  loadView: async () => {
    evidence.liveLoads += 1;
    return relatedDoc;
  },
  createRow: async (key) => ({ ...rows, ...relatedRows }[key.split('_rows_').pop()!]),
};

function input(value: string) {
  const row = rows.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow;

  row.get(K.cells).get('input').set(K.data, value);
}

function expression(value: string) {
  fields.get('formula').get(K.type_option).get(String(FieldType.Formula)).set('expression', value);
}

function period(timed = false, unsafeEnd = false) {
  for (const rowDoc of Object.values(rows)) {
    const cell = new Y.Map() as YDatabaseCell;

    cell.set(K.field_type, FieldType.DateTime);
    cell.set(K.data, timed ? '1789344000.123' : '1789344000');
    cell.set(K.end_timestamp, unsafeEnd ? '9007199254740993' : timed ? '1789516800.456' : '1789516800');
    cell.set(K.is_range, true);
    cell.set(K.include_time, timed);
    (rowDoc.getMap(E.data_section).get(E.database_row) as YDatabaseRow).get(K.cells).set('period', cell);
  }

  expression('prop("period")');
}

function special(expressionValue: string, calculationType = CalculationType.Sum) {
  expression(expressionValue);
  relatedFields.get('flag').get(K.type_option).get(String(FieldType.Formula)).set('expression', expressionValue);
  fields.get('checked').get(K.type_option).get(String(FieldType.Rollup)).set('calculation_type', calculationType);
  fields.get('rollup_formula').get(K.type_option).get(String(FieldType.Formula)).set('expression', 'prop("checked")');
  calculation.set(K.type, calculationType);
}

function dynamicAverage(mixed: boolean) {
  expression(
    mixed ? 'if(prop("input") == 2, "wrong", prop("input"))' : 'if(empty(prop("input")), empty(), prop("input"))'
  );
  relatedFields
    .get('flag')
    .get(K.type_option)
    .get(String(FieldType.Formula))
    .set(
      'expression',
      mixed ? 'if(prop("amount") == 2, "wrong", prop("amount"))' : 'if(empty(prop("amount")), empty(), prop("amount"))'
    );
  fields
    .get('checked')
    .get(K.type_option)
    .get(String(FieldType.Rollup))
    .set('calculation_type', CalculationType.Average);
  fields.get('rollup_formula').get(K.type_option).get(String(FieldType.Formula)).set('expression', 'prop("checked")');
  calculation.set(K.type, CalculationType.Average);
}

function averageInput(value: string) {
  input(value);
  (relatedRows['child-one'].getMap(E.data_section).get(E.database_row) as YDatabaseRow)
    .get(K.cells)
    .get('amount')
    .set(K.data, value);
}

async function memberNames(name: string) {
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

async function memberRollup(target: string, computed: boolean, unique: boolean) {
  await memberNames('Ada');
  await loadMentionableUsers('workspace');
  relatedFields
    .get('flag')
    .get(K.type_option)
    .get(String(FieldType.Formula))
    .set('expression', `prop("${target}").join(",")`);
  const rollup = fields.get('checked').get(K.type_option).get(String(FieldType.Rollup));

  rollup.set('target_field_id', computed ? 'flag' : target);
  rollup.set('show_as', unique ? RollupDisplayMode.UniqueList : RollupDisplayMode.OriginalList);
  expression('prop("checked").join(",")');
}

const fullContext = { ...context, rowMap: rows };

function selectOptions(target: FieldType) {
  const option = new Y.Map();

  option.set(
    K.content,
    JSON.stringify({
      disable_color: true,
      options: [
        { id: 'existing-option', name: 'Existing', color: 'Purple' },
        { id: 'unused-option', name: 'Unused', color: 'Blue' },
      ],
    })
  );
  fields.get('formula').get(K.type_option).set(String(target), option);
  const rowDoc = new Y.Doc() as YDoc;
  const row = new Y.Map() as YDatabaseRow;
  const cells = new Y.Map() as YDatabaseCells;
  const cell = new Y.Map() as YDatabaseCell;

  rowDoc.getMap(E.data_section).set(E.database_row, row);
  row.set(K.id, 'gamma');
  row.set(K.cells, cells);
  cell.set(K.field_type, FieldType.Number);
  cell.set(K.data, '0');
  cells.set('input', cell);
  rows.gamma = rowDoc;
  view.get(K.row_orders).push([{ id: 'gamma', height: 44 }]);
  expression('if(prop("input") > 0, "Existing, New, New", "")');
}

function relationTitles() {
  const ids = Array.from({ length: 501 }, (_, index) => `title-${index}`);

  for (const id of ids) {
    const rowDoc = new Y.Doc() as YDoc;
    const row = new Y.Map() as YDatabaseRow;
    const cells = new Y.Map() as YDatabaseCells;
    const title = new Y.Map() as YDatabaseCell;

    rowDoc.getMap(E.data_section).set(E.database_row, row);
    row.set(K.id, id);
    row.set(K.cells, cells);
    title.set(K.field_type, FieldType.RichText);
    title.set(K.data, 'Related title');
    cells.set('title', title);
    relatedRows[id] = rowDoc;
  }

  relatedView.get(K.row_orders).delete(0, relatedView.get(K.row_orders).length);
  relatedView.get(K.row_orders).push(ids.map((id) => ({ id, height: 44 })));
  linkedCell.set(K.data, Y.Array.from(ids));
  expression('prop("linked").filter(current != "").length()');
}

function RelatedConsumers() {
  const checked = useCellSelector({ rowId: 'alpha', fieldId: 'checked' }) as RollupCellValue | undefined;
  const formula = useCellSelector({ rowId: 'alpha', fieldId: 'rollup_formula' }) as FormulaCellValue | undefined;

  return (
    <>
      <RollupCell cell={checked} rowId='alpha' fieldId='checked' readOnly wrap />
      <FormulaCell cell={formula} rowId='alpha' fieldId='rollup_formula' readOnly wrap />
    </>
  );
}

function ConvertedCells() {
  const { field } = useFieldSelector('formula');
  const options = field
    ?.get(K.type_option)
    ?.get(String(field.get(K.type)))
    ?.get(K.content);

  return (
    <>
      <output data-testid='converted-select-options'>{String(options ?? '')}</output>
      {Object.keys(rows).map((id) => (
        <ConvertedRow key={id} id={id} />
      ))}
    </>
  );
}

function ConvertedRow({ id }: { id: string }) {
  const cell = useCellSelector({ rowId: id, fieldId: 'formula' }) as DateTimeCell | undefined;

  return (
    <>
      <output
        data-testid={`converted-${id}`}
        data-range={String(cell?.isRange)}
        data-end={cell?.endTimestamp}
        data-include-time={String(cell?.includeTime)}
        data-negative-zero={String(Object.is(Number(cell?.data), -0))}
      >
        {String(cell?.data ?? '')}
      </output>
      {cell && [FieldType.SingleSelect, FieldType.MultiSelect].includes(cell.fieldType) && (
        <SelectOptionCell cell={cell as unknown as SelectOptionCellValue} rowId={id} fieldId='formula' readOnly wrap />
      )}
    </>
  );
}

function Conditions() {
  const rowOrders = useRowOrdersSelector();

  return <output data-testid='consumer-orders'>{rowOrders?.map(({ id }) => id).join(',')}</output>;
}

function GapEdit() {
  useCellSelector({ rowId: 'alpha', fieldId: 'formula' });
  useLayoutEffect(() => {
    (rows.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow).set(K.last_modified, '15');
  }, []);
  return null;
}

function showConditions(threshold: string, sorted = false) {
  const filter = new Y.Map() as YDatabaseFilter;

  filter.set(K.id, 'member-filter');
  filter.set(K.field_id, 'formula');
  filter.set(K.type, FieldType.Formula);
  filter.set(K.filter_type, FilterType.Data);
  filter.set(K.condition, NumberFilterCondition.GreaterThan);
  filter.set(K.content, threshold);
  view.get(K.filters).push([filter]);
  if (sorted) {
    const sort = new Y.Map() as YDatabaseSort;

    sort.set(K.id, 'member-sort');
    sort.set(K.field_id, 'formula');
    sort.set(K.condition, SortCondition.Ascending);
    view.get(K.sorts).push([sort]);
  }
}

function Consumers() {
  const cell = useCellSelector({ rowId: 'alpha', fieldId: 'formula' }) as FormulaCellValue | undefined;
  const [opened, setOpened] = useState(true);
  const [timeline, setTimeline] = useState(false);
  const [conversion, setConversion] = useState('idle');
  const [related, setRelated] = useState(false);
  const [computedMember, setComputedMember] = useState(false);
  const [uniqueMember, setUniqueMember] = useState(false);
  const [conditions, setConditions] = useState(false);
  const [gapEdit, setGapEdit] = useState(false);
  const [profile, setProfile] = useState('Ada');
  const switchType = useSwitchPropertyType();
  const convert = (hold: boolean, target = FieldType.Number) => {
    evidence.holdNext = hold;
    setConversion('pending');
    void switchType('formula', target).then(
      () => setConversion('converted'),
      (error: Error) => {
        evidence.errors.push(error.message);
        setConversion(`error:${error.message}`);
      }
    );
  };

  return (
    <main>
      <h1>Native formula consumers</h1>
      <button
        onClick={() => {
          evidence.holdNext = true;
          input('7');
        }}
      >
        Hold edited value
      </button>
      <button
        onClick={() => {
          input('11');
          release?.();
        }}
      >
        Release newer value
      </button>
      <button onClick={() => expression('toNumber("invalid")')}>Formula failure</button>
      <button
        onClick={() => {
          expression('prop("input")');
          input('');
        }}
      >
        Ordinary null
      </button>
      <button
        onClick={() => {
          input('3');
          expression('prop("input") * 3');
        }}
      >
        Edit closed database
      </button>
      <button onClick={() => setOpened((value) => !value)}>{opened ? 'Close footer' : 'Open footer'}</button>
      <button onClick={() => setTimeline(true)}>Use timeline footer</button>
      <button onClick={() => setRelated(true)}>Show related formulas</button>
      <button
        onClick={() =>
          (relatedRows['child-two'].getMap(E.data_section).get(E.database_row) as YDatabaseRow)
            .get(K.cells)
            .get('amount')
            .set(K.data, '1')
        }
      >
        Edit related input
      </button>
      <button
        onClick={() =>
          relatedFields
            .get('flag')
            .get(K.type_option)
            .get(String(FieldType.Formula))
            .set('expression', 'toNumber("invalid")')
        }
      >
        Fail related formula
      </button>
      <button
        onClick={() => {
          relatedFields.get('flag').get(K.type_option).get(String(FieldType.Formula)).set('expression', 'prop("empty")');
          fields
            .get('checked')
            .get(K.type_option)
            .get(String(FieldType.Rollup))
            .set('calculation_type', CalculationType.Sum);
        }}
      >
        Null related formula
      </button>
      <button onClick={() => convert(true)}>Start held conversion</button>
      <button onClick={() => convert(false)}>Convert to Number</button>
      <button onClick={() => convert(false, FieldType.RichText)}>Convert to Text</button>
      <button onClick={() => convert(false, FieldType.DateTime)}>Convert to Date</button>
      <button
        onClick={() => {
          dynamicAverage(false);
          setRelated(true);
        }}
      >
        Use Unknown numeric averages
      </button>
      <button onClick={() => dynamicAverage(true)}>Use mixed native averages</button>
      <button onClick={() => averageInput('')}>Clear first average values</button>
      <button onClick={() => averageInput('2')}>Restore first average values</button>
      <button
        onClick={() => {
          setOpened(false);
          expression('parseDate("2024-03-10T09:30:00")');
        }}
      >
        Use viewer date
      </button>
      <button
        onClick={() => {
          setOpened(false);
          expression(
            '[dateRange(parseDate("2024-03-10T09:30:00"), parseDate("2024-03-11T17:45:00")), parseDate("2024-03-12")]'
          );
        }}
      >
        Use viewer date list
      </button>
      {['SingleSelect', 'MultiSelect'].map((target) => (
        <button
          key={`prepare-${target}`}
          onClick={() => {
            setOpened(false);
            selectOptions(target === 'SingleSelect' ? FieldType.SingleSelect : FieldType.MultiSelect);
          }}
        >
          Prepare {target} conversion
        </button>
      ))}
      <button onClick={() => convert(false, FieldType.SingleSelect)}>Convert to SingleSelect</button>
      <button onClick={() => convert(false, FieldType.MultiSelect)}>Convert to MultiSelect</button>
      <button onClick={relationTitles}>Use 501 relation titles</button>
      <button
        onClick={() => {
          setOpened(false);
          showConditions('500');
          setConditions(true);
        }}
      >
        Filter 501 relation titles
      </button>
      <button
        onClick={() =>
          (relatedRows['title-0'].getMap(E.data_section).get(E.database_row) as YDatabaseRow)
            .get(K.cells)
            .get('title')
            .set(K.data, '')
        }
      >
        Blank first of 501 titles
      </button>
      <button
        onClick={() =>
          (relatedRows['title-0'].getMap(E.data_section).get(E.database_row) as YDatabaseRow)
            .get(K.cells)
            .get('title')
            .set(K.data, 'Restored')
        }
      >
        Restore first of 501 titles
      </button>
      <button
        onClick={() => {
          setOpened(false);
          period();
        }}
      >
        Use date range
      </button>
      <button onClick={() => expression('dateAdd(prop("period"), 1, "days")')}>Add day to range</button>
      <button
        onClick={() => {
          setOpened(false);
          period(true);
        }}
      >
        Use timed range
      </button>
      <button onClick={() => expression('[prop("period"), parseDate("2026-09-14")]')}>Use nested dates</button>
      <button
        onClick={() => {
          setOpened(false);
          period(false, true);
        }}
      >
        Use unsafe range end
      </button>
      <button
        onClick={() => {
          special('sqrt(-1)');
          setRelated(true);
        }}
      >
        Use NaN
      </button>
      <button
        onClick={() => {
          special('pow(10, 1000)');
          setRelated(true);
        }}
      >
        Use Infinity
      </button>
      <button
        onClick={() => {
          special('-0', CalculationType.Min);
          setRelated(true);
        }}
      >
        Use negative zero
      </button>
      <button onClick={() => setComputedMember(true)}>Use computed member target</button>
      <button onClick={() => setUniqueMember(true)}>Use unique member list</button>
      {['owner', 'creator', 'editor'].map((target) => (
        <button
          key={target}
          onClick={() => {
            setOpened(false);
            void memberRollup(target, computedMember, uniqueMember);
          }}
        >
          Use {target} Rollup
        </button>
      ))}
      <button onClick={() => void memberNames('Grace').then(() => setProfile('Grace'))}>Refresh stored member</button>
      <output data-testid='member-profile-state'>{profile}</output>
      <button
        onClick={() => {
          expression('prop("checked").join(",").length()');
          setOpened(true);
          showConditions('3');
          setConditions(true);
        }}
      >
        Show member length footer and filter
      </button>
      <button
        onClick={() => {
          addField('helper', FieldType.Formula, 'now /* host clock */ ()');
          expression('timestamp(prop("helper"))');
        }}
      >
        Use commented clock
      </button>
      <button
        onClick={() => {
          addField('helper', FieldType.Formula, 'today /* host clock */ ()');
          expression('timestamp(prop("helper"))');
        }}
      >
        Use commented today
      </button>
      <button
        onClick={() => {
          showConditions(String(new Date().getHours() === 23 ? 1767283200000 : 1767319200500));
          setConditions(true);
        }}
      >
        Filter clock values
      </button>
      <button
        onClick={() => {
          expression('prop("linked").length()');
          showConditions('0', true);
          setConditions(true);
        }}
      >
        Use relation membership
      </button>
      <button onClick={() => relatedView.get(K.row_orders).delete(0)}>Delete first related member</button>
      <button
        onClick={() =>
          (relatedRows['child-two'].getMap(E.data_section).get(E.database_row) as YDatabaseRow)
            .get(K.cells)
            .get('title')
            .set(K.data, '')
        }
      >
        Blank related title
      </button>
      <button onClick={() => relatedView.get(K.row_orders).insert(0, [{ id: 'child-one', height: 44 }])}>
        Restore first related member
      </button>
      <button
        onClick={() => {
          const row = rows.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow;
          const cells = row.get(K.cells).clone() as YDatabaseCells;

          row.doc?.transact(() => {
            row.set(K.cells, cells);
            cells.get('input').set(K.data, '9');
          });
        }}
      >
        Replace cells map
      </button>
      <button onClick={() => expression('timestamp(prop("edited")) / 1000')}>Use edited timestamp</button>
      <button
        onClick={() =>
          (rows.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow).set(K.last_modified, '11')
        }
      >
        Edit row metadata
      </button>
      <button onClick={() => setGapEdit(true)}>Edit between render and subscription</button>
      <button
        onClick={() => {
          fields.get('formula').get(K.type_option).get(String(FieldType.Formula)).set('format', NumberFormat.Percent);
          input('0.25');
          expression('prop("input")');
        }}
      >
        Use percent display
      </button>
      <button
        onClick={() => {
          input('11');
          expression('prop("input") * 3');
          release?.();
        }}
      >
        Edit during conversion
      </button>
      <button
        onClick={() => {
          relatedFields
            .get('flag')
            .get(K.type_option)
            .get(String(FieldType.Formula))
            .set('expression', 'prop("amount") * 2');
          setTypeOptions('checked', FieldType.Rollup, {
            relation_field_id: 'linked',
            target_field_id: 'flag',
            calculation_type: CalculationType.Sum,
            show_as: RollupDisplayMode.Calculated,
          });
          expression('prop("checked")');
        }}
      >
        Use external conversion
      </button>
      <button
        onClick={() => {
          (relatedRows['child-one'].getMap(E.data_section).get(E.database_row) as YDatabaseRow)
            .get(K.cells)
            .get('amount')
            .set(K.data, '7');
          relatedFields
            .get('flag')
            .get(K.type_option)
            .get(String(FieldType.Formula))
            .set('expression', 'prop("amount") * 3');
          release?.();
        }}
      >
        Edit external conversion
      </button>
      <button
        onClick={() => {
          fields.delete('formula');
          release?.();
        }}
      >
        Delete converting formula
      </button>
      <button
        onClick={() => {
          fields.get('formula').set(K.type, FieldType.Checkbox);
          release?.();
        }}
      >
        Retype converting formula
      </button>
      <button onClick={() => release?.()}>Release held conversion</button>
      <output data-testid='conversion-state'>{conversion}</output>
      <output data-testid='stored-field-type'>
        {!fields.has('formula')
          ? 'Deleted'
          : Number(fields.get('formula').get(K.type)) === FieldType.Formula
          ? 'Formula'
          : Number(fields.get('formula').get(K.type)) === FieldType.Number
          ? 'Number'
          : Number(fields.get('formula').get(K.type)) === FieldType.Checkbox
          ? 'Checkbox'
          : 'Text'}
      </output>
      {conversion === 'converted' && (
        <DatabaseContext.Provider value={fullContext}>
          <ConvertedCells />
        </DatabaseContext.Provider>
      )}
      <FormulaCell cell={cell} rowId='alpha' fieldId='formula' readOnly wrap />
      <output data-testid='formula-details'>
        {JSON.stringify(cell, (_key, value: unknown) =>
          typeof value === 'bigint'
            ? String(value)
            : typeof value === 'number' && Number.isNaN(value)
            ? 'NaN'
            : value === Infinity
            ? 'Infinity'
            : Object.is(value, -0)
            ? '-0'
            : value
        )}
      </output>
      {related && <RelatedConsumers />}
      {conditions && <Conditions />}
      {gapEdit && <GapEdit />}
      {opened &&
        (timeline ? (
          <TimelineRowValuesProvider rowOrders={orders}>
            <TimelineCalculation fieldId='formula' />
          </TimelineRowValuesProvider>
        ) : (
          <GridCalculateRowCell fieldId='formula' rowOrders={orders} />
        ))}
    </main>
  );
}

Object.assign(window, { formulaConsumersEvidence: evidence, formulaConsumersFixture: { doc, rows, database } });
const isoViewer = new URLSearchParams(window.location.search).get('viewer') === 'iso';

function App() {
  const [opened, setOpened] = useState(true);
  const [other, setOther] = useState(false);
  const [otherContext] = useState(() => {
    const otherDoc = new Y.Doc({ guid: 'other-consumers-database' }) as YDoc;
    const otherRows: Record<string, YDoc> = {};

    Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(doc));
    const otherDatabase = otherDoc.getMap(E.data_section).get(E.database) as YDatabase;

    otherDatabase.set(K.id, otherDoc.guid);
    otherDatabase
      .get(K.fields)
      .get('formula')
      .get(K.type_option)
      .get(String(FieldType.Formula))
      .set('expression', 'prop("input") * 10');
    for (const [id, rowDoc] of Object.entries(rows)) {
      const clone = new Y.Doc() as YDoc;

      Y.applyUpdate(clone, Y.encodeStateAsUpdate(rowDoc));
      otherRows[id] = clone;
    }

    (otherRows.alpha.getMap(E.data_section).get(E.database_row) as YDatabaseRow)
      .get(K.cells)
      .get('input')
      .set(K.data, '7');
    return {
      ...context,
      databaseDoc: otherDoc,
      rowMap: { alpha: otherRows.alpha },
      peekRowDocFromSeed: (id: string) => otherRows[id] ?? null,
      loadRowFromSeed: async (id: string) => otherRows[id],
      ensureRow: async (id: string) => otherRows[id],
      createRow: async (key: string) => ({ ...otherRows, ...relatedRows }[key.split('_rows_').pop()!]),
    };
  });

  return (
    <DatabaseContext.Provider value={other ? otherContext : context}>
      <button onClick={() => setOpened((value) => !value)}>
        {opened ? 'Close all consumers' : 'Open all consumers'}
      </button>
      <button onClick={() => setOther(true)}>Open another database</button>
      <button onClick={() => setOther(false)}>Return original database</button>
      <button
        onClick={() => {
          input('5');
          expression('prop("input") * 3');
        }}
      >
        Edit closed original database
      </button>
      <button onClick={() => release?.()}>Release original database reply</button>
      {opened && <Consumers />}
    </DatabaseContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <AFConfigContext.Provider
    value={
      isoViewer
        ? {
            isAuthenticated: true,
            currentUser: {
              email: 'viewer@example.com',
              name: 'Viewer',
              uid: '1',
              avatar: null,
              uuid: 'viewer',
              latestWorkspaceId: 'workspace',
              metadata: {
                [MetadataKey.DateFormat]: DateFormat.ISO,
                [MetadataKey.TimeFormat]: TimeFormat.TwentyFourHour,
              },
            },
            updateCurrentUser: async () => undefined,
            openLoginModal: () => undefined,
          }
        : undefined
    }
  >
    <App />
  </AFConfigContext.Provider>
);
