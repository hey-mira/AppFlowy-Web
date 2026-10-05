import { waitForDatabaseHydration } from '@/application/database-yjs/database.hydration';
import { FieldType } from '@/application/database-yjs/database.type';
import { decodeCellToText } from '@/application/database-yjs/decode';
import { ReadFieldValueContext } from '@/application/database-yjs/fields/formula/cell-values';
import { FormulaCellResult } from '@/application/database-yjs/fields/formula/formula.type';
import { parseFormulaTypeOption } from '@/application/database-yjs/fields/formula/parse';
import { FormulaFieldSchema, readFormulaSchema } from '@/application/database-yjs/fields/formula/schema';
import { parseRelationTypeOption } from '@/application/database-yjs/fields/relation/parse';
import {
  historicalFormulaRowContext,
  memberNames,
  RelatedRowLoaders,
} from '@/application/database-yjs/formula/read-context';
import { isDatabaseHistoryDocumentImmutable } from '@/application/database-yjs/immutable';
import { readRelationMembership } from '@/application/database-yjs/relation/cache';
import { getRelationRowIdsFromCell } from '@/application/database-yjs/relation/cell';
import { RollupCellValue, RollupComputeContext } from '@/application/database-yjs/rollup/cache';
import { ComputedSession } from '@/application/database-yjs/rollup/computed';
import { waitForDatabaseRowHydration } from '@/application/database-yjs/row.hydration';
import { getRowKey } from '@/application/database-yjs/row_meta';
import {
  YDatabase,
  YDatabaseField,
  YDatabaseRow,
  YDoc,
  YjsDatabaseKey as K,
  YjsEditorKey as E,
} from '@/application/types';
import { loadMentionableUsers } from '@/components/database/components/cell/person/useMentionableUsers';

import { retainNativeFormulaEngine } from './native-engine';
import {
  nativeInputColumn,
  nativeOutputOutcome,
  nativePropertyDefinition,
  NativeFormulaOutcome,
  projectNativeFormulaResult,
  readNativeInput,
} from './native-values';

import type { Column, FormulaEngineClient, PropertyState, Value } from '@notion-formula/sdk';

export function formulaHostRuntime(now: number) {
  const minutes = -new Date(now).getTimezoneOffset();
  const absolute = Math.abs(minutes);
  const offset = `${minutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(
    absolute % 60
  ).padStart(2, '0')}`;

  return { now: BigInt(Math.trunc(now)), time_zone: offset };
}

export function formulaSchemaUsesClock(schema: FormulaFieldSchema[]) {
  return schema.some(
    (entry) =>
      entry.type === FieldType.Formula && /\b(?:now|today)\s*\(/.test(parseFormulaTypeOption(entry.field).formula)
  );
}

export function nativeEngineForSession(doc: YDoc, session: ComputedSession) {
  const engines = (session.nativeFormulaEngines ??= new Map());
  let lease = engines.get(doc);

  if (!lease) {
    lease = retainNativeFormulaEngine(doc, isDatabaseHistoryDocumentImmutable(doc) ? 'history' : 'live');
    engines.set(doc, lease);
  }

  return lease;
}

export type NativeRowSource = {
  database: YDatabase;
  baseDoc: YDoc;
  row: YDatabaseRow;
  rowId: string;
  loaders: RelatedRowLoaders;
  history: boolean;
  rows?: Record<string, YDoc> | null;
};

/** Resolve only the native dependency query's Inputs, retaining host cycle guards. */
export async function resolveNativeRowInputs(
  source: NativeRowSource,
  inputs: FormulaFieldSchema[],
  session: ComputedSession,
  computeRollup: (context: RollupComputeContext, session: ComputedSession) => Promise<RollupCellValue>
): Promise<Map<string, Value | null>> {
  if (session.signal?.aborted) throw new DOMException('Formula evaluation cancelled', 'AbortError');
  if (source.history) {
    const context = historicalFormulaRowContext(source.rowId, source.row, {
      database: source.database,
      baseDoc: source.baseDoc,
      rows: source.rows,
    });

    return new Map(inputs.map((entry) => [entry.id, readNativeInput(entry, source.row, context)]));
  }

  const people = inputs.some((entry) =>
    [FieldType.Person, FieldType.CreatedBy, FieldType.LastEditedBy].includes(entry.type)
  );
  const relations = inputs.filter((entry) => entry.type === FieldType.Relation);
  const rollups = inputs.filter((entry) => entry.type === FieldType.Rollup);
  const titles = new Map<YDatabaseField, Map<string, string | null>>();

  if (people) session.usesPeople?.();
  const [members, rollupValues] = await Promise.all([
    people ? loadMentionableUsers(source.loaders.workspaceId) : undefined,
    Promise.all(
      rollups.map(async (entry) => {
        const value = await computeRollup(
          {
            baseDoc: source.baseDoc,
            database: source.database,
            row: source.row,
            rowId: source.rowId,
            rollupField: entry.field,
            fieldId: entry.id,
            ...source.loaders,
            requireLoadedSources: true,
            loadSourceDocumentsDirectly: true,
          },
          session
        );

        if (value.error) throw new Error(value.error);
        return [entry.id, value] as const;
      })
    ),
    Promise.all(
      relations.map(async (entry) => {
        const ids = getRelationRowIdsFromCell(source.row.get(K.cells)?.get(entry.id));
        const names = new Map<string, string | null>();

        titles.set(entry.field, names);
        if (ids.length === 0) return;
        const databaseId = parseRelationTypeOption(entry.field).database_id;
        const viewId = databaseId ? await source.loaders.getViewIdFromDatabaseId?.(databaseId) : null;
        const doc =
          viewId && databaseId
            ? await source.loaders.loadView?.(viewId, false, false, { databaseId, databaseMetadataOnly: true })
            : undefined;

        if (!doc) throw new Error(`Related database ${databaseId ?? ''} could not be loaded for formula evaluation`);
        session.observe?.(doc);
        const database = await waitForDatabaseHydration(doc);
        const membership =
          readRelationMembership(doc) ??
          (await import('./materialize').then(({ waitForRelationMembership }) => waitForRelationMembership(doc)));

        if (!database || !membership)
          throw new Error(`Related database ${databaseId} could not be hydrated for formula evaluation`);
        const primary = Array.from(database.get(K.fields).values()).find((field) => field.get(K.is_primary));

        if (!primary) throw new Error(`Related database ${databaseId} title property could not be loaded`);
        await Promise.all(
          ids.map(async (id) => {
            if (session.signal?.aborted) throw new DOMException('Formula evaluation cancelled', 'AbortError');
            if (!membership.has(id)) {
              names.set(id, null);
              return;
            }

            const rowDoc = await source.loaders.createRow?.(getRowKey(doc.guid, id));

            if (!rowDoc || !(await waitForDatabaseRowHydration(rowDoc))) {
              throw new Error(`Related row ${id} could not be loaded for formula evaluation`);
            }

            session.observe?.(rowDoc);
            const row = rowDoc.getMap(E.data_section).get(E.database_row) as YDatabaseRow;
            const cell = row.get(K.cells)?.get(primary.get(K.id));

            names.set(id, cell ? decodeCellToText(cell, primary) : '');
          })
        );
      })
    ),
  ]);

  if (session.signal?.aborted) throw new DOMException('Formula evaluation cancelled', 'AbortError');
  const names = memberNames(members ?? []);
  const values = new Map(rollupValues);
  const context: ReadFieldValueContext = {
    ...names,
    getRelatedRowTitle: (field, id) => titles.get(field)?.get(id),
    getRollupValue: (id) => values.get(id),
  };

  return new Map(inputs.map((entry) => [entry.id, readNativeInput(entry, source.row, context)]));
}

export function nativeBatchColumns(
  schema: FormulaFieldSchema[],
  rows: Map<string, Value | null>[]
): Map<string, Column> {
  const columns = new Map<string, Column>();

  for (const entry of schema) {
    const definition = nativePropertyDefinition(entry);

    if ('Input' in definition)
      columns.set(
        entry.id,
        nativeInputColumn(
          definition.Input.ty,
          rows.map((row) => row.get(entry.id) ?? null)
        )
      );
  }

  return columns;
}

export function nativeFormulaStates(properties: PropertyState[]) {
  return new Map(
    properties.map((property) => ['Input' in property ? property.Input.id : property.Formula.definition.id, property])
  );
}

export async function evaluateNativeFormulaInSession(
  context: RollupComputeContext,
  session: ComputedSession,
  computeRollup: (context: RollupComputeContext, session: ComputedSession) => Promise<RollupCellValue>
): Promise<FormulaCellResult> {
  const schema = readFormulaSchema(context.database.get(K.fields));
  const engine: FormulaEngineClient = await nativeEngineForSession(context.baseDoc, session).synchronize({
    properties: schema.map(nativePropertyDefinition),
  });
  const state = await engine.getProperty(context.fieldId);

  if (!state || 'Input' in state || state.Formula.status === 'NotReady') {
    return projectNativeFormulaResult(
      {
        status: 'not-ready',
        resultType: 'any',
        error: 'Formula is not ready: check its property references, types and dependencies',
      },
      context.rollupField
    );
  }

  const required = new Set(await engine.requiredInputs([context.fieldId]));

  if (formulaSchemaUsesClock(schema)) session.usesClock?.();
  const values = await resolveNativeRowInputs(
    { ...context, history: isDatabaseHistoryDocumentImmutable(context.baseDoc), loaders: context },
    schema.filter((entry) => required.has(entry.id)),
    session,
    computeRollup
  );
  const result = await engine.evaluate({
    row_ids: [context.rowId],
    formula_ids: [context.fieldId],
    columns: nativeBatchColumns(schema, [values]),
    runtime: formulaHostRuntime(session.now),
  });
  const output = result.formulas.get(context.fieldId);
  const outcome: NativeFormulaOutcome =
    !output || 'Err' in output
      ? { status: 'not-ready', resultType: 'any', error: 'Formula is not ready' }
      : nativeOutputOutcome(output.Ok, 0);

  return projectNativeFormulaResult(outcome, context.rollupField);
}
