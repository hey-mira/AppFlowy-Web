import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { hasRowConditionData } from '@/application/database-yjs/condition-value-cache';
import { DatabaseContextState, useDatabaseContext } from '@/application/database-yjs/context';
import { FieldType } from '@/application/database-yjs/database.type';
import { FormulaFieldSchema, readFormulaSchema } from '@/application/database-yjs/fields/formula/schema';
import { subscribeFormulaClock } from '@/application/database-yjs/formula/clock';
import { isDatabaseHistoryDocumentImmutable } from '@/application/database-yjs/immutable';
import {
  getDatabaseDependencyRestoreRevision,
  useDatabaseDependencyRestoreRevision,
} from '@/application/database-yjs/restore-dependencies';
import { evaluateRollupCell } from '@/application/database-yjs/rollup/cache';
import {
  ComputedDependencyError,
  ComputedSession,
  enterComputedCell,
  releaseComputedFormulaEngines,
} from '@/application/database-yjs/rollup/computed';
import {
  YDatabase,
  YDatabaseRow,
  YDoc,
  YjsDatabaseKey as K,
  YjsEditorKey as E,
} from '@/application/types';

import { NativeFormulaEngineLease, retainNativeFormulaEngine } from './native-engine';
import {
  formulaHostRuntime,
  formulaSchemaUsesClock,
  nativeBatchColumns,
  nativeFormulaStates,
  resolveNativeRowInputs,
} from './native-session';
import {
  NativeFormulaOutcome,
  nativeOutputOutcome,
  nativePropertyDefinition,
  nativePropertyType,
  readNativeInput,
  rememberNativeFormulaPropertyState,
} from './native-values';

export { getNativeFormulaPropertyState } from './native-values';

import type { FormulaEngineClient, PropertyState, Value } from '@notion-formula/sdk';

export interface NativeFormulaSnapshot {
  revision: number;
  phase: 'pending' | 'ready' | 'error';
  properties: ReadonlyMap<string, PropertyState>;
  outcomes: ReadonlyMap<string, ReadonlyMap<string, NativeFormulaOutcome>>;
  error?: string;
}

const emptySnapshot: NativeFormulaSnapshot = {
  revision: 0,
  phase: 'pending',
  properties: new Map(),
  outcomes: new Map(),
};
const noSubscription = () => () => undefined;
const disabledSnapshot = () => emptySnapshot;
const runtimes = new WeakMap<YDoc, Map<string, NativeFormulaRuntime>>();

export function nativeFormulaOutcome(
  snapshot: NativeFormulaSnapshot,
  rowId: string,
  fieldId: string
): NativeFormulaOutcome {
  const resultType = nativePropertyType(snapshot.properties.get(fieldId));

  if (snapshot.phase === 'error')
    return { status: 'error', resultType, error: snapshot.error ?? 'Formula worker failed', source: 'worker' };
  return snapshot.outcomes.get(rowId)?.get(fieldId) ?? { status: 'pending', resultType };
}

type RuntimeOwner = { context: DatabaseContextState; rows?: Record<string, YDoc>; formulaIds: string[] };
type InputState =
  | { status: 'pending' }
  | { status: 'ready'; value: Value | null }
  | { status: 'error'; error: string; source: 'host' | 'host-cycle' };
type CompiledSchema = {
  signature: string;
  engine: FormulaEngineClient;
  properties: Map<string, PropertyState>;
  dependencies: Map<string, string[]>;
};
type InputEpoch = {
  revision: number;
  generation: number;
  controller: AbortController;
  resources: ComputedSession;
  inputs: Map<string, Map<string, InputState>>;
  outcomes: Map<string, Map<string, NativeFormulaOutcome>>;
  retired: boolean;
};

/** One scheduled batch per database, independent of React's mounted row count. */
class NativeFormulaRuntime {
  private owners = new Map<object, RuntimeOwner>();
  private listeners = new Set<() => void>();
  private rowDocs = new Map<string, YDoc>();
  private observedDocs = new Map<YDoc, () => void>();
  private externalDocs = new Map<YDoc, () => void>();
  private targets: string[] = [];
  private snapshot = emptySnapshot;
  private revision = 0;
  private generation = 0;
  private scheduled = false;
  private running = false;
  private dirty = false;
  private lease?: NativeFormulaEngineLease;
  private compiled?: CompiledSchema;
  private epoch?: InputEpoch;
  private releaseClock?: () => void;
  private clockRequired = false;
  private peopleRequired = false;
  private lastPeopleTick = 0;
  private readonly history: boolean;
  private readonly historyNow = Date.now();
  private restoreRevision = getDatabaseDependencyRestoreRevision();

  constructor(private readonly databaseDoc: YDoc, private readonly contextKey: string) {
    this.history = contextKey !== 'live';
  }

  getSnapshot = () => this.snapshot;
  subscribe = (notify: () => void) => {
    this.listeners.add(notify);
    return () => {
      this.listeners.delete(notify);
    };
  };

  refreshRestoredSources(revision: number) {
    if (this.history || revision === this.restoreRevision) return;
    this.restoreRevision = revision;
    this.externalDocs.forEach((listener, doc) => doc.off('update', listener));
    this.externalDocs.clear();
    this.invalidate();
  }

  retain(owner: object, source: RuntimeOwner) {
    const first = this.owners.size === 0;

    this.owners.set(owner, source);
    if (first) {
      this.generation += 1;
      this.lease = retainNativeFormulaEngine(this.databaseDoc, this.contextKey);
      if (!this.history) this.databaseDoc.on('update', this.onSchemaChange);
      this.databaseDoc.on('destroy', this.dispose);
    }

    this.syncRows();
    if (first) this.invalidate(true);
    return () => {
      this.owners.delete(owner);
      if (this.owners.size === 0) this.dispose();
      else this.syncRows();
    };
  }

  private onSchemaChange = () => this.invalidate(true);

  private syncRows() {
    const next = new Map<string, YDoc>();
    const formulaIds = new Set<string>();

    for (const source of this.owners.values()) {
      for (const [id, doc] of Object.entries(source.rows ?? {}))
        if (hasRowConditionData(doc) || !next.has(id)) next.set(id, doc);
      source.formulaIds.forEach((id) => formulaIds.add(id));
    }

    // Live rows supersede immutable background seeds once their content loads.
    const rowMaps = new Set(Array.from(this.owners.values(), (source) => source.context.rowMap));

    for (const rowMap of rowMaps) {
      for (const [id, doc] of Object.entries(rowMap ?? {}))
        if (hasRowConditionData(doc) || !next.has(id)) next.set(id, doc);
    }

    let changed = next.size !== this.rowDocs.size;

    for (const [id, doc] of next) if (this.rowDocs.get(id) !== doc) changed = true;
    this.rowDocs = next;
    const targets = Array.from(formulaIds).sort();

    if (targets.join('\0') !== this.targets.join('\0')) changed = true;
    this.targets = targets;
    if (!this.history) {
      const docs = new Set(next.values());

      for (const [doc, listener] of this.observedDocs) {
        if (!docs.has(doc)) {
          doc.off('update', listener);
          this.observedDocs.delete(doc);
        }
      }

      for (const doc of docs) {
        if (this.observedDocs.has(doc)) continue;
        const listener = () => this.invalidate();

        doc.on('update', listener);
        this.observedDocs.set(doc, listener);
      }
    }

    if (changed) this.invalidate();
  }

  private publish(snapshot: NativeFormulaSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((notify) => notify());
  }

  private invalidate(schema = false) {
    if (this.owners.size === 0) return;
    this.revision += 1;
    this.retireEpoch();
    if (schema) {
      const database = this.databaseDoc.getMap(E.data_section).get(E.database) as YDatabase | undefined;

      database?.get(K.fields)?.forEach((field) => rememberNativeFormulaPropertyState(field));
    }

    this.publish({
      revision: this.revision,
      phase: 'pending',
      properties: schema ? new Map() : this.snapshot.properties,
      outcomes: new Map(),
    });
    this.schedule();
  }

  private schedule() {
    this.dirty = true;
    if (this.scheduled || this.running || this.owners.size === 0) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.owners.size > 0 && !this.running) void this.run();
    });
  }

  private retireEpoch() {
    if (!this.epoch) return;
    this.epoch.retired = true;
    this.epoch.controller.abort();
    releaseComputedFormulaEngines(this.epoch.resources);
    this.epoch = undefined;
    this.externalDocs.forEach((listener, doc) => doc.off('update', listener));
    this.externalDocs.clear();
  }

  private syncClock() {
    if (this.history || (!this.clockRequired && !this.peopleRequired)) {
      this.releaseClock?.();
      this.releaseClock = undefined;
      return;
    }

    if (this.releaseClock) return;
    this.releaseClock = subscribeFormulaClock(() => {
      const now = Date.now();

      if (this.clockRequired || (this.peopleRequired && now - this.lastPeopleTick >= 30_000)) {
        this.lastPeopleTick = now;
        this.invalidate();
      }
    });
  }

  private startEpoch(
    database: YDatabase,
    schema: FormulaFieldSchema[],
    compiled: CompiledSchema,
    targets: string[],
    readyTargets: string[],
    owner: RuntimeOwner
  ): InputEpoch {
    const controller = new AbortController();
    const resources: ComputedSession = {
      path: new Set(),
      now: this.history ? this.historyNow : Date.now(),
      signal: controller.signal,
      nativeFormulaEngines: new Map(),
      usesClock: () => {
        if (current()) {
          this.clockRequired = true;
          this.syncClock();
        }
      },
      usesPeople: () => {
        if (current()) {
          this.peopleRequired = true;
          this.syncClock();
        }
      },
    };
    const epoch: InputEpoch = {
      revision: this.revision,
      generation: this.generation,
      controller,
      resources,
      inputs: new Map(),
      outcomes: new Map(),
      retired: false,
    };
    const current = () => this.epoch === epoch && !epoch.retired && this.owners.size > 0;
    const required = new Set(readyTargets.flatMap((id) => compiled.dependencies.get(id)!));
    const inputs = schema.filter((entry) => required.has(entry.id));
    const rowSources = Object.fromEntries(this.rowDocs);
    const observe = (doc: YDoc) => {
      if (
        this.history ||
        !current() ||
        doc === this.databaseDoc ||
        this.observedDocs.has(doc) ||
        this.externalDocs.has(doc)
      )
        return;
      const listener = () => this.invalidate();

      doc.on('update', listener);
      this.externalDocs.set(doc, listener);
    };

    const failure = (error: unknown): InputState => ({
      status: 'error',
      error: error instanceof Error ? error.message : 'Formula input could not be loaded',
      source: error instanceof ComputedDependencyError ? 'host-cycle' : 'host',
    });

    this.epoch = epoch;
    this.clockRequired = formulaSchemaUsesClock(schema);
    this.peopleRequired = inputs.some((entry) =>
      [FieldType.Person, FieldType.CreatedBy, FieldType.LastEditedBy].includes(entry.type)
    );
    this.syncClock();
    for (const [rowId, doc] of this.rowDocs) {
      const results = new Map<string, NativeFormulaOutcome>();
      const rowInputs = new Map<string, InputState>();
      const row = doc.getMap(E.data_section).get(E.database_row) as YDatabaseRow | undefined;

      epoch.outcomes.set(rowId, results);
      for (const id of targets) {
        const state = compiled.properties.get(id)!;

        results.set(
          id,
          'Formula' in state && state.Formula.status === 'NotReady'
            ? {
                status: 'not-ready',
                resultType: 'any',
                error: 'Formula is not ready: check its property references, types and dependencies',
              }
            : { status: 'pending', resultType: nativePropertyType(state) }
        );
      }

      if (!row) continue;
      epoch.inputs.set(rowId, rowInputs);
      for (const entry of inputs) {
        const external = [
          FieldType.Relation,
          FieldType.Rollup,
          FieldType.Person,
          FieldType.CreatedBy,
          FieldType.LastEditedBy,
        ].includes(entry.type);

        if (!external) {
          try {
            rowInputs.set(entry.id, { status: 'ready', value: readNativeInput(entry, row, {}) });
          } catch (error) {
            rowInputs.set(entry.id, failure(error));
          }

          continue;
        }

        rowInputs.set(entry.id, { status: 'pending' });
        let session: ComputedSession = { ...resources, observe };

        try {
          // Only paths whose native closure contains this Input can be involved
          // in its host cycle. Independent formula targets never enter the path.
          for (const id of readyTargets) {
            if (!compiled.dependencies.get(id)!.includes(entry.id)) continue;
            session = enterComputedCell(
              {
                baseDoc: this.databaseDoc,
                database,
                row,
                rowId,
                fieldId: id,
                rollupField: database.get(K.fields).get(id),
              },
              session,
              true
            );
          }
        } catch (error) {
          rowInputs.set(entry.id, failure(error));
          continue;
        }

        // One read per row/Input is shared by all selected target closures. These
        // promises never block the native batch for independent Ready targets.
        void resolveNativeRowInputs(
          {
            database,
            baseDoc: this.databaseDoc,
            row,
            rowId,
            history: this.history,
            rows: rowSources,
            loaders: owner.context,
          },
          [entry],
          session,
          evaluateRollupCell
        )
          .then(
            (values) => {
              if (current()) rowInputs.set(entry.id, { status: 'ready', value: values.get(entry.id) ?? null });
            },
            (error) => {
              if (current()) rowInputs.set(entry.id, failure(error));
            }
          )
          .finally(() => {
            if (current()) this.schedule();
            else releaseComputedFormulaEngines(resources);
          });
      }
    }

    return epoch;
  }

  private async run() {
    const revision = this.revision;
    const generation = this.generation;
    const current = () => this.owners.size > 0 && revision === this.revision && generation === this.generation;
    const owner = this.owners.values().next().value as RuntimeOwner | undefined;
    const lease = this.lease;

    if (!owner || !lease) return;
    this.running = true;
    this.dirty = false;
    try {
      const database = this.databaseDoc.getMap(E.data_section).get(E.database) as YDatabase | undefined;

      if (!database) return;
      const schema = readFormulaSchema(database.get(K.fields));
      const definitions = schema.map(nativePropertyDefinition);
      const signature = JSON.stringify(definitions);
      let compiled = this.compiled;

      if (!compiled || compiled.signature !== signature) {
        const engine = await lease.synchronize({ properties: definitions });

        if (!current()) return;
        const properties = nativeFormulaStates(await engine.getProperties());

        if (!current()) return;
        compiled = { signature, engine, properties, dependencies: new Map() };
        this.compiled = compiled;
      }

      const { engine, properties, dependencies } = compiled;

      schema.forEach((entry) => {
        const state = properties.get(entry.id);

        rememberNativeFormulaPropertyState(entry.field, state);
      });
      const targets = this.targets.filter((id) => properties.get(id) && 'Formula' in properties.get(id)!);
      const readyTargets = targets.filter((id) => {
        const state = properties.get(id)!;

        return 'Formula' in state && state.Formula.status !== 'NotReady';
      });

      // NotReady references are incomplete. Only Ready selections prove which
      // external Inputs are unused and safe to supply as typed null columns.
      for (const id of readyTargets) {
        if (dependencies.has(id)) continue;
        const required = await engine.requiredInputs([id]);

        if (!current()) return;
        dependencies.set(id, required);
      }

      const epoch = this.epoch ?? this.startEpoch(database, schema, compiled, targets, readyTargets, owner);
      const groups = new Map<
        string,
        { targets: string[]; rows: Array<{ rowId: string; values: Map<string, Value | null> }> }
      >();

      for (const [rowId, rowInputs] of epoch.inputs) {
        const executable: string[] = [];
        const results = epoch.outcomes.get(rowId)!;

        for (const id of readyTargets) {
          if (results.get(id)?.status !== 'pending') continue;
          const required = dependencies.get(id)!;
          const states = required.map((inputId) => rowInputs.get(inputId));
          const error = states.find((state) => state?.status === 'error');

          if (error?.status === 'error') {
            results.set(id, {
              status: 'error',
              resultType: nativePropertyType(properties.get(id)),
              error: error.error,
              source: error.source,
            });
          } else if (states.every((state) => state?.status === 'ready')) executable.push(id);
        }

        if (executable.length === 0) continue;
        const key = executable.join('\0');
        let group = groups.get(key);

        if (!group) {
          group = { targets: executable, rows: [] };
          groups.set(key, group);
        }

        const values = new Map<string, Value | null>();

        for (const id of executable) {
          for (const inputId of dependencies.get(id)!) {
            const state = rowInputs.get(inputId)!;

            if (state.status === 'ready') values.set(inputId, state.value);
          }
        }

        group.rows.push({ rowId, values });
      }

      for (const group of groups.values()) {
        const result = await engine.evaluate({
          row_ids: group.rows.map((row) => row.rowId),
          formula_ids: group.targets,
          columns: nativeBatchColumns(
            schema,
            group.rows.map((row) => row.values)
          ),
          runtime: formulaHostRuntime(epoch.resources.now),
        });

        if (!current()) return;
        for (const id of group.targets) {
          const output = result.formulas.get(id);

          group.rows.forEach(({ rowId }, index) =>
            epoch.outcomes
              .get(rowId)!
              .set(
                id,
                output && 'Ok' in output
                  ? nativeOutputOutcome(output.Ok, index)
                  : { status: 'not-ready', resultType: 'any', error: 'Formula is not ready' }
              )
          );
        }
      }

      // Publish copies: async Input completions mutate the private epoch only.
      // A snapshot can contain pending targets and settled independent results.
      this.publish({
        revision,
        phase: 'ready',
        properties,
        outcomes: new Map(Array.from(epoch.outcomes, ([id, results]) => [id, new Map(results)])),
      });
    } catch (error) {
      if (current()) {
        this.retireEpoch();
        this.publish({
          revision,
          phase: 'error',
          properties: this.snapshot.properties,
          outcomes: new Map(),
          error: error instanceof Error ? error.message : 'Formula worker failed',
        });
      }
    } finally {
      this.running = false;
      if (this.owners.size > 0 && (this.dirty || revision !== this.revision || generation !== this.generation))
        this.schedule();
    }
  }

  private dispose = () => {
    this.generation += 1;
    this.retireEpoch();
    this.databaseDoc.off('update', this.onSchemaChange);
    this.databaseDoc.off('destroy', this.dispose);
    this.observedDocs.forEach((listener, doc) => doc.off('update', listener));
    this.externalDocs.forEach((listener, doc) => doc.off('update', listener));
    this.observedDocs.clear();
    this.externalDocs.clear();
    this.releaseClock?.();
    this.releaseClock = undefined;
    this.lease?.release();
    this.lease = undefined;
    this.compiled = undefined;
    this.rowDocs.clear();
    this.targets = [];
    this.snapshot = emptySnapshot;
  };
}

function getRuntime(doc: YDoc, key: string) {
  let contexts = runtimes.get(doc);

  if (!contexts) {
    contexts = new Map();
    runtimes.set(doc, contexts);
  }

  let runtime = contexts.get(key);

  if (!runtime) {
    runtime = new NativeFormulaRuntime(doc, key);
    contexts.set(key, runtime);
  }

  return runtime;
}

/** Rendering only reads snapshots; effects retain row sources and schedule work. */
export function useNativeFormulaRuntime({
  enabled = true,
  rows,
  formulaIds = [],
  context: suppliedContext,
}: {
  enabled?: boolean;
  rows?: Record<string, YDoc>;
  formulaIds?: readonly string[];
  /** Settings retain the same related-database session without mounting its rows. */
  context?: DatabaseContextState;
} = {}): NativeFormulaSnapshot {
  const currentContext = useDatabaseContext();
  const context = suppliedContext ?? currentContext;
  const { databaseDoc, dataSource, rowMap, workspaceId, loadView, createRow, getViewIdFromDatabaseId } = context;
  const key =
    dataSource?.type === 'history'
      ? `history:${dataSource.id}`
      : isDatabaseHistoryDocumentImmutable(databaseDoc)
      ? 'history'
      : 'live';
  const runtime = useMemo(() => getRuntime(databaseDoc, key), [databaseDoc, key]);
  const restoreRevision = useDatabaseDependencyRestoreRevision(enabled && key === 'live');
  const owner = useMemo(() => ({}), []);
  const targetKey = formulaIds.join('\0');

  useEffect(() => {
    if (!enabled) return;
    return runtime.retain(owner, { context, rows, formulaIds: targetKey ? targetKey.split('\0') : [] });
    // Only host inputs that affect evaluation should replace an owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    runtime,
    owner,
    enabled,
    rows,
    targetKey,
    databaseDoc,
    rowMap,
    workspaceId,
    loadView,
    createRow,
    getViewIdFromDatabaseId,
  ]);

  useEffect(() => {
    if (enabled && key === 'live') runtime.refreshRestoredSources(restoreRevision);
  }, [enabled, key, runtime, restoreRevision]);

  return useSyncExternalStore(
    enabled ? runtime.subscribe : noSubscription,
    enabled ? runtime.getSnapshot : disabledSnapshot,
    disabledSnapshot
  );
}
