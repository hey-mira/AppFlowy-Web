import * as Y from 'yjs';

import { CalculationType, FieldType, RollupDisplayMode } from '@/application/database-yjs/database.type';
import {
  CellSpec,
  checklistData,
  createFields,
  createRow,
  FieldSpec,
  mediaItem,
  RowMeta,
  selectOptions,
} from '@/application/database-yjs/fields/formula/__tests__/fixture';
import { evaluateNativeFormulaBatch } from '@/application/database-yjs/formula/native-session';
import { projectNativeFormulaResult } from '@/application/database-yjs/formula/native-values';
import { evaluateRollupCell, RollupCellValue } from '@/application/database-yjs/rollup/cache';
import { ComputedSession, releaseComputedFormulaEngines } from '@/application/database-yjs/rollup/computed';
import { getRowKey } from '@/application/database-yjs/row_meta';
import { db as memberDatabase } from '@/application/db';
import {
  YDatabase,
  YDatabaseView,
  YDatabaseViews,
  YDoc,
  YjsDatabaseKey as K,
  YjsEditorKey as E,
} from '@/application/types';
import '@/i18n/config';

import authoredDataset from '../fixtures/native-formula-values.dataset.json';
import researchedScenarios from '../fixtures/researched-scenarios.json';

type Projection = ReturnType<typeof projectNativeFormulaResult>;
type Phase = 'source' | 'restored';
type Input = {
  text?: string;
  start?: number;
  end?: number;
  include_time?: boolean;
  ids?: string[];
  checked?: boolean;
  done?: number;
  total?: number;
  rows?: string[];
  names?: string[];
  people?: string[];
  uid?: number;
};
type Contract = {
  id: string;
  field_type: FieldType;
  source_type: FieldType;
  kind: string;
  value_set: keyof typeof authoredDataset.value_sets;
  predicate: string;
  normalize: string;
  formula?: string;
  rollup?: {
    target: 'amount' | 'title' | 'checked';
    calculation: 'Sum' | 'PercentChecked';
    show_as: 'Calculated' | 'OriginalList';
  };
};

export interface ValuesReport {
  failures: string[];
  workers: number;
  evaluations: number;
  workerURLs: string[];
  serialization: { documents: number; bytes: number };
  states: Array<{ phase: Phase; contractId: string; valueId: string; result: Projection }>;
  campaignRates: Array<{ phase: Phase; rowId: string; result: Projection }>;
  campaign: Array<{
    phase: Phase;
    mask: number;
    result: Projection;
    rollup?: Pick<RollupCellValue, 'value' | 'rawNumeric' | 'error'>;
  }>;
}

const report: ValuesReport = {
  failures: [],
  workers: 0,
  evaluations: 0,
  workerURLs: [],
  serialization: { documents: 0, bytes: 0 },
  states: [],
  campaignRates: [],
  campaign: [],
};
const RealWorker = window.Worker;

// Observe the actual packaged Worker. Its SDK/WASM computation is unchanged.
window.Worker = class extends RealWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    report.workers += 1;
    report.workerURLs.push(String(url));
  }

  postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
    if (message && typeof message === 'object' && 'method' in message && message.method === 'engine.evaluate')
      report.evaluations += 1;
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }
};

const allDocs: YDoc[] = [];
const relatedId = 'native-values-related';
const workspaceId = 'native-values-workspace';

function database(id: string, specs: FieldSpec[], rowIds: string[]) {
  const doc = new Y.Doc({ guid: id }) as YDoc;
  const database = new Y.Map() as YDatabase;
  const fields = createFields(specs);
  const views = new Y.Map() as YDatabaseViews;
  const view = new Y.Map() as YDatabaseView;

  doc.getMap(E.data_section).set(E.database, database);
  database.set(K.id, id);
  database.set(K.fields, fields.clone());
  database.set(K.views, views);
  views.set('inline', view);
  view.set(K.id, 'inline');
  view.set(K.is_inline, true);
  view.set(K.row_orders, Y.Array.from(rowIds.map((id) => ({ id, height: 44 }))));
  fields.doc?.destroy();
  allDocs.push(doc);
  return doc;
}

function row(id: string, databaseId: string, cells: Record<string, CellSpec>, meta: RowMeta = {}) {
  const { doc, row } = createRow(id, cells, meta);

  row.set(K.database_id, databaseId);
  allDocs.push(doc);
  return doc;
}

function reload(doc: YDoc): YDoc {
  const update = Y.encodeStateAsUpdate(doc);
  const restored = new Y.Doc({ guid: doc.guid }) as YDoc;

  Y.applyUpdate(restored, update);
  report.serialization.documents += 1;
  report.serialization.bytes += update.byteLength;
  allDocs.push(restored);
  return restored;
}

function databaseOf(doc: YDoc): YDatabase {
  return doc.getMap(E.data_section).get(E.database) as YDatabase;
}

function formula(id: string, name: string, expression: string): FieldSpec {
  return { id, name, type: FieldType.Formula, typeOption: { expression } };
}

function fieldSpecs(contract: Contract): FieldSpec[] {
  const sourceId = contract.formula ? 'source' : 'value';
  const field: FieldSpec = { id: sourceId, name: `Stored ${contract.id}`, type: contract.source_type };

  if ([FieldType.SingleSelect, FieldType.MultiSelect].includes(field.type))
    field.typeOption = { content: selectOptions(authoredDataset.options.map(({ id, name }) => [id, name])) };
  if (field.type === FieldType.Relation) field.typeOption = { database_id: relatedId };
  if (contract.rollup)
    field.typeOption = {
      relation_field_id: 'links',
      target_field_id: `formula-${contract.rollup.target}`,
      calculation_type: CalculationType[contract.rollup.calculation],
      show_as: RollupDisplayMode[contract.rollup.show_as],
    };

  const reference = 'prop("downstream")';
  const predicate = contract.predicate.replaceAll('$', reference);
  const normalize = contract.normalize.replaceAll('$', reference);

  return [
    ...(contract.rollup
      ? [{ id: 'links', name: 'Related values', type: FieldType.Relation, typeOption: { database_id: relatedId } }]
      : []),
    field,
    ...(contract.formula ? [formula('value', 'Source Formula', contract.formula.replaceAll('$source', 'source'))] : []),
    formula('stage', 'First Formula reference', 'prop("value")'),
    formula('downstream', 'Second Formula reference', 'prop("stage")'),
    formula(
      'probe',
      'Value coverage',
      `[prop("value"), ${reference}, ${predicate}, ${normalize}, empty(${reference}), if(${predicate}, ${reference}, empty())]`
    ),
  ];
}

/** Encode authored inputs only. Expectations never supply cells or host results. */
function storedValue(contract: Contract, input: Input | null): { cells: Record<string, CellSpec>; meta: RowMeta } {
  const cells: Record<string, CellSpec> = {};
  const meta: RowMeta = {};

  if (!input) return { cells, meta };
  const sourceId = contract.formula ? 'source' : 'value';
  const type = contract.source_type;

  switch (type) {
    case FieldType.CreatedTime:
      meta.createdAt = String(input.start);
      break;
    case FieldType.LastEditedTime:
      meta.lastModified = String(input.start);
      break;
    case FieldType.CreatedBy:
      meta.createdBy = input.uid;
      break;
    case FieldType.LastEditedBy:
      meta.lastEditedBy = input.uid;
      break;
    case FieldType.Rollup:
      cells.links = { type: FieldType.Relation, data: { yArray: input.rows! } };
      break;
    case FieldType.DateTime:
      cells[sourceId] = {
        type,
        data: String(input.start),
        extra: {
          include_time: input.include_time,
          is_range: input.end !== undefined,
          ...(input.end === undefined ? {} : { end_timestamp: String(input.end) }),
        },
      };
      break;
    case FieldType.SingleSelect:
    case FieldType.MultiSelect:
      cells[sourceId] = { type, data: input.ids!.join(',') };
      break;
    case FieldType.Checkbox:
      cells[sourceId] = { type, data: input.checked ? 'Yes' : 'No' };
      break;
    case FieldType.Checklist:
      cells[sourceId] = { type, data: checklistData(input.done!, input.total!) };
      break;
    case FieldType.Relation:
      cells[sourceId] = { type, data: { yArray: input.rows! } };
      break;
    case FieldType.Media:
      cells[sourceId] = { type, data: { yArray: input.names!.map((name, index) => mediaItem(`media-${index}`, name)) } };
      break;
    case FieldType.Person:
      cells[sourceId] = { type, data: JSON.stringify(input.people) };
      break;
    default:
      cells[sourceId] = { type, data: input.text! };
  }

  return { cells, meta };
}

function loaders(databaseId: string, source: YDoc, rows: Record<string, YDoc>) {
  const byKey = new Map(Object.entries(rows).map(([id, doc]) => [getRowKey(databaseId, id), doc]));

  return {
    workspaceId,
    getViewIdFromDatabaseId: async (id: string) => id,
    loadView: async (id: string) => (id === databaseId ? source : null),
    createRow: async (key: string) => {
      const doc = byKey.get(key);

      if (!doc) throw new Error(`Missing authored related row ${key}`);
      return doc;
    },
  };
}

function session(): ComputedSession {
  return { path: new Set(), now: authoredDataset.now_ms, nativeFormulaEngines: new Map() };
}

async function seedMembers() {
  // The production member loader reads its normal IndexedDB cache.
  await memberDatabase.workspace_member_profiles.bulkPut(
    authoredDataset.people.map(({ id, uid, name }) => ({
      workspace_id: workspaceId,
      user_uuid: id,
      person_id: id,
      uid: String(uid),
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
    }))
  );
}

async function runValues() {
  const related = database(
    relatedId,
    [
      { id: 'title', name: 'Title', type: FieldType.RichText },
      { id: 'amount', name: 'Amount', type: FieldType.Number },
      { id: 'checked', name: 'Checked', type: FieldType.Checkbox },
      // Persist canonical IDs at authoring time; legacy formulas used display names.
      ...(['title', 'amount', 'checked'] as const).map((id) =>
        formula(`formula-${id}`, `Formula ${id}`, `prop("${id}")`)
      ),
    ],
    authoredDataset.related_rows.map(({ id }) => id)
  );

  databaseOf(related).get(K.fields).get('title').set(K.is_primary, true);
  const relatedRows = Object.fromEntries(
    authoredDataset.related_rows.map((input) => [
      input.id,
      row(input.id, relatedId, {
        title: { type: FieldType.RichText, data: input.title },
        checked: { type: FieldType.Checkbox, data: input.checked ? 'Yes' : 'No' },
        ...(input.amount === null ? {} : { amount: { type: FieldType.Number, data: input.amount } }),
      }),
    ])
  );
  const restoredRelated = reload(related);
  const restoredRelatedRows = Object.fromEntries(Object.entries(relatedRows).map(([id, doc]) => [id, reload(doc)]));

  for (const contract of authoredDataset.contracts as Contract[]) {
    const values = authoredDataset.value_sets[contract.value_set];
    const databaseId = `native-values-${contract.id}`;
    const source = database(
      databaseId,
      fieldSpecs(contract),
      values.map(({ id }) => id)
    );
    const rows = Object.fromEntries(
      values.map((value) => {
        const stored = storedValue(contract, value.input);

        return [value.id, row(value.id, databaseId, stored.cells, stored.meta)];
      })
    );
    const restored = reload(source);
    const restoredRows = Object.fromEntries(Object.entries(rows).map(([id, doc]) => [id, reload(doc)]));

    for (const [phase, baseDoc, currentRows, relatedDoc, currentRelatedRows] of [
      ['source', source, rows, related, relatedRows],
      ['restored', restored, restoredRows, restoredRelated, restoredRelatedRows],
    ] as const) {
      const current = session();

      try {
        const results = await evaluateNativeFormulaBatch(
          {
            baseDoc,
            database: databaseOf(baseDoc),
            fieldId: 'probe',
            rows: currentRows,
            loaders: loaders(relatedId, relatedDoc, currentRelatedRows),
          },
          current,
          evaluateRollupCell
        );

        for (const value of values)
          report.states.push({
            phase,
            contractId: contract.id,
            valueId: value.id,
            result: results.get(value.id)! as Projection,
          });
      } catch (error) {
        report.failures.push(`${phase}/${contract.id}: ${String(error)}`);
      } finally {
        releaseComputedFormulaEngines(current);
      }
    }
  }
}

async function runCampaign() {
  const campaign = researchedScenarios.scenarios.find(({ id }) => id === 'campaign-open-rate')!;
  const records = campaign.rows!;
  const sourceId = 'native-values-campaigns';
  const ownerId = 'native-values-campaign-owner';
  const source = database(
    sourceId,
    [
      { id: 'title', name: 'Title', type: FieldType.RichText },
      { id: 'opened', name: 'Opened', type: FieldType.Number },
      { id: 'sent', name: 'Sent', type: FieldType.Number },
      formula('rate', 'Open rate', 'if(empty(prop("sent")), empty(), prop("opened") / prop("sent") * 100)'),
    ],
    records.map((_record, index) => `campaign-${index}`)
  );
  const sourceRows = Object.fromEntries(
    records.map((record, index) => {
      const id = `campaign-${index}`;

      return [
        id,
        row(id, sourceId, {
          title: { type: FieldType.RichText, data: record.name },
          opened: { type: FieldType.Number, data: String(record.opened) },
          sent: { type: FieldType.Number, data: String(record.sent) },
        }),
      ];
    })
  );
  const owner = database(
    ownerId,
    [
      { id: 'campaigns', name: 'Campaigns', type: FieldType.Relation, typeOption: { database_id: sourceId } },
      {
        id: 'average',
        name: 'Average rate',
        type: FieldType.Rollup,
        typeOption: {
          relation_field_id: 'campaigns',
          target_field_id: 'rate',
          calculation_type: CalculationType.Average,
          show_as: RollupDisplayMode.Calculated,
        },
      },
      formula(
        'summary',
        'Summary',
        'if(empty(prop("average")), "No positive rate", format(prop("average")) + "% average")'
      ),
      formula('downstream', 'Downstream summary', 'prop("summary")'),
      formula('probe', 'Campaign coverage', '[prop("average"), prop("downstream")]'),
    ],
    Array.from({ length: 16 }, (_value, mask) => `subset-${mask}`)
  );
  const ownerRows = Object.fromEntries(
    Array.from({ length: 16 }, (_value, mask) => {
      const id = `subset-${mask}`;

      return [
        id,
        row(id, ownerId, {
          campaigns: {
            type: FieldType.Relation,
            data: { yArray: records.flatMap((_record, index) => (mask & (1 << index) ? [`campaign-${index}`] : [])) },
          },
        }),
      ];
    })
  );
  const restoredSource = reload(source);
  const restoredOwner = reload(owner);
  const restoredSourceRows = Object.fromEntries(Object.entries(sourceRows).map(([id, doc]) => [id, reload(doc)]));
  const restoredOwnerRows = Object.fromEntries(Object.entries(ownerRows).map(([id, doc]) => [id, reload(doc)]));

  for (const [phase, sourceDoc, currentSourceRows, ownerDoc, currentOwnerRows] of [
    ['source', source, sourceRows, owner, ownerRows],
    ['restored', restoredSource, restoredSourceRows, restoredOwner, restoredOwnerRows],
  ] as const) {
    const current = session();
    const load = loaders(sourceId, sourceDoc, currentSourceRows);

    try {
      const rates = await evaluateNativeFormulaBatch(
        {
          baseDoc: sourceDoc,
          database: databaseOf(sourceDoc),
          fieldId: 'rate',
          rows: currentSourceRows,
          loaders: load,
        },
        current,
        evaluateRollupCell
      );

      for (const [rowId, result] of rates) report.campaignRates.push({ phase, rowId, result: result as Projection });
      const rollups = new Map<string, RollupCellValue>();
      const summaries = await evaluateNativeFormulaBatch(
        {
          baseDoc: ownerDoc,
          database: databaseOf(ownerDoc),
          fieldId: 'probe',
          rows: currentOwnerRows,
          loaders: load,
        },
        current,
        async (context, parent) => {
          const value = await evaluateRollupCell(context, parent);

          if (context.fieldId === 'average' && context.baseDoc === ownerDoc) rollups.set(context.rowId, value);
          return value;
        }
      );

      for (let mask = 0; mask < 16; mask++) {
        const id = `subset-${mask}`;
        const rollup = rollups.get(id);

        report.campaign.push({
          phase,
          mask,
          result: summaries.get(id)! as Projection,
          rollup: rollup && { value: rollup.value, rawNumeric: rollup.rawNumeric, error: rollup.error },
        });
      }
    } catch (error) {
      report.failures.push(`${phase}/campaign: ${String(error)}`);
    } finally {
      releaseComputedFormulaEngines(current);
    }
  }
}

async function run() {
  const root = document.getElementById('root')!;

  root.innerHTML = '<h1>Native stored Formula values</h1><p>Evaluating authored values and Rollups in Rust/WASM…</p>';
  try {
    await seedMembers();
    await runValues();
    await runCampaign();
  } catch (error) {
    report.failures.push(String(error));
  } finally {
    allDocs.forEach((doc) => doc.destroy());
  }

  root.querySelector(
    'p'
  )!.textContent = `${report.states.length} stored value results; ${report.campaign.length} Campaign subsets; ${report.workers} real Workers; ${report.serialization.documents} Yjs reloads.`;
  const evidence = document.createElement('pre');

  evidence.textContent = JSON.stringify(
    { failures: report.failures, contracts: authoredDataset.contracts.map(({ id }) => id) },
    null,
    2
  );
  root.append(evidence);
  (window as unknown as { nativeValuesReport: ValuesReport }).nativeValuesReport = report;
}

void run();
