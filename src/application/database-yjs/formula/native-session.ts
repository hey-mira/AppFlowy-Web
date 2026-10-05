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
import { ComputedSession, enterComputedCell } from '@/application/database-yjs/rollup/computed';
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
  rememberNativeFormulaPropertyState,
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

export function formulaSchemaUsesClock(schema: FormulaFieldSchema[], candidateExpression = '') {
  return /\b(?:now|today)\b/.test(candidateExpression) || schema.some(
    (entry) =>
      // A conservative clock subscription permits comments between the
      // native identifier and call. Syntax remains the engine's responsibility.
      entry.type === FieldType.Formula && /\b(?:now|today)\b/.test(parseFormulaTypeOption(entry.field).formula)
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

/** Resolve static type even when the target database has no mounted formula cells. */
export async function nativeFormulaPropertyInSession(
  source: { database: YDatabase; baseDoc: YDoc; fieldId: string },
  session: ComputedSession
) {
  const schema = readFormulaSchema(source.database.get(K.fields));
  const engine = await nativeEngineForSession(source.baseDoc, session).synchronize({
    properties: schema.map(nativePropertyDefinition),
  });
  const state = await engine.getProperty(source.fieldId);

  const field = source.database.get(K.fields).get(source.fieldId);

  if (field) rememberNativeFormulaPropertyState(field, state);
  return state;
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
            ...source.loaders,
            // Loader objects can originate from the caller's compute context;
            // the nested Input must always supply its own database/cell identity.
            baseDoc: source.baseDoc,
            database: source.database,
            row: source.row,
            rowId: source.rowId,
            rollupField: entry.field,
            fieldId: entry.id,
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
  const rollupNeedsMembers = rollupValues.some(
    ([, value]) =>
      value.targetFieldType !== undefined &&
      [FieldType.Person, FieldType.CreatedBy, FieldType.LastEditedBy].includes(value.targetFieldType)
  );

  if (rollupNeedsMembers) session.usesPeople?.();
  const resolvedMembers = members ?? (rollupNeedsMembers ? await loadMentionableUsers(source.loaders.workspaceId) : []);
  const names = memberNames(resolvedMembers);
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

/** One fresh batch for a permanent host operation, never a display-cache read. */
export async function evaluateNativeFormulaBatch(
  source: {
    database: YDatabase;
    baseDoc: YDoc;
    fieldId: string;
    rows: Record<string, YDoc>;
    loaders: RelatedRowLoaders;
  },
  session: ComputedSession,
  computeRollup: (context: RollupComputeContext, session: ComputedSession) => Promise<RollupCellValue>
): Promise<Map<string, FormulaCellResult>> {
  const schema = readFormulaSchema(source.database.get(K.fields));
  const field = source.database.get(K.fields).get(source.fieldId);
  const engine = await nativeEngineForSession(source.baseDoc, session).synchronize({
    properties: schema.map(nativePropertyDefinition),
  });
  const state = await engine.getProperty(source.fieldId);

  if (field) rememberNativeFormulaPropertyState(field, state);
  const rowIds = Object.keys(source.rows);

  if (!state || 'Input' in state || state.Formula.status === 'NotReady') {
    return new Map(
      rowIds.map((id) => [
        id,
        projectNativeFormulaResult(
          {
            status: 'not-ready',
            resultType: 'any',
            error: 'Formula is not ready: check its property references, types and dependencies',
          },
          field
        ),
      ])
    );
  }

  const required = new Set(await engine.requiredInputs([source.fieldId]));
  const inputs = schema.filter((entry) => required.has(entry.id));
  const values: Map<string, Value | null>[] = [];

  for (let index = 0; index < rowIds.length; index += 24) {
    values.push(
      ...(await Promise.all(
        rowIds.slice(index, index + 24).map(async (rowId) => {
          const row = source.rows[rowId].getMap(E.data_section).get(E.database_row) as YDatabaseRow;
          const current = enterComputedCell({ ...source, rowId, row, rollupField: field }, session, true);

          return resolveNativeRowInputs(
            { ...source, rowId, row, history: isDatabaseHistoryDocumentImmutable(source.baseDoc) },
            inputs,
            current,
            computeRollup
          );
        })
      ))
    );
  }

  const result = await engine.evaluate({
    row_ids: rowIds,
    formula_ids: [source.fieldId],
    columns: nativeBatchColumns(schema, values),
    runtime: formulaHostRuntime(session.now),
  });
  const output = result.formulas.get(source.fieldId);

  return new Map(
    rowIds.map((id, index) => [
      id,
      projectNativeFormulaResult(
        output && 'Ok' in output
          ? nativeOutputOutcome(output.Ok, index)
          : { status: 'not-ready', resultType: 'any', error: 'Formula is not ready' },
        field
      ),
    ])
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

  rememberNativeFormulaPropertyState(context.rollupField, state);

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
