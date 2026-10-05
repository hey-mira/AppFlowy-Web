import { useEffect, useMemo, useRef, useState } from 'react';

import { useDatabaseContext } from '@/application/database-yjs/context';
import { FormulaFieldSchema } from '@/application/database-yjs/fields/formula/schema';
import { useFormulaClock } from '@/application/database-yjs/formula/clock';
import {
  formulaHostRuntime,
  formulaSchemaUsesClock,
  nativeBatchColumns,
  resolveNativeRowInputs,
} from '@/application/database-yjs/formula/native-session';
import {
  nativeOutputOutcome,
  NativeFormulaOutcome,
  projectNativeFormulaResult,
} from '@/application/database-yjs/formula/native-values';
import { evaluateRollupCell } from '@/application/database-yjs/rollup/cache';
import {
  ComputedSession,
  enterComputedCell,
  releaseComputedFormulaEngines,
} from '@/application/database-yjs/rollup/computed';
import { retainRollupSource } from '@/application/database-yjs/rollup/source-sync';
import { YDatabase, YDatabaseRow, YDoc, YjsDatabaseKey as K, YjsEditorKey as E } from '@/application/types';

import { nativeEditorProperties, retainNativeSession } from './native-editor';

import type { FormulaEngineClient, PropertyDefinition } from '@notion-formula/sdk';

/** Reused while the editor is open; no Draft is ever created on this Engine. */
class NativeFormulaPreviewSession {
  private engine?: FormulaEngineClient;
  private definitions = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  synchronize(properties: PropertyDefinition[]) {
    const result = this.tail.then(async () => {
      if (this.closed) throw new Error('Formula preview session is closed');
      const next = new Map(
        properties.map((property) => [
          'Input' in property ? property.Input.id : property.Formula.id,
          JSON.stringify(property),
        ])
      );

      if (!this.engine) {
        const { createFormulaEngineClient } = await import('@notion-formula/sdk');

        this.engine = await createFormulaEngineClient({ properties });
      } else {
        for (const id of this.definitions.keys()) if (!next.has(id)) await this.engine.remove(id);
        for (const property of properties) {
          const id = 'Input' in property ? property.Input.id : property.Formula.id;

          if (this.definitions.get(id) !== next.get(id)) await this.engine.upsert(property);
        }
      }

      this.definitions = next;
      return this.engine;
    });

    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  close() {
    this.closed = true;
    void this.tail.then(() => this.engine?.close()).catch(() => undefined);
  }
}

export function useNativeFormulaPreview({
  fieldId,
  expression,
  schema,
  row,
  rowId,
  valid,
}: {
  fieldId: string;
  expression: string;
  schema: FormulaFieldSchema[];
  row?: YDatabaseRow;
  rowId: string;
  valid: boolean;
}) {
  const context = useDatabaseContext();
  const history = context.dataSource?.type === 'history';
  const session = useMemo(() => {
    void context.databaseDoc;
    void fieldId;
    return new NativeFormulaPreviewSession();
  }, [context.databaseDoc, fieldId]);
  const historyNow = useMemo(() => {
    void context.databaseDoc;
    return Date.now();
  }, [context.databaseDoc]);
  const [rowRevision, setRowRevision] = useState(0);
  const [externalRevision, setExternalRevision] = useState(0);
  const [externalClock, setExternalClock] = useState(false);
  const clock = useFormulaClock(!history && (formulaSchemaUsesClock(schema, expression) || externalClock));
  const epoch = useRef(0);
  const [snapshot, setSnapshot] = useState<{ expression: string; rowId: string; outcome: NativeFormulaOutcome }>();

  useEffect(() => retainNativeSession(session), [session]);
  useEffect(() => {
    // External Formula targets can discover a clock dependency while resolving
    // Rollup inputs. Keep it across ticks, and rediscover it for a new source.
    setExternalClock(false);
  }, [context, expression, schema, row, rowId, externalRevision]);
  useEffect(() => {
    if (!row || history) return;
    const change = () => setRowRevision((revision) => revision + 1);

    row.observeDeep(change);
    return () => row.unobserveDeep(change);
  }, [row, history]);

  useEffect(() => {
    const revision = ++epoch.current;
    const controller = new AbortController();
    const observed = new Map<YDoc, () => void>();
    const metadataDocuments = new WeakSet<YDoc>();
    const current = () => revision === epoch.current && !controller.signal.aborted;
    const checkCurrent = () => {
      if (!current()) throw new DOMException('Formula preview cancelled', 'AbortError');
    };

    const resources: ComputedSession = {
      path: new Set(),
      now: history ? historyNow : Date.now(),
      signal: controller.signal,
      nativeFormulaEngines: new Map(),
      usesClock: () => {
        if (!history && current()) setExternalClock(true);
      },
      observe: (doc) => {
        if (history || !current() || observed.has(doc)) return;
        const listener = () => {
          if (current()) setExternalRevision((value) => value + 1);
        };

        let release: (() => void) | undefined;
        const cleanup = () => {
          doc.off('update', listener);
          release?.();
        };

        observed.set(doc, cleanup);
        doc.on('update', listener);
        try {
          if (metadataDocuments.has(doc)) release = retainRollupSource(context, doc);
        } catch (error) {
          cleanup();
          observed.delete(doc);
          throw error;
        }

        if (!current()) {
          cleanup();
          observed.delete(doc);
        }
      },
    };
    const loadView = context.loadView;
    const createRow = context.createRow;
    const loaders: typeof context = {
      ...context,
      loadView: loadView
        ? async (...args) => {
            checkCurrent();
            const doc = await loadView(...args);

            checkCurrent();
            if (doc) {
              // Metadata-only snapshots need sync before cold hydration;
              // identify them by the loader, rather than their current payload.
              metadataDocuments.add(doc);
              resources.observe?.(doc);
            }

            return doc;
          }
        : undefined,
      createRow: createRow
        ? async (...args) => {
            checkCurrent();
            const doc = await createRow(...args);

            checkCurrent();
            return doc;
          }
        : undefined,
    };
    const publish = (outcome: NativeFormulaOutcome) => {
      if (current()) setSnapshot({ expression, rowId, outcome });
    };

    publish({ status: 'pending', resultType: 'any' });
    const timer = setTimeout(async () => {
      if (!valid || !row) return;
      const database = context.databaseDoc.getMap(E.data_section).get(E.database) as YDatabase;
      const field = database.get(K.fields)?.get(fieldId);

      if (!field) return;
      try {
        const properties = nativeEditorProperties(schema).map((property) =>
          'Formula' in property && property.Formula.id === fieldId ? { Formula: { id: fieldId, expression } } : property
        );
        const engine = await session.synchronize(properties);

        if (!current()) return;
        const required = new Set(await engine.requiredInputs([fieldId]));

        if (!current()) return;
        const inputs = schema.filter((entry) => required.has(entry.id));
        const guarded = enterComputedCell(
          { baseDoc: context.databaseDoc, database, row, rowId, fieldId, rollupField: field },
          resources,
          true
        );
        const values = await resolveNativeRowInputs(
          {
            database,
            baseDoc: context.databaseDoc,
            row,
            rowId,
            history,
            rows: context.rowMap ?? undefined,
            loaders,
          },
          inputs,
          guarded,
          evaluateRollupCell
        );

        if (!current()) return;
        const result = await engine.evaluate({
          row_ids: [rowId],
          formula_ids: [fieldId],
          columns: nativeBatchColumns(schema, [values]),
          runtime: formulaHostRuntime(resources.now),
        });

        if (!current()) return;
        const output = result.formulas.get(fieldId);

        publish(
          output && 'Ok' in output
            ? nativeOutputOutcome(output.Ok, 0)
            : { status: 'not-ready', resultType: 'any', error: 'Formula is not ready' }
        );
      } catch (error) {
        publish({
          status: 'error',
          resultType: 'any',
          error: error instanceof Error ? error.message : 'Formula preview failed',
          source: 'host',
        });
      } finally {
        releaseComputedFormulaEngines(resources);
      }
    }, 120);

    return () => {
      controller.abort();
      clearTimeout(timer);
      observed.forEach((cleanup) => cleanup());
      observed.clear();
      releaseComputedFormulaEngines(resources);
    };
  }, [
    session,
    context,
    history,
    historyNow,
    expression,
    schema,
    row,
    rowId,
    valid,
    rowRevision,
    externalRevision,
    clock,
    fieldId,
  ]);

  const field = schema.find((entry) => entry.id === fieldId)?.field;

  return snapshot?.expression === expression && snapshot.rowId === rowId && field
    ? projectNativeFormulaResult(snapshot.outcome, field)
    : undefined;
}
